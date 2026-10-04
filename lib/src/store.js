// SRC durable store implementation. Dependencies are injected by the composition root.
import { inMutation, serializeMutation, captureRows, changedRows } from './committed-state.js';
import { createHash, randomUUID } from 'node:crypto';
import { KNOWLEDGE_TABLES, isSuperseded } from './knowledge-revisions.js';
import { verifyArtifacts } from './artifact-manifest.js';
import {findingFingerprint} from './verification.js';
import { makeManifest, computeCoverage } from './endpoint-manifest.js';
// Shared domain, multiple preset/store instances: serialize observation ID allocation + put.
const observationWrites = new WeakMap();
const domainOwners = new WeakMap();
const closingDomains = new WeakSet();
async function serializeObservation(domain, sessionId, write) {
	let pending = observationWrites.get(domain);
	if (!pending) observationWrites.set(domain, pending = new Map());
	const previous = pending.get(sessionId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(write);
	pending.set(sessionId, next);
	try { return await next; }
	finally { if (pending.get(sessionId) === next) pending.delete(sessionId); }
}

export function createSrcStore(dependencies) {
	const { appendSessionToolEvent, srcDomainSpec, sharedDomainOpens, LEGACY_KEY_MIGRATION_TABLES, recordKey, TABLE_OF_ID_KIND, snapshot, SCHEMA_OF_KIND, closeProofServersOfSession, assetGrantHosts, SEVERITIES, SRC_INFRA_DEFAULTS, SRC_INFRA_KEYS, SRC_AUTH_REQUEST_BUDGET, routePlaybook, credentialHeaders, describeHttpBody, srcEventRecorder } = dependencies;
	class SrcStore {
	ctx;
	domainPromise;
	/** [local.23] Per-session authenticated-request counters (in-memory; restart resets, which is fine — budgets are advisory soft signals). */
	authRequestCounts = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** [local.77 §10] 领域写入先 append 事件旁账，再由既有路径更新快照（§10.1 步骤 2）。
	 *  recorder 内部处理 flag=off no-op 与幂等键去重；append 失败只 warn 不阻塞工具路径（telemetry 红线同款）。 */
	async appendEvent(event) {
		if (srcEventRecorder === void 0) return;
		try {
			if (event.eventType.endsWith('.upserted') || event.eventType.endsWith('.resolved')) {
				const prior=[...(await this.domain()).table('src_events').entries()].map(([,row])=>row).filter(row=>row.sessionId===event.sessionId&&row.aggregateId===event.aggregateId);
				event={...event,aggregateVersion:Math.max(0,...prior.map(row=>row.aggregateVersion??0))+1};
			}
			const result = await srcEventRecorder.appendEvent(this.domain(), { ...event, payload: { ...event.payload, sessionId: event.payload?.sessionId ?? event.sessionId } });
			if (result?.duplicate === true) console.warn(`[dsh-src] src_events duplicate key suppressed: ${event.aggregateId}:${event.aggregateVersion}:${event.eventType}`);
		} catch (error) {
			console.warn(`[dsh-src] src_events append failed (non-blocking): ${String(error?.message ?? error)}`);
		}
	}
	/** Resolve the opened domain, opening it lazily on first use. */
	domain() {
		if (this.domainPromise === void 0) {
			const key = srcDomainSpec.name;
			const cached = sharedDomainOpens.get(key);
			if (cached !== void 0) {
                if(closingDomains.has(cached))return Promise.reject(new Error('SRC_DOMAIN_CLOSING'));
				try { console.warn(`[dsh-src] domain '${key}' already open elsewhere — reusing the shared open promise to avoid double-open.`); } catch {}
				this.domainPromise = cached;
			} else {
				const p = this.ctx.storageDomain.open(srcDomainSpec).then(async (domain) => {
					await this.migrateLegacyKeys(domain);
					return domain;
				});
				sharedDomainOpens.set(key, p);
				// [local.45] 打开失败后必须同时解除两层缓存（共享表 + 实例句柄），
				// 否则 rejected promise 被 domain() 永久重放——盘上数据修复也无法生效，
				// 只能重启进程。facility 的 open 失败路径会清 reserved 并关 unit，重试安全。
				p.catch(() => {
					if (sharedDomainOpens.get(key) === p) sharedDomainOpens.delete(key);
					if (this.domainPromise === p) this.domainPromise = void 0;
				});
				this.domainPromise = p;
			}
            const owned=this.domainPromise;
            domainOwners.set(owned,(domainOwners.get(owned)??0)+1);
            owned.catch(()=>{if(this.domainPromise===owned)this.domainPromise=void 0;});
		}
		return this.domainPromise;
	}
	/** Move legacy global-id rows to the session-scoped key format once. */
	async migrateLegacyKeys(domain) {
		for (const name of LEGACY_KEY_MIGRATION_TABLES) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) {
				const record = row;
				const scopedKey = recordKey(record.sessionId, record.id);
				if (key === scopedKey) continue;
				if (table.get(scopedKey) === void 0) await table.put(scopedKey, row);
				await table.delete(key);
			}
		}
	}
	/** Close the domain and release its backend unit (idempotent). */
	async dispose() {
		const pending = this.domainPromise;
		if (pending !== void 0) {
			this.domainPromise = void 0;
            const remaining=(domainOwners.get(pending)??1)-1;
            if(remaining>0){domainOwners.set(pending,remaining);return;}
            domainOwners.delete(pending);closingDomains.add(pending);
            try {await (await pending).close();}
            finally {if(sharedDomainOpens.get(srcDomainSpec.name)===pending)sharedDomainOpens.delete(srcDomainSpec.name);closingDomains.delete(pending);}
		}
	}
	/** Read one session's goal row, if present. */
	async getGoal(sessionId) {
		return (await this.domain()).table("goals").get(sessionId);
	}
	/** Read the goal row, failing with a guiding error when absent. */
	async requireGoal(sessionId) {
		const goal = await this.getGoal(sessionId);
		if (goal === void 0) throw new Error("src engagement is not initialized; call src_add_goal with target and objective first");
		return goal;
	}
	/** The next deterministic id for one kind in one session (max existing seq + 1). */
	async nextId(kind, sessionId) {
		const table = (await this.domain()).table(TABLE_OF_ID_KIND[kind]);
		let max = 0;
		for (const [, row] of table.entries()) {
			if (row.sessionId !== sessionId) continue;
			const match = /-(\d+)$/.exec(row.id);
			/* v8 ignore next 1 -- unreachable: every row this store writes carries the `<kind>-<n>` id pattern. */
			if (match !== null) max = Math.max(max, Number(match[1]));
		}
		return `${kind}-${max + 1}`;
	}
	/** Delete every exploration row of one session (goal reset). */
	async clearSession(sessionId) {
		const domain = await this.domain();
		for (const name of [
			"goals",
			"intents",
			"facts",
			"findings",
			"assets",
			"coverage",
			"endpoint_manifests",
			"research",
			"checkpoints",
			"edges"
		]) {
			const table = domain.table(name);
			for (const [key, row] of table.entries()) if (row.sessionId === sessionId) await table.delete(key);
		}
	}
	/**
	* Create or reset the engagement goal. A new goal clears the whole
	* exploration graph of the session and restarts fresh counters.
	*/
	async initGoal(sessionId, input) {
		/* [local.16] A fresh goal means the previous engagement ended: stop its live POC servers. */
		await closeProofServersOfSession(sessionId);
		await this.clearSession(sessionId);
		const goal = snapshot({
			id: "goal-1",
			sessionId,
			target: input.target,
			objective: input.objective,
			authorization: input.authorization,
			...(input.scopeOrigin?{scopeOrigin:input.scopeOrigin}:{})
		});
		await (await this.domain()).table("goals").put(sessionId, goal);
		return goal;
	}
	/** Validate a reference row (same session, expected table) or fail loud. */
	async requireRef(sessionId, tableName, refId, label) {
		const row = (await this.domain()).table(tableName).get(recordKey(sessionId, refId));
		if (row === void 0) throw new Error(`src: unknown ${label} ${refId}`);
		/* v8 ignore next -- session-scoped keys are normalized on domain open and the domain has one writer. */
		if (row.sessionId !== sessionId) throw new Error(`src: ${label} ${refId} belongs to another session`);
	}
	/** Mint one node (and its connecting edge) in one write. */
	async addNode(sessionId, edgeKind, sourceId, nodeKind, node) {
		await this.requireGoal(sessionId);
		const domain = await this.domain();
		const nodeId = await this.nextId(nodeKind, sessionId);
		const record = snapshot({
			id: nodeId,
			sessionId,
			...node
		});
		/* [local.17] 写入即按 domain schema 校验：sqlite 后端读取时同样校验，脏行落库会让该会话所有
		 * 读取全炸（真实事故：import_traffic 写入 kind=auth-profile 而 enum 没有它，面板/工具读取全灭）。 */
		SCHEMA_OF_KIND[nodeKind].parse(record);
		/* [local.77 §10] 先 append 事件旁账，再落快照（§10.1 步骤 2）。aggregateId 用本会话+id，
		 * version 用节点自身序号（id 尾号），eventType 六类之一。 */
		const seq = Number((/-(\d+)$/.exec(nodeId)?.[1]) ?? 0);
		await this.appendEvent({ sessionId, aggregateId: nodeId, aggregateVersion: seq, eventType: `${nodeKind}.appended`, payload: record });
		await domain.table(TABLE_OF_ID_KIND[nodeKind]).put(recordKey(sessionId, nodeId), record);
		if (edgeKind === void 0) return { nodeId };
		const edgeId = await this.nextId("edge", sessionId);
		const edge = snapshot({
			id: edgeId,
			sessionId,
			kind: edgeKind,
			sourceId,
			targetId: nodeId
		});
		const edgeSeq = Number((/-(\d+)$/.exec(edgeId)?.[1]) ?? 0);
		await this.appendEvent({ sessionId, aggregateId: edgeId, aggregateVersion: edgeSeq, eventType: "edge.appended", payload: edge });
		await domain.table("edges").put(recordKey(sessionId, edgeId), edge);
		return {
			nodeId,
			edge: {
				id: edgeId,
				kind: edgeKind,
				sourceId,
				targetId: nodeId
			}
		};
	}
	/** Record one intent spawned by the goal or derived from a fact. */
	async addIntent(sessionId, input) {
		if ((input.goalId !== void 0 ? 1 : 0) + (input.derivedFromFactId !== void 0 ? 1 : 0) !== 1) throw new Error("src_add_intent requires exactly one anchor: goalId (spawns) or derivedFromFactId (derived_from)");
		const existing = (await this.sessionData(sessionId)).intents.find((intent) => intent.title.trim().toLowerCase() === input.title.trim().toLowerCase() && intent.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		if (input.goalId !== void 0) {
			const goal = await this.requireGoal(sessionId);
			if (input.goalId !== goal.id) throw new Error(`src: unknown goal ${input.goalId}`);
			return this.addNode(sessionId, "spawns", input.goalId, "intent", {
				title: input.title,
				detail: input.detail,
				status: "planned",
				...(input.priority !== void 0 ? { priority: input.priority } : {}),
				...(input.delegationAdvice !== void 0 ? { delegationAdvice: input.delegationAdvice } : {}),
				delegationMode: input.delegationMode ?? "unknown",
				playbook: input.playbook ?? routePlaybook(input.title, input.detail)
			});
		}
		/* v8 ignore next 1 -- unreachable: anchors === 1 and the goalId branch returned, so the derived anchor is present. */
		const derivedFromFactId = input.derivedFromFactId ?? "";
		await this.requireRef(sessionId, "facts", derivedFromFactId, "fact");
		return this.addNode(sessionId, "derived_from", derivedFromFactId, "intent", {
			title: input.title,
			detail: input.detail,
			status: "planned",
			...(input.priority !== void 0 ? { priority: input.priority } : {}),
			...(input.delegationAdvice !== void 0 ? { delegationAdvice: input.delegationAdvice } : {}),
			delegationMode: input.delegationMode ?? "unknown",
			playbook: input.playbook ?? routePlaybook(input.title, input.detail)
		});
	}
	/** Update the lifecycle status of one intent. */
	async updateIntent(sessionId, intentId, status, priority = void 0, delegationMode = void 0, execution = {}) {
		await this.requireRef(sessionId, "intents", intentId, "intent");
		const table = (await this.domain()).table("intents");
		const key = recordKey(sessionId, intentId);
		const current = table.get(key);
		/* [local.42] status 与 priority 都可单独更新；snapshot 剥 undefined，未提供的字段保持原值。 */
		if (status === void 0 && priority === void 0 && delegationMode === void 0 && Object.keys(execution).length === 0) return { ...current };
		const patch = { ...execution, ...(status !== void 0 ? { status } : {}), ...(priority !== void 0 ? { priority } : {}), ...(delegationMode !== void 0 ? { delegationMode } : {}) };
		const record = snapshot({ ...current, ...patch });
		await this.appendEvent({ sessionId, aggregateId: intentId, aggregateVersion: Number((/-(\d+)$/.exec(intentId)?.[1]) ?? 0), eventType: "intent.upserted", payload: record });
		await table.put(key, record);
		/* [local.85] intent 收尾（completed/blocked/failed）自动落一条 coverage 行——覆盖对账的数据地基。
		   根因：此前 coverage 只有零散自动发射点（bypass/credential/dorks）+ 手动 src_record_coverage，真实会话两者都没触发 → u_src_coverage 0 记录，对账形同虚设。
		   收尾即登记：phase=intent，category=intent 标题（截断），blocked 带 limitation 指向 decision。 */
		if (status === "completed" || status === "blocked" || status === "failed") {
			const title = String(current?.title ?? intentId).slice(0, 80);
			const blockedLimitation = status === "completed" ? "" : String(current?.detail ?? "").slice(0, 200);
			try {
				const existing = [...(await this.domain()).table("coverage").entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.phase === "intent" && row.category === title);
				const covId = existing?.id ?? await this.nextId("coverage", sessionId);
				const covRecord = snapshot({ id: covId, sessionId, phase: "intent", category: title, status: status === "completed" ? "completed" : "blocked", evidence: [intentId], limitation: blockedLimitation, updatedAt: Date.now() });
				await (await this.domain()).table("coverage").put(recordKey(sessionId, covId), covRecord);
			} catch { /* 覆盖登记失败不阻塞 intent 收尾 */ }
		}
		return record;
	}
	/** Append one durable delegated-child progress checkpoint. */
	async addCheckpoint(sessionId, input) {
		const goal=await this.requireGoal(sessionId);
		if(input.artifactPaths?.length) input={...input,artifacts:await verifyArtifacts(sessionId,goal.target,input.artifactPaths)};
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("checkpoints");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.childSessionId === input.childSessionId && row.stage === input.stage && row.summary === input.summary && row.facts === input.facts && row.assets === input.assets && row.findings === input.findings && row.batchKey === input.batchKey);
		if (existing !== void 0) return { ...existing, duplicate: true };
		const checkpointId = await this.nextId("checkpoint", sessionId);
		const record = snapshot({ id: checkpointId, sessionId, ...input, createdAt: Date.now() });
		await this.appendEvent({ sessionId, aggregateId: checkpointId, aggregateVersion: Number((/-(\d+)$/.exec(checkpointId)?.[1]) ?? 0), eventType: "checkpoint.appended", payload: record });
		await table.put(recordKey(sessionId, checkpointId), record);
		const status = input.stage === "completed" ? "completed" : input.stage === "blocked" ? "blocked" : input.stage === "failed" ? "failed" : "running";
		await this.updateIntent(sessionId, input.intentId, status, void 0, "delegate", { childSessionId: input.childSessionId, executionSource: "child-checkpoint" });
		return record;
	}
	/** Record one fact yielded by an intent. */
	async addFact(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		/* [local.17] 写入即校验：sqlite 后端读取时按 domain schema 严格校验，非法 kind 落库会让整个会话的
		 * facts 读取全炸（真实事故：auth-profile 不在 enum，import_traffic 写入成功、面板读取全灭）。 */
		const existing = (await this.sessionData(sessionId)).facts.find((fact) => fact.intentId === input.intentId && fact.kind === input.kind && fact.target.trim().toLowerCase() === input.target.trim().toLowerCase() && fact.detail.trim().toLowerCase() === input.detail.trim().toLowerCase());
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "yields", input.intentId, "fact", {
			intentId: input.intentId,
			kind: input.kind,
			target: input.target,
			detail: input.detail,
			confidence: input.confidence
		});
	}
	/** Record one finding proved by an intent (with reproducible steps). */
	async addFinding(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.reproducibleSteps.length === 0) throw new Error("src_add_finding requires at least one reproducible step");
		if (input.impact === "" || input.affectedScope === "" || input.remediation === "" || input.pocEvidence.length === 0) throw new Error("src_add_finding requires impact, affectedScope, remediation, and pocEvidence");
		/* [local.25→local.67 #11b] finding 准入闸放宽：未授权可达+可复现 PoC 即入库，severity 如实标 low 起评。
		 * 危害链三要素（victimImpact/attackPrerequisites/concreteLossEvidence）降级为「升危依据」：
		 * medium 及以上必须三要素齐备；low 可缺省（提供了仍校验存在性）。依据：对照报告 16 条全是
		 * 「未授权可达」级、无一有实际损失实锤，但正是 SRC 可提交粒度；顺丰 7+ 端点停在 fact 态的直接原因
		 * 就是本闸把「未授权可达」挡在入库外。宁可多收窄进（UI 可筛），不可漏交。 */
		if (input.severity === "info") throw new Error("src_add_finding 准入拒绝：severity=info 已移除——仅配置缺陷、响应头反射而无敏感数据返回证明的是研究信号不是漏洞；改记 src_record_research(status=false-positive，hypothesis 写明缺什么证明) 或建 src_user_todo 待人工复核，不要塞进漏洞清单");
		if (!SEVERITIES.includes(input.severity)) throw new Error(`src_add_finding severity 必须是 ${SEVERITIES.join("/")} 之一`);
		const ROUTE_HINT = "危害链三要素（攻击者能力 impact / 受害者交互 victimImpact / 实际损失证据 concreteLossEvidence）是 medium 及以上的准入条件、low 的升危依据（组合出实际损失证据时升 medium+）；无 PoC 可复现的纯弱信号仍走 research 或待办，不是漏洞清单";
		const wantsChain = input.severity !== "low";
		if (wantsChain && (input.victimImpact ?? "").trim().length < 10) throw new Error(`src_add_finding 准入拒绝：medium 及以上需受害者视角（victimImpact）——谁受害、损失什么、是否可察觉；未授权可达类请如实标 low 入库。${ROUTE_HINT}`);
		const prerequisites = (input.attackPrerequisites ?? "").trim();
		if (wantsChain && prerequisites.length < 10) throw new Error(`src_add_finding 准入拒绝：medium 及以上需利用前提（attackPrerequisites）——钓鱼托管域要求（厂商自有域？）、需登录哪个业务、需要的用户交互；前提写不清通常说明危害链未闭合；未授权可达类请如实标 low 入库。${ROUTE_HINT}`);
		const lossRefs = Array.isArray(input.concreteLossEvidence) ? input.concreteLossEvidence.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
		if (wantsChain && lossRefs.length === 0) throw new Error(`src_add_finding 准入拒绝：medium 及以上需实际损失证据指针（concreteLossEvidence）——至少一条指向真实 fact/observation/research 的 id（含敏感响应体或外带记录）；仅请求头/响应头变化的证据不算实际损失；未授权可达类请如实标 low 入库。${ROUTE_HINT}`);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.affectedAssetId !== void 0) await this.requireRef(sessionId, "assets", input.affectedAssetId, "asset");
		const sessionNodes = await this.sessionData(sessionId);
		const lossRefExists = (id) => sessionNodes.facts.some((n) => n.id === id) || sessionNodes.findings.some((n) => n.id === id) || sessionNodes.research.some((r) => r.id === id) || sessionNodes.observations.some((o) => o.id === id);
		const badRefs = [];
		for (const ref of lossRefs) if (!lossRefExists(ref)) badRefs.push(ref);
		if (badRefs.length > 0) throw new Error(`src_add_finding 准入拒绝：concreteLossEvidence 含不可解析的 id：${badRefs.join(", ")}——必须指向本会话真实存在的 fact/observation/research id。${ROUTE_HINT}`);
		/* [local.26] 防二次提交：与已打回的 finding 相似（同 intent+归一化标题前缀）→ 拒绝并回带打回理由。
	 * 须在 exact-duplicate 判定之前，否则同 title 重提会走 duplicate:true 不报错。 */
		const intent = sessionNodes.intents.find((row) => row.id === input.intentId);
		const titleNorm = input.title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 24);
		const similarRejected = sessionNodes.findings.find((finding) => (finding.status ?? "active") === "rejected" && finding.intentId === input.intentId && titleNorm !== "" && finding.title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 24) === titleNorm);
		if (similarRejected !== void 0) throw new Error(`src_add_finding 准入拒绝：此漏洞与已打回的 ${similarRejected.id}「${similarRejected.title}」相似，不要二次提交。打回理由：${similarRejected.rejectReason || "（未填）"}。如确为新链或已补全，先用 src_update_finding 补写攻击链再说明与打回那条的差异，不要原样重提。`);
		const existing = sessionNodes.findings.find((finding) => finding.title.trim().toLowerCase() === input.title.trim().toLowerCase() && (finding.affectedAssetId ?? "") === (input.affectedAssetId ?? ""));
		if (existing !== void 0) return { nodeId: existing.id, duplicate: true };
		return this.addNode(sessionId, "proves", input.intentId, "finding", {
			intentId: input.intentId,
			title: input.title,
			severity: input.severity,
			description: input.description,
			impact: input.impact,
			victimImpact: input.victimImpact ?? "",
			attackPrerequisites: input.attackPrerequisites ?? "",
			concreteLossEvidence: [...(input.concreteLossEvidence ?? [])],
			affectedScope: input.affectedScope,
			remediation: input.remediation,
			pocEvidence: [...input.pocEvidence],
			reproducibleSteps: [...input.reproducibleSteps],
			entryPoint: input.entryPoint ?? "",
			discoveryPath: input.discoveryPath ?? "",
			rawRequest: input.rawRequest ?? "",
			rawResponse: input.rawResponse ?? "",
			attackChain: input.attackChain ?? "",
			vulnType: input.vulnType ?? "",
			pocScript: input.pocScript ?? "",
			status: "active",
			rejectReason: "",
			rejectedAt: 0,
			...input.affectedAssetId !== void 0 ? { affectedAssetId: input.affectedAssetId } : {}
		});
	}
	/** [local.16] Rewrite one finding in place after human-guided acceptance-criteria fixes. */
	async updateFinding(sessionId, findingId, patch) {
		await this.requireGoal(sessionId);
		const table = (await this.domain()).table("findings");
		const key = recordKey(sessionId, findingId);
		const existing = await table.get(key);
		if (existing === void 0) throw new Error(`src: unknown finding ${findingId}；先调 src_state 查看现有 finding id`);
		if (existing.sessionId !== sessionId) throw new Error(`src: finding ${findingId} belongs to another session`);
		if (patch.title !== void 0 && patch.title !== existing.title) {
			const clash = (await this.sessionData(sessionId)).findings.find((row) => row.id !== findingId && row.title.trim().toLowerCase() === patch.title.trim().toLowerCase());
			if (clash !== void 0) throw new Error(`已有同名 finding ${clash.id}「${clash.title}」；换一个标题或直接更新那个 finding，不要重名`);
		}
		if (patch.affectedAssetId !== void 0 && patch.affectedAssetId !== "" ) await this.requireRef(sessionId, "assets", patch.affectedAssetId, "asset");
		const next = snapshot({ ...existing, ...patch, ...(patch.affectedAssetId === "" ? { affectedAssetId: void 0 } : {}) });
		await table.put(key, next);
		return next;
	}
	/** [local.26] Reject one finding: mark status=rejected + store the user remark. Kept in the graph
	 * (not deleted) so the admission gate can re-block re-submission and later findings can reference it
	 * for combination. Returns the updated record. */
	async rejectFinding(sessionId, findingId, reason, expectedFingerprint) {
		await this.requireGoal(sessionId);
		const reasonTrim = String(reason ?? "").trim();
		if (reasonTrim === "") throw new Error("src_reject_finding 需要非空 reason（用户打回备注：为什么打回、要 agent 做什么）");
		if (reasonTrim.length > 500) throw new Error("src_reject_finding reason 过长（>500 字）；备注应是一句可操作指令");
		const table = (await this.domain()).table("findings");
		const key = recordKey(sessionId, findingId);
		const existing = await table.get(key);
		if (existing === void 0) throw new Error(`src: unknown finding ${findingId}；先调 src_state 查看现有 finding id`);
		if (existing.sessionId !== sessionId) throw new Error(`src: finding ${findingId} belongs to another session`);
		if (expectedFingerprint !== undefined && findingFingerprint(existing)!==expectedFingerprint) throw new Error('漏洞内容已变化，拒绝过期页面操作');
		const next = snapshot({ ...existing, status: "rejected", rejectReason: reasonTrim, rejectedAt: Date.now() });
		await table.put(key, next);
		return next;
	}
	/** Record one asset; an optional parent links it into the asset graph. */
	async addAsset(sessionId, input) {
		await this.requireGoal(sessionId);
		const parentId = input.parentId === "" ? void 0 : input.parentId;
		if (parentId !== void 0) await this.requireRef(sessionId, "assets", parentId, "asset");
		const existing = (await this.sessionData(sessionId)).assets.find((asset) => asset.type === input.type && asset.value.trim().toLowerCase() === input.value.trim().toLowerCase());
		if (existing !== void 0) {
			const rank = { candidate: 0, confirmed: 1, excluded: 2 };
			const record = snapshot({ ...existing, meta: input.meta || existing.meta, source: input.source ?? existing.source, method: input.method ?? existing.method, confidence: Math.max(existing.confidence ?? 0, input.confidence ?? 0), status: rank[input.status ?? "confirmed"] >= rank[existing.status ?? "confirmed"] ? input.status ?? "confirmed" : existing.status });
			await (await this.domain()).table("assets").put(recordKey(sessionId, existing.id), record);
			return { nodeId: existing.id, duplicate: true, updated: true };
		}
		return this.addNode(sessionId, parentId === void 0 ? void 0 : "parent", parentId ?? "", "asset", {
			type: input.type,
			value: input.value,
			meta: input.meta,
			source: input.source ?? "unknown",
			method: input.method ?? "passive",
			confidence: input.confidence ?? .5,
			status: input.status ?? "confirmed"
		});
	}
	/** Record coverage for an asset/phase/category combination. */
	async createEndpointManifest(sessionId, input) {
		await this.requireGoal(sessionId);
		const table = (await this.domain()).table("endpoint_manifests");
		const record = snapshot(makeManifest(sessionId,input.source,input.endpoints));
		if (table.get(recordKey(sessionId,record.id))) return table.get(recordKey(sessionId,record.id));
		SCHEMA_OF_KIND.endpointManifest.parse(record);
		await table.put(recordKey(sessionId, record.id), record);
		return record;
	}
	async getEndpointManifest(sessionId, manifestId) {
		const row = (await this.domain()).table("endpoint_manifests").get(recordKey(sessionId, manifestId));
		if (row === void 0) throw new Error(`src: unknown endpoint manifest ${manifestId}`);
		return row;
	}
	async upsertCoverage(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("coverage");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.assetId === input.assetId && row.phase === input.phase && row.category === input.category);
		const inheritedManifest = input.manifestId ?? existing?.manifestId;
		if (inheritedManifest !== void 0) {
			if(existing?.manifestId && inheritedManifest!==existing.manifestId)throw new Error('不能替换已有coverage绑定的manifest来缩减分母');
			const manifest = await this.getEndpointManifest(sessionId, inheritedManifest);
			const statuses = { ...(existing?.endpointStatuses ?? {}), ...(input.endpointStatuses ?? {}) };
			const evidenceIds = [...new Set([...(existing?.evidence??[]),...(input.evidence??[])])];
			const calculated = computeCoverage(manifest,statuses,evidenceIds,(await this.sessionData(sessionId)).observations);
			input = {...input,manifestId:inheritedManifest,endpointStatuses:statuses,evidence:evidenceIds,...calculated};
		}
		// Partial status updates must not erase the accounting denominator or progress.
		input = { ...existing, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== void 0)) };
		const hasAccounting = [input.endpointsTotal, input.endpointsTested, input.endpointsSkipped].some((value) => value !== void 0);
		if (hasAccounting) {
			const total = input.endpointsTotal;
			const tested = input.endpointsTested ?? 0;
			const skipped = Array.isArray(input.endpointsSkipped) ? [...new Set(input.endpointsSkipped.filter((value) => typeof value === "string" && value.trim() !== ""))] : [];
			if (!Number.isInteger(total) || total < 0) throw new Error("coverage endpointsTotal 必须是非负整数");
			if (!Number.isInteger(tested) || tested < 0) throw new Error("coverage endpointsTested 必须是非负整数");
			if (tested > total || tested + skipped.length > total) throw new Error(`coverage 对账无效：tested=${tested}、skipped=${skipped.length} 不能超过 total=${total}`);
			input = { ...input, endpointsTotal: total, endpointsTested: tested, endpointsSkipped: skipped };
		}
		const idValue = existing?.id ?? await this.nextId("coverage", sessionId);
		const record = snapshot({ ...input, id: idValue, sessionId, evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record or update a vulnerability research hypothesis. */
	async upsertResearch(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.findingId !== void 0) await this.requireRef(sessionId, "findings", input.findingId, "finding");
		const table = (await this.domain()).table("research");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && (row.findingId ?? "") === (input.findingId ?? "") && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("research", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, preconditions: [...input.preconditions], evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record one HTTP observation row (timeline/evidence layer). */
	async upsertObservation(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const domain = await this.domain();
		return serializeObservation(domain, sessionId, async () => {
		const table = domain.table("observations");
		const idValue = await this.nextId("observation", sessionId);
		/* [local.17] respHeaders/reqHeaders 可能是 Burp 扩展返回的对象，落库前统一序列化为文本（schema 是 string）。 */
		const headersText = (h) => typeof h === "string" ? h : h !== null && typeof h === "object" ? Object.entries(h).map(([k, v]) => `${k}: ${String(v)}`).join("\n") : String(h ?? "");
		const record = snapshot({ id: idValue, sessionId, intentId: input.intentId, snapshotRef:input.snapshotRef, assetId: input.assetId, reqHeaders: input.reqHeaders, reqBodySnippet: input.reqBodySnippet, method: input.method ?? "GET", path: input.path, httpStatus: input.httpStatus ?? 0, respHeaders: headersText(input.respHeaders), respBodySnippet: typeof input.respBodySnippet === "string" ? input.respBodySnippet : String(input.respBodySnippet ?? ""), protectionSignal: input.protectionSignal ?? false, wafBypassed: input.wafBypassed ?? false, source: input.source ?? "scan", decision: input.decision ?? "", createdAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
		});
	}
	/** Record one user-assist todo awaiting a human action. */
	async upsertUserTodo(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("user_todos");
		const existing = input.userTodoId !== void 0 ? [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === input.userTodoId) : void 0;
		if (existing !== void 0) {
			const record = snapshot({ ...existing, title: input.title ?? existing.title, detail: input.detail ?? existing.detail, status: input.status ?? existing.status, note: input.note ?? existing.note, updatedAt: Date.now() });
			await table.put(recordKey(sessionId, existing.id), record);
			return { ...record, updated: true };
		}
		delete input.userTodoId;
		const idValue = await this.nextId("userTodo", sessionId);
		const record = snapshot({ id: idValue, sessionId, title: input.title, detail: input.detail ?? "", kind: input.kind ?? "other", status: input.status ?? "pending", note: input.note ?? "", createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** [local.61] 按标题前缀找待办（任意状态）——数据编排触发器的幂等依据。 */
	async findUserTodoByTitlePrefix(sessionId, titlePrefix) {
		const table = (await this.domain()).table("user_todos");
		return [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && typeof row.title === "string" && row.title.startsWith(titlePrefix)) ?? void 0;
	}
	/** [local.31] Find an existing pending approval by method+url+body (dedup so the agent
	 *  doesn't stack duplicate pending rows for the same high-risk request). */
	/** [local.44] Fetch one pending-approval row by id (for /src-approve to decide the ASSET fast path). */
	async getPendingApproval(sessionId, id) {
		const table = (await this.domain()).table("pending_approvals");
		return [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === id) ?? void 0;
	}
	async findPendingApproval(sessionId, method, url, body) {
		const table = (await this.domain()).table("pending_approvals");
		return [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.status === "pending" && row.method === method && row.url === url && row.body === (body ?? "")) ?? void 0;
	}
	/** [local.31] Hang up a high-risk HTTP request pending human approval (async queue:
	 *  dsh-user-approval only supports in-turn sync seam; dsh-src owns the queue). Stores
	 *  the full request so src_resolve_approval can replay it verbatim on approve.
	 *  [local.54] 认证头不再落明文：headers 存脱敏后的文本，credentialRef 指向凭证库，重放时重新注入。 */
	async addPendingApproval(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.intentId !== void 0) await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("pending_approvals");
		const idValue = await this.nextId("approval", sessionId);
		const record = snapshot({ id: idValue, sessionId, intentId: input.intentId, method: input.method, url: input.url, path: input.path, headers: input.headers, ...(input.credentialRef !== void 0 && input.credentialRef !== "" ? { credentialRef: input.credentialRef } : {}), body: input.body, category: input.category, reason: input.reason, justification: input.justification, ...(input.ruleVerdict !== void 0 ? { ruleVerdict: input.ruleVerdict } : {}), ...(input.layaAdvice !== void 0 ? { layaAdvice: input.layaAdvice } : {}), ...(input.safetyPlan ? {safetyPlan:input.safetyPlan} : {}), status: "pending", note: "", responseStatus: 0, createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** [local.31] Resolve a pending approval: allow → replay the stored request and record
	 *  the response status; reject → mark rejected. Idempotency: an already-resolved row
	 *  cannot be resolved twice. Returns the updated row (or throws on bad id / replay fail). */
	async recordApprovalDecision(sessionId, id, action, note = '') {
		const row = await this.getPendingApproval(sessionId, id);
		if (!row) throw new Error(`审批 ${id} 不存在`);
		if (row.status !== 'pending' || row.executionState === 'executing' || (action==='allow'&&['unknown','cancelled'].includes(row.executionState))) throw new Error('审批已处理、正在执行或结果不确定，不能重复签发');
		if (!['allow','reject'].includes(action)) throw new Error('审批操作非法');
		return this.updateApprovalExecution(sessionId,id,{userDecision:action,approvalSource:'human-command',decisionAt:Date.now(),executionState:'queued',note});
	}
	async updateApprovalExecution(sessionId,id,patch) {
		const row = await this.getPendingApproval(sessionId,id);
		if (!row) throw new Error(`审批 ${id} 不存在`);
		const updated = snapshot({...row,...patch,updatedAt:Date.now()});
		await (await this.domain()).table('pending_approvals').put(recordKey(sessionId,id),updated);
		return updated;
	}
	async resolvePendingApproval(sessionId, id, action, note, http, runCapability, resolveCredential, replayOptions = {}) {
		const domain = await this.domain();
		return serializeMutation(domain, `${sessionId}:approval:${id}`, async () => {
		if (!['allow','reject'].includes(action)) throw new Error('审批操作非法');
		const current = await this.getPendingApproval(sessionId,id);
		if (!current) throw new Error(`src_resolve_approval: 待审请求 ${id} 不存在`);
		if (current.status !== 'pending') throw new Error(`src_resolve_approval: 待审请求 ${id} 已 ${current.status}，不可重复审批`);
		if (current.executionState === 'executing' || (action==='allow' && ['unknown','cancelled'].includes(current.executionState))) throw new Error('上次执行结果不确定，先核对目标状态；禁止盲目重放');
		await this.updateApprovalExecution(sessionId,id,{executionState:'executing',executionStartedAt:Date.now()});
		try {
			const result = await this.performApproval(sessionId,id,action,note,http,runCapability,resolveCredential,replayOptions);
			return await this.updateApprovalExecution(sessionId,id,{...result,executionState:action==='allow'?'executed':'rejected',executionEndedAt:Date.now()});
		} catch(error) {
			await this.updateApprovalExecution(sessionId,id,{executionState:error.safeNotSent?'failed-before-send':replayOptions.signal?.aborted?'cancelled':'unknown',executionError:String(error?.code ?? error?.name ?? 'EXECUTION_ERROR'),executionEndedAt:Date.now()});
			throw error;
		}
		});
	}
	async performApproval(sessionId, id, action, note, http, runCapability, resolveCredential, replayOptions = {}) {
		const table = (await this.domain()).table("pending_approvals");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === id);
		if (existing === void 0) throw new Error(`src_resolve_approval: 待审请求 ${id} 不存在`);
		if (existing.status !== "pending") throw new Error(`src_resolve_approval: 待审请求 ${id} 已 ${existing.status}，不可重复审批`);
		let responseStatus = 0;
		let runOutput;
		let responseBody;
		/* [local.44] 资产归属确认（method=ASSET）：不走 HTTP 重放——allow 把该注册域登记为 confirmed
		 *  资产（assetGrantHosts 剥 *./裸域后缀匹配，整个注册域含主域与全部子域进入授权清单），
		 *  reject 登记为 excluded（整域排除）。这是用户的授权决定，确定性落库，不经 LLM 转述。 */
		if (existing.method === "ASSET") {
			const domain = String(existing.url ?? "").trim().toLowerCase();
			if (domain === "") throw new Error("归属确认待审行缺少域名（内部错误）");
			const write = await this.addAsset(sessionId, { type: "root-domain", value: domain, meta: existing.reason ?? "", source: `用户归属确认（${id} ${action === "allow" ? "确认" : "否决"}）`, method: "user-confirmed", confidence: 1, status: action === "allow" ? "confirmed" : "excluded" });
			const resolved = snapshot({ ...existing, status: action === "allow" ? "approved" : "rejected", userDecision: action, note: note !== "" ? note : existing.note, responseStatus: 0, updatedAt: Date.now() });
			await table.put(recordKey(sessionId, id), resolved);
			/* [local.46] 读回最终资产记录（去重路径会升级状态，以盘上为准）随返回值带出，
			   供 /src-approve 命令层合成 src_add_asset 投影事件（否则面板资产 tab/计数看不到）。 */
			const assetRecord = write.nodeId !== void 0 ? [...(await (await this.domain()).table("assets")).entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.id === write.nodeId) : void 0;
			return { ...resolved, ...(write.nodeId !== void 0 ? { assetId: write.nodeId } : {}), duplicate: write.duplicate === true, ...(assetRecord !== void 0 ? { asset: assetRecord } : {}) };
		}
		if (action === "allow") {
			if (existing.method === "RUN") {
				/* [local.41] capability-run：批准 → 执行白名单脚本，输出随审批结果返回（不做 HTTP 重放）。 */
				if (typeof runCapability !== "function") throw new Error("capability-run 审批缺少执行器（内部错误）");
				const run = await runCapability(existing);
				responseStatus = run.exitCode < 0 ? 0 : run.exitCode;
				runOutput = run.output;
			} else {
				/* 原样重放存储的请求：method/url/headers/body。[local.54] headers 已脱敏，
				 * credentialRef 存在时从凭证库重读注入（CRLF 兼容：/\r?\n/ 切分）。 */
				const headers = (() => { const m = {}; for (const line of String(existing.headers ?? "").split(/\r?\n/)) { const idx = line.indexOf(":"); if (idx > 0) m[line.slice(0, idx).trim()] = line.slice(idx + 1).trim(); } return m; })();
				let credentialSecret = "";
				if (existing.credentialRef !== void 0 && typeof resolveCredential === "function") {
					const credential = await resolveCredential(existing.credentialRef);
					credentialSecret = credential;
					Object.assign(headers, credentialHeaders(credential));
				}
				/* [local.67 #17-④] Content-Type 自动补全硬闸（重放侧）：自动补全上线前挂起的旧行可能没存头，
				 * 重放时同样补，避免 415 假阴性复发。fetch 对字符串 body 不自动带头——这是 §1.5 事故链的根因。 */
				if (existing.body !== "" && /^[{[]/.test(existing.body.trim()) && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
				const u = new URL(existing.url);
				const init = { method: existing.method, redirect: "manual", headers: { "user-agent": "dsh-src/1", ...headers }, ...(existing.body !== "" ? { body: existing.body } : {}) };
				const response = await http(u, init);
				responseStatus = response.status;
				/* [local.67 #17] 重放响应体透传（主修点）：重放的恰是审批过的高价值请求，finding PoC 就靠这份响应
				 * （fact-31「响应体分析是 evidence 关键」）。截断/去重/掩码统一走 describeHttpBody；
				 * 掩码用注入凭证原文做精确替换。截断+掩码后的文本落 responseBody 字段（随记录持久化与投影）。 */
				if (typeof describeHttpBody === "function") {
					let rawReplayBody = "";
					try { rawReplayBody = await response.text(); } catch {}
					const described = describeHttpBody({ sessionId, url: existing.url, method: existing.method, status: response.status, contentType: response.headers?.get?.("content-type") ?? "", rawBody: rawReplayBody, secrets: credentialSecret !== "" ? [credentialSecret, ...Object.values(credentialHeaders(credentialSecret)).filter((v) => typeof v === "string" && v.trim().length >= 8)] : [], full: replayOptions.full === true });
					responseBody = described.body;
				}
			}
		}
		const responseEvidenceId = typeof replayOptions.responseEvidenceId === "function" ? String(replayOptions.responseEvidenceId() ?? "") : String(replayOptions.responseEvidenceId ?? "");
		const latest = await this.getPendingApproval(sessionId,id);
		const record = snapshot({ ...existing, ...latest, status: action === "allow" ? "approved" : "rejected", userDecision: action, approvalSource: replayOptions.approvalSource ?? "unknown", note: String(note ?? "") !== "" ? String(note) : existing.note, responseStatus, ...(runOutput !== void 0 ? { runOutput } : {}), ...(responseBody !== void 0 ? { responseBody } : {}), ...(responseEvidenceId !== "" ? { responseEvidenceId } : {}), ...(typeof replayOptions.sideEffectObserved === "boolean" ? { sideEffectObserved: replayOptions.sideEffectObserved } : {}), updatedAt: Date.now() });
		await this.appendEvent({ sessionId, aggregateId: id, aggregateVersion: Number((/-(\d+)$/.exec(id)?.[1]) ?? 0), eventType: "approval.resolved", payload: record });
		await table.put(recordKey(sessionId, id), record);
		/* [local.104] 审批结果是 agent 可消费的内部事件，不是新的人工待办。
		 * 旧逻辑把每次 allow 自动伪装成 pending userTodo，导致已批准请求持续阻塞 finalize。 */
		return record;
	}
	/** [local.23] Upsert a pasted test-account credential row (dedupe by label per session).
	 * [local.54] 凭证走专用目录：record 只存 credentialRef（fingerprint 指向 $DSH_HOME/storages/src-credentials/），
	 * 不再落明文 credential。旧记录的明文 credential 保持可读（向后兼容），但一旦本 label 更新即改写为引用。 */
	async upsertTestAccount(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.sourceObservationId !== void 0) await this.requireRef(sessionId, "observations", input.sourceObservationId, "observation");
		if ((input.credential ?? "") === "" && (input.credentialRef ?? "") === "") throw new Error("upsertTestAccount 需要 credential 或 credentialRef");
		const table = (await this.domain()).table("test_accounts");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.label.toLowerCase() === input.label.toLowerCase());
		const idValue = existing?.id ?? await this.nextId("testAccount", sessionId);
		const record = snapshot({ id: idValue, sessionId, label: input.label, ...(input.credentialRef !== void 0 && input.credentialRef !== "" ? { credentialRef: input.credentialRef } : input.credential !== void 0 && input.credential !== "" ? { credential: input.credential } : {}), note: input.note ?? "", ...(input.sourceObservationId !== void 0 ? { sourceObservationId: input.sourceObservationId } : {}), createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** [local.23] List a session's test accounts (label 主通道 + infra.testAccount 单值兼容为无 label 条目).
	 * [local.54] 永不返回明文 credential，只带 credentialRef 供 src_http 引用。 */
	async listTestAccounts(sessionId) {
		const table = (await this.domain()).table("test_accounts");
		const rows = [...table.entries()].map(([, row]) => row).filter((row) => row.sessionId === sessionId).map((row) => ({ id: row.id, label: row.label, credentialRef: row.credentialRef, note: row.note, sourceObservationId: row.sourceObservationId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
		const legacy = (await this.getInfra(sessionId)).testAccount;
		const legacyCredential = String(legacy ?? "").trim();
		if (legacyCredential !== "" && !rows.some((row) => row.label.toLowerCase() === "legacy-infra")) rows.push({ id: "infra:testAccount", label: "legacy-infra", note: "旧版 infra.testAccount 单值（向后兼容读入）", createdAt: 0, updatedAt: 0 });
		return rows;
	}
	/** [local.24] Upsert a domain note keyed by target+title (same target+title 覆盖更新，跨会话积累不膨胀). */
	async upsertDomainNote(sessionId, input) {
		const target = input.target;
		const table = (await this.domain()).table("domain_notes");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.target === target && row.title.toLowerCase() === input.title.toLowerCase());
		const idValue = existing?.id ?? await this.nextId("domainNote", sessionId);
		const record = snapshot({ id: idValue, target, sessionId, category: input.category, title: input.title, content: input.content, createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now() });
		await table.put(`${target}:${idValue}`, record);
		return { ...record, updated: existing !== void 0 };
	}
	/** [local.24] List domain notes for a target (any session). */
	async listDomainNotes(target) {
		const table = (await this.domain()).table("domain_notes");
		return [...table.entries()].map(([, row]) => row).filter((row) => row.target === target).sort((a, b) => a.createdAt - b.createdAt).map((row) => ({ id: row.id, category: row.category, title: row.title, content: row.content, sourceSessionId: row.sessionId, createdAt: row.createdAt, updatedAt: row.updatedAt }));
	}
	/** User-facing domain catalog: targets are the deletion unit, not model-callable state. */
	async listDomainCatalog() {
		const domain = await this.domain();
		const byTarget = new Map();
		const ensure = (target) => {
			const key = String(target ?? "").trim();
			if (key === "") return void 0;
			if (!byTarget.has(key)) byTarget.set(key, { target: key, sessions: new Set(), notes: 0, assets: 0, findings: 0, research: 0, observations: 0, approvals: 0, todos: 0, infra: 0, surveySeeds: 0, lastUpdated: 0 });
			return byTarget.get(key);
		};
		const sessionTargets = new Map();
		for (const [, row] of domain.table("goals").entries()) { const item = ensure(row.target); if (item !== void 0) { item.sessions.add(row.sessionId); sessionTargets.set(row.sessionId, row.target); item.lastUpdated = Math.max(item.lastUpdated, row.createdAt ?? 0); } }
		for (const [, row] of domain.table("domain_notes").entries()) { const item = ensure(row.target); if (item !== void 0) { item.notes += 1; item.sessions.add(row.sessionId); item.lastUpdated = Math.max(item.lastUpdated, row.updatedAt ?? row.createdAt ?? 0); } }
		// Infer orphan-session ownership only when every surviving note agrees on one target.
		const noteTargets = new Map();
		for (const [, row] of domain.table("domain_notes").entries()) {
			if (!noteTargets.has(row.sessionId)) noteTargets.set(row.sessionId, new Set());
			noteTargets.get(row.sessionId).add(row.target);
		}
		for (const [sid, targets] of noteTargets) if (!sessionTargets.has(sid) && targets.size === 1) sessionTargets.set(sid, [...targets][0]);
		const addSessionRows = (tableName, field) => { for (const [, row] of domain.table(tableName).entries()) { const target = sessionTargets.get(row.sessionId); const item = ensure(target); if (item !== void 0) { item[field] += 1; item.sessions.add(row.sessionId); item.lastUpdated = Math.max(item.lastUpdated, row.updatedAt ?? row.createdAt ?? 0); } } };
		addSessionRows("assets", "assets"); addSessionRows("findings", "findings"); addSessionRows("research", "research"); addSessionRows("observations", "observations"); addSessionRows("pending_approvals", "approvals"); addSessionRows("user_todos", "todos"); addSessionRows("infra", "infra"); addSessionRows("survey_seeds", "surveySeeds");
		return [...byTarget.values()].map((item) => ({ ...item, sessions: item.sessions.size })).sort((a, b) => b.lastUpdated - a.lastUpdated || a.target.localeCompare(b.target));
	}
	/** Freeze exact keys before destructive work; journaled by the user command for retry. */
	async planTargetDeletion(target) {
		const domain = await this.domain();
		const goals = [...domain.table("goals").entries()].map(([, row]) => row);
		const sessionIds = new Set(goals.filter((row) => row.target === target).map((row) => row.sessionId));
		const notes = [...domain.table("domain_notes").entries()];
		// Orphan notes remain manageable after host history deletion; never delete a reused other-domain session.
		for (const [, row] of notes) if (row.target === target && !goals.some((g) => g.sessionId === row.sessionId && g.target !== target) && !notes.some(([, n]) => n.sessionId === row.sessionId && n.target !== target)) sessionIds.add(row.sessionId);
		for (const [, row] of domain.table("checkpoints").entries()) if (sessionIds.has(row.sessionId) && row.childSessionId && !goals.some((g) => g.sessionId === row.childSessionId && g.target !== target)) sessionIds.add(row.childSessionId);
		const tableNames = Object.keys(srcDomainSpec.tables);
		const entries = [], credentialRefs = new Set(), approvals = [];
		for (const name of tableNames) for (const [key, row] of domain.table(name).entries()) {
			if (name === "domain_notes" ? row.target !== target : !sessionIds.has(row.sessionId)) continue;
			entries.push({ table: name, key });
			for (const match of JSON.stringify(row).matchAll(/credential:\/\/[a-f0-9]{64}/g)) credentialRefs.add(match[0]);
			if (name === "pending_approvals") approvals.push({ id: row.id, url: row.url, method: row.method });
		}
		return { target, tableNames, sessionIds: [...sessionIds], entries, credentialRefs: [...credentialRefs], approvals };
	}
	async deleteTargetData(target, plan) {
		if (!plan || plan.target !== target) throw new Error("删除计划不匹配");
		const domain = await this.domain(), deleted = {};
		for (const { table: name, key } of plan.entries) {
			const table = domain.table(name);
			if (table.get(key) === void 0) continue;
			await table.delete(key);
			deleted[name] = (deleted[name] ?? 0) + 1;
		}
		for (const sid of plan.sessionIds) this.authRequestCounts.delete(sid);
		return deleted;
	}
	/** [local.81 Phase 7] Add a survey seed to the queue; same value deduplicates (returns the existing row). */
	async addSurveySeed(sessionId, { kind = "root-domain", value, source = "user", note = "" }) {
		await this.requireGoal(sessionId);
		const table = (await this.domain()).table("survey_seeds");
		const normalized = String(value ?? "").trim().toLowerCase();
		if (normalized === "") throw new Error("survey seed value must not be empty");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && String(row.value).trim().toLowerCase() === normalized);
		if (existing !== void 0) return { seed: existing, duplicate: true };
		const idValue = await this.nextId("surveySeed", sessionId);
		const record = snapshot({ id: idValue, sessionId, kind, value: normalized, status: "pending", source, note, createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { seed: record, duplicate: false };
	}
	/** [local.81] List this session's survey seeds by createdAt (oldest first). */
	async surveySeeds(sessionId) {
		const table = (await this.domain()).table("survey_seeds");
		return [...table.entries()].map(([, row]) => row).filter((row) => row.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
	}
	/** [local.81] Read one seed row (or void 0). */
	async getSurveySeed(sessionId, id) {
		return (await this.domain()).table("survey_seeds").get(recordKey(sessionId, id));
	}
	/** [local.81] Update one seed's status; only legal transitions allowed (illegal throws). */
	async updateSurveySeed(sessionId, id, patch = {}) {
		const table = (await this.domain()).table("survey_seeds");
		const existing = table.get(recordKey(sessionId, id));
		if (existing === void 0) throw new Error(`survey seed ${id} not found`);
		if (patch.status !== void 0 && patch.status !== existing.status) {
			const legal = { pending: ["active", "dead", "done"], active: ["done", "dead"], done: [], dead: [] };
			if (!(legal[existing.status] ?? []).includes(patch.status)) throw new Error(`illegal survey seed transition ${existing.status} → ${patch.status}`);
		}
		const record = snapshot({ ...existing, ...patch, updatedAt: Date.now() });
		await table.put(recordKey(sessionId, id), record);
		return record;
	}
	/**
	 * [local.24] Cross-session briefing: prior context for a target — domain notes,
	 * falsified/blocked research hypotheses (已否假设) and confirmed findings across ALL sessions
	 * that touched the same target. Used by src_add_goal so resume/restart 不钻枯井、复用已得。
	 */
	async reviseKnowledge(sessionId,input) {
		await this.requireGoal(sessionId);
		const sourceSessionId=input.sourceSessionId ?? sessionId;
		const domain=await this.domain(), table=KNOWLEDGE_TABLES[input.kind];
		if (!table) throw new Error('只能修订fact/research/note结论');
		const target=[...domain.table(table).entries()].map(([,r])=>r).find(r=>r.sessionId===sourceSessionId&&r.id===input.recordId);
		if (!target) throw new Error('待修订知识记录不存在');
		const goal=await this.requireGoal(sessionId), sourceGoal=await this.getGoal(sourceSessionId);
		if (sourceSessionId!==sessionId && (input.kind==='note'?target.target:sourceGoal?.target)!==goal.target) throw new Error('不能失效其他目标的知识');
		if (!input.reason?.trim() || !Array.isArray(input.evidenceIds) || !input.evidenceIds.length) throw new Error('更正必须说明原因并提供新证据ID');
		const data=await this.sessionData(sessionId), refs=[...data.facts,...data.observations,...data.research];
		if(input.evidenceIds.some(id=>!refs.some(r=>r.id===id)))throw new Error('更正证据不在本engagement');
		const id=`revision-${createHash('sha256').update(JSON.stringify([sourceSessionId,input.recordId])).digest('hex').slice(0,20)}`;
		const row=snapshot({id,sessionId,sourceSessionId,recordId:input.recordId,kind:input.kind,reason:input.reason,evidenceIds:input.evidenceIds,createdAt:Date.now()});
		await domain.table('knowledge_revisions').put(recordKey(sessionId,id),row);return row;
	}
	async collectPriorContext(target, excludeSessionId) {
		const domain = await this.domain();
		const revisions=[...domain.table('knowledge_revisions').entries()].map(([,r])=>r);
		const notes = (await this.listDomainNotes(target)).filter(row=>!isSuperseded(revisions,row.sourceSessionId,row.id)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId }));
		const priorSessions = [];
		for (const [, row] of domain.table("goals").entries()) {
			if (row.target === target && row.sessionId !== excludeSessionId) priorSessions.push(row.sessionId);
		}
		const falsified = [];
		const blocked = [];
		const findings = [];
		const pendingItems = [];
		for (const sid of priorSessions) {
			for (const [, row] of domain.table("research").entries()) {
				if (row.sessionId === sid && !isSuperseded(revisions,sid,row.id) && (row.status === "false-positive" || row.status === "blocked")) (row.status === "blocked" ? blocked : falsified).push({ hypothesis: row.hypothesis, category: row.category, stopReason: row.stopReason, sourceSessionId: sid });
			}
			for (const [, row] of domain.table("findings").entries()) {
				if (row.sessionId === sid) findings.push({ title: row.title, severity: row.severity, id: row.id, sourceSessionId: sid, status: row.status });
			}
			/* [local.86] Dangling items: pending/abandoned user todos + planned/running intents from prior sessions. */
			for (const [, row] of domain.table("user_todos").entries()) {
				if (row.sessionId === sid && (row.status === "pending" || row.status === "abandoned")) pendingItems.push({ kind: row.kind, title: row.title, status: row.status, id: row.id, sourceSessionId: sid });
			}
			for (const [, row] of domain.table("intents").entries()) {
				if (row.sessionId === sid && (row.status === "planned" || row.status === "running")) pendingItems.push({ kind: "intent", title: row.title, status: row.status, id: row.id, sourceSessionId: sid });
			}
		}
		const result = {};
		if (notes.length > 0) result.notes = notes;
		if (falsified.length > 0) result.falsifiedHypotheses = falsified;
		if (blocked.length > 0) result.blockedHypotheses = blocked;
		if (findings.length > 0) result.findings = findings;
		if (pendingItems.length > 0) result.pendingItems = pendingItems.slice(0, 10);
		if (pendingItems.length > 10) result.pendingItemsTruncated = true;
		if (priorSessions.length > 0) result.priorSessions = priorSessions.length;
		return result;
	}
	/** [local.23] Count one authenticated request (carries Authorization or Cookie) and return the running total for the session. */
	countAuthRequest(sessionId, n = 1) {
		const cur = this.authRequestCounts.get(sessionId) ?? 0;
		const next = cur + n;
		this.authRequestCounts.set(sessionId, next);
		return next;
	}
	authRequestTotal(sessionId) {
		return this.authRequestCounts.get(sessionId) ?? 0;
	}
	/**
	 * [local.9] Read resolved infrastructure settings: defaults merged over the
	 * session's stored overrides. Survives goal resets by design.
	 */
	async getInfra(sessionId) {
		const table = (await this.domain()).table("infra");
		const overrides = {};
		for (const [, row] of table.entries()) if (row.sessionId === sessionId) overrides[row.key] = row.value;
		return { ...SRC_INFRA_DEFAULTS, ...overrides };
	}
	/** [local.17] Raw override rows of one session (empty when the session never overrode anything). */
	async getInfraOverrides(sessionId) {
		const table = (await this.domain()).table("infra");
		const rows = [];
		for (const [, row] of table.entries()) if (row.sessionId === sessionId) rows.push(row);
		return rows;
	}
	/** [local.14] Persist one infrastructure setting override (validated upstream). */
	async setInfra(sessionId, key, value) {
		const table = (await this.domain()).table("infra");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.key === key);
		if (value === "") {
			/* Empty value clears the override so the built-in default applies again. */
			if (existing !== void 0) await table.delete(recordKey(sessionId, existing.id));
			return snapshot({ id: existing?.id ?? key, sessionId, key, value: SRC_INFRA_DEFAULTS[key] ?? "", updatedAt: Date.now() });
		}
		const record = snapshot({ id: existing?.id ?? key, sessionId, key, value, updatedAt: Date.now() });
		await table.put(recordKey(sessionId, record.id), record);
		return record;
	}
	/** [local.14] Most recent other session that has any infra override: { sourceSessionId, overrides } or undefined. */
	async latestOtherInfra(sessionId) {
		const table = (await this.domain()).table("infra");
		const bySource = new Map();
		for (const [, row] of table.entries()) {
			if (row.sessionId === sessionId || !SRC_INFRA_KEYS.includes(row.key)) continue;
			const current = bySource.get(row.sessionId);
			if (current === void 0 || row.updatedAt > current.updatedAt) bySource.set(row.sessionId, row);
		}
		let latestAt = -1;
		let sourceSessionId;
		for (const [candidate, row] of bySource) if (row.updatedAt > latestAt) {
			latestAt = row.updatedAt;
			sourceSessionId = candidate;
		}
		if (sourceSessionId === void 0) return void 0;
		const overrides = {};
		for (const [, row] of table.entries()) if (row.sessionId === sourceSessionId && row.value !== "") overrides[row.key] = row.value;
		return { sourceSessionId, updatedAt: latestAt, overrides };
	}
	/** [local.9] Rewrite the goal target in place without resetting the graph. */
	async updateGoalTarget(sessionId, target) {
		const existing = await this.getGoal(sessionId);
		if (existing === void 0) throw new Error("src: no goal to update");
		const record = snapshot({ ...existing, target });
		await (await this.domain()).table("goals").put(sessionId, record);
		return record;
	}
	/** Read all exploration rows of one session, ordered by id (insertion order). */
	async sessionData(sessionId) {
		const domain = await this.domain();
		const bySession = (rows) => [...rows].map(([, row]) => row).filter((row) => row.sessionId === sessionId).sort((a, b) => {
			const at = Number(a.createdAt ?? a.updatedAt ?? 0), bt = Number(b.createdAt ?? b.updatedAt ?? 0);
			return at - bt || String(a.id).localeCompare(String(b.id), "en");
		});
		return {
			goal: await this.getGoal(sessionId),
			intents: bySession(domain.table("intents").entries()),
			facts: bySession(domain.table("facts").entries()),
			findings: bySession(domain.table("findings").entries()),
			assets: bySession(domain.table("assets").entries()),
			coverage: bySession(domain.table("coverage").entries()),
			research: bySession(domain.table("research").entries()),
			checkpoints: bySession(domain.table("checkpoints").entries()),
			observations: bySession(domain.table("observations").entries()),
			userTodos: bySession(domain.table("user_todos").entries()),
			pendingApprovals: bySession(domain.table("pending_approvals").entries()),
			testAccounts: bySession(domain.table("test_accounts").entries()).map((row) => ({ id: row.id, label: row.label, credentialRef: row.credentialRef, note: row.note, sourceObservationId: row.sourceObservationId, createdAt: row.createdAt, updatedAt: row.updatedAt })),
			edges: bySession(domain.table("edges").entries()),
			infra: bySession(domain.table("infra").entries()),
			endpointManifests: bySession(domain.table("endpoint_manifests").entries()),
			knowledgeRevisions: [...domain.table('knowledge_revisions').entries()].map(([,row])=>row).filter(row=>row.sessionId===sessionId||row.sourceSessionId===sessionId)
		};
	}
	/** Build the model-visible summary view for one session. */
	async view(sessionId) {
		const { goal, intents, facts, findings, assets, coverage, research, checkpoints, observations, userTodos, pendingApprovals, testAccounts, edges, infra, endpointManifests, knowledgeRevisions } = await this.sessionData(sessionId);
		/* [local.24] 域笔记按目标域名跨会话共享：本会话有 goal 时一并投影（历史任何会话沉淀的都可见）。 */
		const domainNotes = goal === void 0 ? [] : (await this.listDomainNotes(goal.target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId, updatedAt: row.updatedAt }));
		if (goal === void 0) return {
			initialized: false,
			infra: { ...SRC_INFRA_DEFAULTS },
			endpointManifests: [],
			intents: [],
			facts: [],
			findings: [],
			assets: [],
			coverage: [],
			research: [],
			checkpoints: [],
			observations: [],
			userTodos: [],
			pendingApprovals: [],
			testAccounts: [],
			domainNotes: [],
			edges: [],
			counts: {
				intents: 0,
				facts: 0,
				findings: 0,
				assets: 0,
				coverage: 0,
				research: 0,
				checkpoints: 0,
				observations: 0,
				userTodos: 0,
				pendingApprovals: 0,
				testAccounts: 0,
				domainNotes: 0
			},
			authBudget: { used: 0, limit: SRC_AUTH_REQUEST_BUDGET }
		};
		return snapshot({
			initialized: true,
			goal,
			infra: { ...SRC_INFRA_DEFAULTS, ...Object.fromEntries(infra.map((row) => [row.key, row.value])) },
			endpointManifests,
			knowledgeRevisions,
			intents,
			facts,
			findings,
			assets,
			coverage,
			research,
			checkpoints,
			observations,
			userTodos,
			pendingApprovals,
			testAccounts: (() => {
				const rows = testAccounts;
				const legacyCredential = String((Object.fromEntries(infra.map((row) => [row.key, row.value]))).testAccount ?? "").trim();
				if (legacyCredential !== "" && !rows.some((row) => row.label.toLowerCase() === "legacy-infra")) {
					return [...rows, { id: "infra:testAccount", label: "legacy-infra", note: "旧版 infra.testAccount 单值（向后兼容读入）", sourceObservationId: void 0, createdAt: 0, updatedAt: 0 }];
				}
				return rows;
			})(),
			edges,
			domainNotes,
			counts: {
				intents: intents.length,
				facts: facts.length,
				findings: findings.length,
				assets: assets.length,
				coverage: coverage.length,
				research: research.length,
				checkpoints: checkpoints.length,
				observations: observations.length,
				userTodos: userTodos.length,
				pendingApprovals: pendingApprovals.length,
				testAccounts: testAccounts.length,
				domainNotes: domainNotes.length
			},
			authBudget: { used: this.authRequestTotal(sessionId), limit: SRC_AUTH_REQUEST_BUDGET }
		});
	}
};
// Every successful write (including partial accepted child batches) publishes authoritative IDs.
const mutations = ['initGoal','clearSession','addNode','addIntent','updateIntent','addCheckpoint','addFact','addFinding','updateFinding','rejectFinding','addAsset','createEndpointManifest','upsertCoverage','upsertResearch','upsertObservation','upsertUserTodo','addPendingApproval','recordApprovalDecision','updateApprovalExecution','reviseKnowledge','updateGoalTarget'];
for (const name of mutations) {
  const original = SrcStore.prototype[name];
  if (!original) continue;
  SrcStore.prototype[name] = async function(sessionId, ...args) {
    const domain = await this.domain();
    if (inMutation(domain, sessionId)) return original.call(this, sessionId, ...args);
    return serializeMutation(domain, sessionId, async () => {
      const before = captureRows(domain, sessionId);
      try { return await original.call(this, sessionId, ...args); }
      finally {
        const changes = changedRows(before, captureRows(domain, sessionId));
        if (changes.puts.length || changes.deletes.length) {
          const events = domain.table('src_commits');
          const own = [...events.entries()].map(([,r])=>r).filter(r=>r.sessionId===sessionId);
          const eventSeq = Math.max(0,...own.map(r=>r.eventSeq ?? 0)) + 1;
          const batch = {sessionId,eventSeq,createdAt:Date.now(),...changes,...(eventSeq===1?{puts:[...captureRows(domain,sessionId).values()],baseline:true}:{})};
          await events.put(`${sessionId}:commit:${eventSeq}`,{id:`${sessionId}:commit:${eventSeq}`,sessionId,eventId:randomUUID(),eventSeq,aggregateId:sessionId,aggregateVersion:eventSeq,eventType:'store.committed',payload:batch,createdAt:batch.createdAt});
          try { appendSessionToolEvent?.(this.ctx.sessions?.get?.(sessionId), 'src_store_committed', batch); }
          catch(error) {console.warn('[dsh-src] store committed; live projection delivery failed; use authoritative state:',error.message);}
        }
      }
    });
  };
}
return SrcStore;
}
