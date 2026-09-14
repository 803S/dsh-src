// SRC durable store implementation. Dependencies are injected by the composition root.

export function createSrcStore(dependencies) {
	const { srcDomainSpec, sharedDomainOpens, LEGACY_KEY_MIGRATION_TABLES, recordKey, TABLE_OF_ID_KIND, snapshot, SCHEMA_OF_KIND, closeProofServersOfSession, assetGrantHosts, SEVERITIES, SRC_INFRA_DEFAULTS, SRC_INFRA_KEYS, SRC_AUTH_REQUEST_BUDGET, routePlaybook, credentialHeaders, describeHttpBody, srcEventRecorder } = dependencies;
	return class SrcStore {
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
			await (await pending).close();
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
			authorization: input.authorization
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
			playbook: input.playbook ?? routePlaybook(input.title, input.detail)
		});
	}
	/** Update the lifecycle status of one intent. */
	async updateIntent(sessionId, intentId, status, priority = void 0) {
		await this.requireRef(sessionId, "intents", intentId, "intent");
		const table = (await this.domain()).table("intents");
		const key = recordKey(sessionId, intentId);
		const current = table.get(key);
		/* [local.42] status 与 priority 都可单独更新；snapshot 剥 undefined，未提供的字段保持原值。 */
		if (status === void 0 && priority === void 0) return { ...current };
		const patch = { ...(status !== void 0 ? { status } : {}), ...(priority !== void 0 ? { priority } : {}) };
		const record = snapshot({ ...current, ...patch });
		await this.appendEvent({ sessionId, aggregateId: intentId, aggregateVersion: Number((/-(\d+)$/.exec(intentId)?.[1]) ?? 0), eventType: "intent.upserted", payload: record });
		await table.put(key, record);
		return record;
	}
	/** Append one durable delegated-child progress checkpoint. */
	async addCheckpoint(sessionId, input) {
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		const table = (await this.domain()).table("checkpoints");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.childSessionId === input.childSessionId && row.stage === input.stage && row.summary === input.summary && row.facts === input.facts && row.assets === input.assets && row.findings === input.findings && row.batchKey === input.batchKey);
		if (existing !== void 0) return { ...existing, duplicate: true };
		const checkpointId = await this.nextId("checkpoint", sessionId);
		const record = snapshot({ id: checkpointId, sessionId, ...input, createdAt: Date.now() });
		await this.appendEvent({ sessionId, aggregateId: checkpointId, aggregateVersion: Number((/-(\d+)$/.exec(checkpointId)?.[1]) ?? 0), eventType: "checkpoint.appended", payload: record });
		await table.put(recordKey(sessionId, checkpointId), record);
		const status = input.stage === "completed" ? "completed" : input.stage === "blocked" ? "blocked" : input.stage === "failed" ? "failed" : "running";
		await this.updateIntent(sessionId, input.intentId, status);
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
	async rejectFinding(sessionId, findingId, reason) {
		await this.requireGoal(sessionId);
		const reasonTrim = String(reason ?? "").trim();
		if (reasonTrim === "") throw new Error("src_reject_finding 需要非空 reason（用户打回备注：为什么打回、要 agent 做什么）");
		if (reasonTrim.length > 500) throw new Error("src_reject_finding reason 过长（>500 字）；备注应是一句可操作指令");
		const table = (await this.domain()).table("findings");
		const key = recordKey(sessionId, findingId);
		const existing = await table.get(key);
		if (existing === void 0) throw new Error(`src: unknown finding ${findingId}；先调 src_state 查看现有 finding id`);
		if (existing.sessionId !== sessionId) throw new Error(`src: finding ${findingId} belongs to another session`);
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
	async upsertCoverage(sessionId, input) {
		await this.requireGoal(sessionId);
		if (input.assetId !== void 0) await this.requireRef(sessionId, "assets", input.assetId, "asset");
		const table = (await this.domain()).table("coverage");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.assetId === input.assetId && row.phase === input.phase && row.category === input.category);
		const idValue = existing?.id ?? await this.nextId("coverage", sessionId);
		const record = snapshot({ id: idValue, sessionId, ...input, evidence: [...input.evidence], updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return { ...record, updated: existing !== void 0 };
	}
	/** Record or update a vulnerability research hypothesis. */
	async upsertResearch(sessionId, input) {
		await this.requireGoal(sessionId);
		await this.requireRef(sessionId, "intents", input.intentId, "intent");
		if (input.findingId !== void 0) await this.requireRef(sessionId, "findings", input.findingId, "finding");
		const table = (await this.domain()).table("research");
		const existing = [...table.entries()].map(([, row]) => row).find((row) => row.sessionId === sessionId && row.intentId === input.intentId && row.category === input.category);
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
		const table = (await this.domain()).table("observations");
		const idValue = await this.nextId("observation", sessionId);
		/* [local.17] respHeaders/reqHeaders 可能是 Burp 扩展返回的对象，落库前统一序列化为文本（schema 是 string）。 */
		const headersText = (h) => typeof h === "string" ? h : h !== null && typeof h === "object" ? Object.entries(h).map(([k, v]) => `${k}: ${String(v)}`).join("\n") : String(h ?? "");
		const record = snapshot({ id: idValue, sessionId, method: input.method ?? "GET", path: input.path, httpStatus: input.httpStatus ?? 0, respHeaders: headersText(input.respHeaders), respBodySnippet: typeof input.respBodySnippet === "string" ? input.respBodySnippet : String(input.respBodySnippet ?? ""), protectionSignal: input.protectionSignal ?? false, wafBypassed: input.wafBypassed ?? false, source: input.source ?? "scan", decision: input.decision ?? "", createdAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
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
		const record = snapshot({ id: idValue, sessionId, intentId: input.intentId, method: input.method, url: input.url, path: input.path, headers: input.headers, ...(input.credentialRef !== void 0 && input.credentialRef !== "" ? { credentialRef: input.credentialRef } : {}), body: input.body, category: input.category, reason: input.reason, justification: input.justification, status: "pending", note: "", responseStatus: 0, createdAt: Date.now(), updatedAt: Date.now() });
		await table.put(recordKey(sessionId, idValue), record);
		return record;
	}
	/** [local.31] Resolve a pending approval: allow → replay the stored request and record
	 *  the response status; reject → mark rejected. Idempotency: an already-resolved row
	 *  cannot be resolved twice. Returns the updated row (or throws on bad id / replay fail). */
	async resolvePendingApproval(sessionId, id, action, note, http, runCapability, resolveCredential, replayOptions = {}) {
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
			const resolved = snapshot({ ...existing, status: action === "allow" ? "approved" : "rejected", note: note !== "" ? note : existing.note, responseStatus: 0, updatedAt: Date.now() });
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
					const described = describeHttpBody({ url: existing.url, method: existing.method, status: response.status, contentType: response.headers?.get?.("content-type") ?? "", rawBody: rawReplayBody, secrets: credentialSecret !== "" ? [credentialSecret, ...Object.values(credentialHeaders(credentialSecret)).filter((v) => typeof v === "string" && v.trim().length >= 8)] : [], full: replayOptions.full === true });
					responseBody = described.body;
				}
			}
		}
		const record = snapshot({ ...existing, status: action === "allow" ? "approved" : "rejected", note: String(note ?? "") !== "" ? String(note) : existing.note, responseStatus, ...(runOutput !== void 0 ? { runOutput } : {}), ...(responseBody !== void 0 ? { responseBody } : {}), updatedAt: Date.now() });
		await this.appendEvent({ sessionId, aggregateId: id, aggregateVersion: Number((/-(\d+)$/.exec(id)?.[1]) ?? 0), eventType: "approval.resolved", payload: record });
		await table.put(recordKey(sessionId, id), record);
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
	async collectPriorContext(target, excludeSessionId) {
		const domain = await this.domain();
		const notes = (await this.listDomainNotes(target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId }));
		const priorSessions = [];
		for (const [, row] of domain.table("goals").entries()) {
			if (row.target === target && row.sessionId !== excludeSessionId) priorSessions.push(row.sessionId);
		}
		const falsified = [];
		const findings = [];
		for (const sid of priorSessions) {
			for (const [, row] of domain.table("research").entries()) {
				if (row.sessionId === sid && (row.status === "false-positive" || row.status === "blocked")) falsified.push({ hypothesis: row.hypothesis, category: row.category, stopReason: row.stopReason, sourceSessionId: sid });
			}
			for (const [, row] of domain.table("findings").entries()) {
				if (row.sessionId === sid) findings.push({ title: row.title, severity: row.severity, id: row.id, sourceSessionId: sid });
			}
		}
		const result = {};
		if (notes.length > 0) result.notes = notes;
		if (falsified.length > 0) result.falsifiedHypotheses = falsified;
		if (findings.length > 0) result.findings = findings;
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
		const bySession = (rows) => [...rows].map(([, row]) => row).filter((row) => row.sessionId === sessionId).sort((a, b) => a.id.localeCompare(b.id, "en"));
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
			infra: bySession(domain.table("infra").entries())
		};
	}
	/** Build the model-visible summary view for one session. */
	async view(sessionId) {
		const { goal, intents, facts, findings, assets, coverage, research, checkpoints, observations, userTodos, pendingApprovals, testAccounts, edges, infra } = await this.sessionData(sessionId);
		/* [local.24] 域笔记按目标域名跨会话共享：本会话有 goal 时一并投影（历史任何会话沉淀的都可见）。 */
		const domainNotes = goal === void 0 ? [] : (await this.listDomainNotes(goal.target)).map((row) => ({ id: row.id, category: row.category, title: row.title, sourceSessionId: row.sourceSessionId, updatedAt: row.updatedAt }));
		if (goal === void 0) return {
			initialized: false,
			infra: { ...SRC_INFRA_DEFAULTS },
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
}
