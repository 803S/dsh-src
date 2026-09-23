// lib/src/decision/skill-recall.js
// Skill Selector 的规则层召回：把「agent 即将动手/委派」的上下文，
// 收敛成 ≤5 个带真实分数的候选 skill，再交由 layaDecide 语义排序。
// 纯函数，无 IO。
//
// 召回信号优先级：
// ① 审批分类（classifyHttpRequest 的 category）是强意图信号——
//    「越权删改」「未授权删改」本身就是技能提醒的触发条件，直连对应 route；
// ② 放行请求回落到 scoreRoutes 的 terms 匹配（graphql/js/上传/ssrf 等关键词）。
// scoreRoutes 对裸 REST 路径（如 /api/user/1002/profile，无术语词）是零分，
// 此时静默（返回 []，不调 Laya）——规则层认不出意图就不打扰模型。

import { scoreRoutes, buildSkillManifest } from "../playbooks.js";

// 审批分类 → playbook route 直连（强信号，score=10）
const CATEGORY_ROUTES = {
	"破坏性写入": ["business-logic"],
	"越权删改": ["authorization"],
	"未授权删改": ["authentication", "authorization"],
};

// 能力 skill 的召回关键词：把 capabilities.yaml 的 when 短句压成触发词。
// 阈值规则：单字/双字母缩写（mp/src/app）一律禁用，防止子串误伤（如 profile 命中 mp）。
const CAPABILITY_SKILLS = [
	{ id: "wx-minapp-recon", keywords: ["小程序", "wxapkg", "微信小程序", "mini-program", "miniapp"] },
	{ id: "droidasc", keywords: ["android", "apk", "安卓", "移动端客户端", "app 逆向"] },
	{ id: "wechat-mp-reader", keywords: ["公众号", "微信文章", "wechat", "mp.weixin"] },
	{ id: "src-rules-scraper", keywords: ["厂商规则", "src 规则", "测试范围", "奖励标准"] },
	{ id: "clown-src-playbook", keywords: [] }, // playbooks.js 已覆盖
];

/**
 * 召回当前上下文相关的 skill 候选（最多 maxCandidates 个，按分数降序）。
 * @param {{ method: string, path: string, query?: string, body?: string, category?: string, goalTarget?: string, assetTypes?: string[] }} ctx
 * @param {number} [maxCandidates=5]
 * @returns {{ id:string, kind:"route", score:number, matchedBy:string[], doc:string, title:string }[]}
 */
export function recallRouteCandidates(ctx, maxCandidates = 5) {
	const { method, path, query = "", body = "", category = "放行", goalTarget = "" } = ctx;
	const manifest = buildSkillManifest();
	const docIndex = new Map(manifest.map((m) => [m.id, m]));
	const byId = (id, score, matchedBy) => {
		const meta = docIndex.get(id) ?? { title: id, docs: [] };
		return { id, kind: "route", score, matchedBy, doc: meta.docs[0] ?? "", title: meta.title ?? id };
	};
	// ① 审批分类是强信号：越权/未授权写直连对应 route
	const mapped = CATEGORY_ROUTES[category] ?? [];
	if (mapped.length > 0) {
		return mapped.slice(0, maxCandidates).map((id) => byId(id, 10, [`category:${category}`]));
	}
	// ② 放行请求回落 terms 匹配（graphql/js/上传/ssrf 等关键词）——注意 scoreRoutes 返回字段是 key（非 id）
	const scored = scoreRoutes(`${method} ${path}`, `${query} ${body} ${goalTarget}`);
	return scored
		.filter((c) => c.score > 0)
		.slice(0, maxCandidates)
		.map((c) => byId(c.key, c.score, c.matched));
}

/**
 * 召回与当前上下文匹配的能力 skill（capabilities.yaml 的 kind=skill 条目）。
 * 纯关键词命中，无模型开销。
 */
export function recallCapabilityCandidates(ctx) {
	const haystack = `${ctx.method} ${ctx.path} ${ctx.query ?? ""} ${ctx.body ?? ""} ${ctx.goalTarget ?? ""} ${(ctx.assetTypes ?? []).join(" ")}`.toLowerCase();
	return CAPABILITY_SKILLS.filter((s) =>
		s.keywords.length > 0 && s.keywords.some((kw) => haystack.includes(kw.toLowerCase()))
	).map((s) => ({ id: s.id, kind: "capability", score: 1, matchedBy: [], doc: "", title: s.id }));
}

/** 合并并去重，按分数降序取 topN。 */
export function recallCandidates(ctx, maxCandidates = 5) {
	const route = recallRouteCandidates(ctx, maxCandidates);
	const cap = recallCapabilityCandidates(ctx);
	const seen = new Set(route.map((c) => c.id));
	const merged = [...route];
	for (const c of cap) {
		if (!seen.has(c.id)) { merged.push(c); seen.add(c.id); }
	}
	merged.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	return merged.slice(0, maxCandidates);
}

/** 提醒行：≤1 行，随 src_http 工具返回值返回（仅 on 模式且过闸后）。 */
export function skillReminderLine(picked) {
	const kindLabel = picked.kind === "capability" ? "能力" : "方法论";
	const docHint = picked.doc ? `（${picked.id}: ${picked.doc}）` : `（${picked.id}）`;
	return `💡 技能提醒：本请求可参考 ${kindLabel} ${picked.title}${docHint}`;
}

/** 每会话提醒去重注册表（纯内存，dsh 重启重置） */
export function createSkillReminderRegistry() {
	/** @type {Map<string, Set<string>>} sessionId → 已提醒的 skill id */
	const reminded = new Map();
	/** @type {Map<string, Set<string>>} sessionId → 已读的 skill id */
	const read = new Map();

	return {
		canRemind(sessionId, skillId) {
			if (!reminded.has(sessionId)) return true;
			return !reminded.get(sessionId).has(skillId);
		},
		markReminded(sessionId, skillId) {
			if (!reminded.has(sessionId)) reminded.set(sessionId, new Set());
			reminded.get(sessionId).add(skillId);
		},
		markRead(sessionId, skillId) {
			if (!read.has(sessionId)) read.set(sessionId, new Set());
			read.get(sessionId).add(skillId);
		},
		isRead(sessionId, skillId) {
			return read.has(sessionId) && read.get(sessionId).has(skillId);
		},
		/** 已提醒数（调试） */
		size(sessionId) { return reminded.get(sessionId)?.size ?? 0; },
	};
}
