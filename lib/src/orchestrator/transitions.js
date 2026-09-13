// Orchestrator 状态机纯函数（optimization handbook Phase 3，§6.1）。
// shadow 模式只做迁移校验与建议计算，不执行任何状态写入；on 模式（宿主后台
// tick/lease）未实施，属基线文档「明确不做」。禁止工具直接写任意 status：
// 迁移合法性一律以本文件的 ALLOWED 表为准。
//
// 两个状态空间：
// - ACTUAL_STATUSES：src intents 落库枚举（store.js 现状，不得改动）。
// - SUGGESTED_STATUSES：shadow 建议态（queued/waiting-approval/orphaned/recovered），
//   只出现在建议事件与报表中，永不写回 intents 表。

export const ACTUAL_STATUSES = Object.freeze([
	"planned", "running", "completed", "blocked", "failed", "deprecated"
]);

export const SUGGESTED_STATUSES = Object.freeze([
	"queued", "waiting-approval", "orphaned", "recovered"
]);

/** 手册 §6.1 状态机（deprecated 终态沿用现状枚举；非法迁移一律拒绝）。 */
const ALLOWED = Object.freeze({
	planned: ["queued", "blocked"],
	queued: ["running", "blocked"],
	running: ["waiting-approval", "queued", "completed", "failed", "orphaned"],
	"waiting-approval": ["queued", "blocked"],
	orphaned: ["recovered", "failed"],
	recovered: ["queued"],
	completed: [],
	blocked: [],
	failed: [],
	deprecated: []
});

/** 迁移合法性：from/to 均须在状态机表内；返回 null=合法，否则给违规原因。 */
export function transitionViolation(from, to) {
	if (!Object.hasOwn(ALLOWED, String(from))) return `unknown from-status "${from}"`;
	if (!Object.hasOwn(ALLOWED, String(to))) return `unknown to-status "${to}"`;
	if (from === to) return `self-transition "${from}" is a no-op`;
	if (!ALLOWED[from].includes(to)) return `"${from}" → "${to}" is not allowed (allowed: ${ALLOWED[from].join(", ") || "none"})`;
	return null;
}

/** 合法性快捷判断（测试与报表用）。 */
export function canTransition(from, to) {
	return transitionViolation(from, to) === null;
}
