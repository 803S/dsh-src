/** [local.106] Jev 工作计量：把「判定服务实际干了多少活」折成「每会话一行聚合」+「最近 N 条明细」，
 * 写进 src 存储域，随 store 权威快照进投影与面板（「Jev」页）。
 *
 * 为什么不用遥测 JSONL：遥测受 DSH_SRC_TELEMETRY / DSH_SRC_LAYA_DECISION 开关影响（关掉就无声），
 * 只适合事后审计；面板要的是「当前目标下判定服务的工作量」，必须与判定结果同源、同刻写进权威域。
 *
 * 本模块是纯函数：不 import store、不读 telemetry、无模块级可变状态。
 * 记录内容与内容无关：只保留 host/tool/标题等短标签与判定元数据，
 * 绝不写入 URL 查询串、请求体、justification、页面 observation 等可能含密钥的正文
 * （browser-index 只记候选数量，不记页面文本）。
 */

/** 判定职责（与判定服务 taskSpec 一一对应，面板按此分类展示）。 */
export const DECISION_TASKS = ['risk-grade', 'scan-plan', 'delegate', 'skill-activate', 'browser-index'];
/** 明细行种类：一次判定 / 一次方法推荐 / 一次推荐被采纳。 */
export const DECISION_KINDS = ['decision', 'offer', 'adopt'];
/** 记不进已知职责时的归类（脏入参不得被误算进某个真实职责）。 */
export const DECISION_TASK_UNSUPPORTED = 'unsupported';
/** 每会话保留的最近明细条数（面板「最近决策」上限）。 */
export const DECISION_RECENT_LIMIT = 20;
/** 聚合行 id（与 recordKey(sessionId, id) 组合成存储键）。 */
export const DECISION_STATS_ID = 'decision-stats';
/** 模型键上限：超出并入 other，保证聚合行始终是有界的键集合。 */
const MODEL_KEYS = 12;
/** action/effect/source 分布键上限（取值本就是闭集，超限说明上游异常或值被拉长）。 */
const DISTRIBUTION_KEYS = 12;
/** errors 键上限（错误类型闭集）。 */
const ERROR_KEYS = 16;
/** 模式键上限（on/shadow/off 等）。 */
const MODE_KEYS = 8;
/** 已采纳推荐 id 的记忆上限（采纳去重依据：同一推荐只计一次）。 */
const ADOPTED_IDS = 50;
/** 单个短标签的最大字符数（不可信输入不得撑爆行）。 */
const TEXT_LIMIT = 120;
/** 分布键的最大字符数。 */
const KEY_LIMIT = 40;

/** 归一化文本：去控制字符、折叠空白、去首尾空白。 */
const text = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
/** 有界短标签（截断用省略号标记，便于识别）。 */
const clip = (value, limit = TEXT_LIMIT) => { const raw = text(value); return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw; };
/** 非负整数计数（不可信数字一律 0）。 */
const count = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
/** 计数表：只保留正整数项，键有界（防脏行把聚合撑爆）。 */
const counter = (value) => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
	const next = {};
	for (const [key, raw] of Object.entries(value)) {
		const n = count(raw);
		const label = clip(key, KEY_LIMIT);
		if (n > 0 && label !== '') next[label] = n;
	}
	return next;
};
/** 延迟四元组（count/sum/max/last，单位毫秒；负数与 NaN 归零）。 */
const latencyOf = (value) => value !== null && typeof value === 'object' ? { count: count(value.count), sum: count(value.sum), max: count(value.max), last: count(value.last) } : { count: 0, sum: 0, max: 0, last: 0 };
/** 计数 +1；超过上限键数时并入 other（上限内的键永远保留自己的名字）。 */
const bump = (map, key, limit) => {
	const label = clip(key, KEY_LIMIT) || 'unreported';
	const next = { ...map };
	if (limit !== void 0 && !Object.hasOwn(next, label) && Object.keys(next).length >= limit) next.other = (next.other ?? 0) + 1;
	else next[label] = (next[label] ?? 0) + 1;
	return next;
};
/** 职责分类（未知/脏值归入 unsupported，绝不误算进某个真实职责）。 */
export const decisionTaskOf = (value) => { const task = text(value).toLowerCase(); return DECISION_TASKS.includes(task) ? task : DECISION_TASK_UNSUPPORTED; };
/** host(+path) 标签：不带查询串，避免 URL 里可能含的密钥/一次性 token 落盘。 */
const hostPathOf = (value) => {
	const raw = text(value);
	if (raw === '') return '';
	try { const url = new URL(raw); return clip(`${url.host}${url.pathname}`, 80); }
	catch { return clip(raw, 80); }
};

/** 未初始化（或旧会话缺字段）时的零值聚合行。 */
export function emptyDecisionStats(sessionId, at = Date.now()) {
	return {
		id: DECISION_STATS_ID,
		sessionId: typeof sessionId === 'string' ? sessionId : '',
		total: 0,
		byTask: {}, byAction: {}, byEffect: {}, bySource: {}, byModel: {}, byMode: {},
		fallback: 0,
		errors: {},
		latency: { count: 0, sum: 0, max: 0, last: 0 },
		offered: 0, adopted: 0, offeredByTask: {}, adoptedByTask: {},
		adoptedIds: [],
		startedAt: count(at), updatedAt: count(at), lastAt: 0,
		decisionSeq: 0,
		last: null
	};
}

/** 归一化存储/旧行（schema default 已补全，这里再兜一层，保证折叠函数永远拿到完整形状）。 */
export function normalizeDecisionStats(stats, sessionId, at = 0) {
	const base = stats !== null && typeof stats === 'object' ? stats : {};
	const zero = emptyDecisionStats(base.sessionId ?? sessionId, at);
	const latency = latencyOf(base.latency);
	return {
		...zero,
		total: count(base.total),
		byTask: counter(base.byTask), byAction: counter(base.byAction), byEffect: counter(base.byEffect),
		bySource: counter(base.bySource), byModel: counter(base.byModel), byMode: counter(base.byMode),
		fallback: count(base.fallback),
		errors: counter(base.errors),
		latency,
		offered: count(base.offered), adopted: count(base.adopted),
		offeredByTask: counter(base.offeredByTask), adoptedByTask: counter(base.adoptedByTask),
		adoptedIds: Array.isArray(base.adoptedIds) ? base.adoptedIds.filter(id => typeof id === 'string' && id !== '').slice(-ADOPTED_IDS) : [],
		startedAt: count(base.startedAt) || zero.startedAt,
		updatedAt: count(base.updatedAt) || zero.updatedAt,
		lastAt: count(base.lastAt),
		decisionSeq: count(base.decisionSeq),
		last: base.last ?? null
	};
}

/** 明细行里的判定元数据（subject/label 由调用方给出，均为有界短标签）。 */
function entryOf(row) {
	const entry = {
		seq: count(row?.seq),
		kind: DECISION_KINDS.includes(row?.kind) ? row.kind : 'decision',
		at: count(row?.at),
		taskType: decisionTaskOf(row?.taskType),
		action: clip(row?.action, KEY_LIMIT),
		effect: clip(row?.effect, KEY_LIMIT),
		risk: clip(row?.risk, KEY_LIMIT),
		objectClass: clip(row?.objectClass, KEY_LIMIT),
		source: clip(row?.source, KEY_LIMIT),
		provider: clip(row?.provider, KEY_LIMIT),
		model: clip(row?.model, 80),
		fallback: row?.fallback === true,
		mode: clip(row?.mode, KEY_LIMIT),
		subject: clip(row?.subject)
	};
	const confidence = Number(row?.confidence);
	if (Number.isFinite(confidence)) entry.confidence = Math.min(1, Math.max(0, confidence));
	const requested = clip(row?.requestedModel, 80);
	if (requested !== '') entry.requestedModel = requested;
	const errorType = clip(row?.errorType, KEY_LIMIT);
	if (errorType !== '') entry.errorType = errorType;
	const latency = Number(row?.latency);
	if (Number.isFinite(latency) && latency >= 0) entry.latency = Math.round(latency);
	const recommendationId = clip(row?.recommendationId, 80);
	if (recommendationId !== '') entry.recommendationId = recommendationId;
	const skillId = clip(row?.skillId, 80);
	if (skillId !== '') entry.skillId = skillId;
	return entry;
}

/** 明细行（存储行与 wire 行同形；wire 只取其中已声明的字段）。 */
export function decisionEntryRow(row) { return entryOf(row); }

/** wire 形状：聚合行（去掉存储侧字段 id/sessionId/adoptedIds，只留面板需要的计量）。 */
export function publicDecisionStats(stats) {
	if (stats === null || stats === void 0) return null;
	const base = normalizeDecisionStats(stats, stats?.sessionId);
	return {
		total: base.total,
		byTask: base.byTask, byAction: base.byAction, byEffect: base.byEffect, bySource: base.bySource,
		byModel: base.byModel, byMode: base.byMode,
		fallback: base.fallback,
		errors: base.errors,
		latency: base.latency,
		offered: base.offered, adopted: base.adopted,
		offeredByTask: base.offeredByTask, adoptedByTask: base.adoptedByTask,
		startedAt: base.startedAt, updatedAt: base.updatedAt, lastAt: base.lastAt,
		decisionSeq: base.decisionSeq,
		last: base.last === null || base.last === void 0 ? null : entryOf(base.last)
	};
}

/** wire 形状：明细行（不含 sessionId 与任何正文）。 */
export function publicDecisionEntry(row) { return entryOf(row); }

/** 判定结果 → 明细行（元数据来自判定返回值，subject 由调用方按职责给出）。 */
export function decisionEntryFromAdvice(value, { taskType = 'risk-grade', subject = '', mode = '', at = Date.now(), seq = 0 } = {}) {
	const advice = value !== null && typeof value === 'object' ? value : {};
	const row = {
		seq: count(seq),
		kind: 'decision',
		at: count(at),
		taskType: decisionTaskOf(taskType),
		action: advice.action,
		effect: advice.effect,
		risk: advice.risk,
		objectClass: advice.objectClass,
		confidence: advice.confidence,
		source: advice.source,
		provider: advice.provider,
		model: advice.model,
		requestedModel: advice.requestedModel,
		fallback: advice.fallback === true,
		errorType: advice.errorType,
		latency: advice.latency,
		mode: text(advice.mode) !== '' ? advice.mode : mode,
		subject
	};
	return entryOf(row);
}

/** 推荐（offer）明细行：只记方法标题与职责，不记推荐正文。 */
export function decisionOfferEntry({ taskType = 'skill-activate', skillId = '', label = '', recommendationId = '', at = Date.now(), seq = 0 } = {}) {
	return entryOf({ seq, kind: 'offer', at, taskType: decisionTaskOf(taskType), subject: label !== '' ? label : skillId, skillId, recommendationId });
}

/** 采纳（adopt）明细行：recommendationId 关联到具体推荐。 */
export function decisionAdoptEntry({ taskType = 'skill-activate', skillId = '', label = '', recommendationId = '', at = Date.now(), seq = 0 } = {}) {
	return entryOf({ seq, kind: 'adopt', at, taskType: decisionTaskOf(taskType), subject: label !== '' ? label : skillId, skillId, recommendationId });
}

/** 是否为重复采纳（同一 recommendationId 只计一次；空 id 无法关联，返回 true 表示不该计）。 */
export function isDuplicateAdoption(stats, recommendationId) {
	const id = clip(recommendationId, 80);
	if (id === '') return true;
	return Array.isArray(stats?.adoptedIds) && stats.adoptedIds.includes(id);
}

/** 明细 → 聚合折叠（纯函数：返回新行，不改入参）。 */
export function foldDecisionStats(stats, row) {
	const at = count(row?.at) || Date.now();
	const next = normalizeDecisionStats(stats, row?.sessionId, at);
	const entry = entryOf(row);
	next.updatedAt = at;
	next.lastAt = at;
	/* seq 由调用方（store）在写行前按 stats.decisionSeq + 1 决定，行 id 与明细 seq 必须一致；
	   调用方没给就按同一公式推导，保证两者恒等。 */
	next.decisionSeq = count(stats?.decisionSeq) + 1;
	entry.seq = count(row?.seq) || next.decisionSeq;
	if (entry.kind === 'offer') {
		next.offered = next.offered + 1;
		next.offeredByTask = bump(next.offeredByTask, entry.taskType, DECISION_TASKS.length + 3);
	} else if (entry.kind === 'adopt') {
		next.adopted = next.adopted + 1;
		next.adoptedByTask = bump(next.adoptedByTask, entry.taskType, DECISION_TASKS.length + 3);
		const id = clip(row?.recommendationId, 80);
		if (id !== '' && !next.adoptedIds.includes(id)) next.adoptedIds = [...next.adoptedIds, id].slice(-ADOPTED_IDS);
	} else {
		next.total = next.total + 1;
		next.byTask = bump(next.byTask, entry.taskType, DECISION_TASKS.length + 3);
		next.byAction = bump(next.byAction, entry.action, DISTRIBUTION_KEYS);
		next.byEffect = bump(next.byEffect, entry.effect, DISTRIBUTION_KEYS);
		next.bySource = bump(next.bySource, entry.source, DISTRIBUTION_KEYS);
		next.byModel = bump(next.byModel, entry.model, MODEL_KEYS);
		if (entry.mode !== '') next.byMode = bump(next.byMode, entry.mode, MODE_KEYS);
		if (entry.fallback === true) {
			next.fallback = next.fallback + 1;
			next.errors = bump(next.errors, entry.errorType !== void 0 ? entry.errorType : 'unspecified', ERROR_KEYS);
		}
		if (entry.latency !== void 0) {
			const ms = entry.latency;
			next.latency = { count: next.latency.count + 1, sum: next.latency.sum + ms, max: Math.max(next.latency.max, ms), last: ms };
		}
		next.last = entry;
	}
	return next;
}

/** 判定入参 → 内容无关的 subject 短标签（host/tool/标题；不带查询串与正文）。 */
export function decisionSubjectOf(args, taskType) {
	const source = args !== null && typeof args === 'object' ? args : {};
	try {
		switch (decisionTaskOf(taskType)) {
			case 'scan-plan': {
				const entries = Array.isArray(source.plan?.entries) ? source.plan.entries : [];
				const first = entries[0]?.request?.url ?? '';
				return clip(entries.length === 0 ? '' : `${entries.length} 个请求${first === '' ? '' : ` · ${hostPathOf(first)}`}`);
			}
			case 'delegate':
				return clip(source.title ?? source.intentId ?? '');
			case 'browser-index': {
				/* 页面 observation 与 goal 都是可能含正文/密钥的自由文本，一律不落盘：只记候选数量。 */
				const candidates = Array.isArray(source.candidates) ? source.candidates.length : 0;
				return clip(`${candidates} 个候选`);
			}
			default: {
				const method = clip(source.method ?? 'GET', 12).toUpperCase();
				const target = hostPathOf(source.url ?? source.request?.url ?? '');
				return clip(target === '' ? method : `${method} ${target}`);
			}
		}
	} catch { return ''; }
}
