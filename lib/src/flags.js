// dsh-src 优化特性开关（docs/optimization-implementation-handbook-2026-09-12.md Phase 0）。
// 纪律：所有读取一律惰性求值（每次调用现场读 env）——模块级 const 会在 import 时固化，
// 测试或运行时后续设置的 env 将失效（2026-08-23 MEMORY 教训：环境变量覆盖必须惰性求值）。
// 非法值一律回落默认（不打断工具注册）；开关只控制行为增强，关闭时路径与 local.69 完全一致。

const VALID = Object.freeze({
	DSH_SRC_TELEMETRY: ["off", "shadow", "on"],
	DSH_SRC_STATE_VERSION: ["1", "2"],
	DSH_SRC_ORCHESTRATOR: ["off", "shadow", "on"],
	DSH_SRC_ROUTE_V2: ["off", "shadow", "on"],
	DSH_SRC_EVENT_STORE: ["off", "shadow", "on"],
	DSH_SRC_SURVEY: ["off", "shadow", "on"]
});

const DEFAULTS = Object.freeze({
	// telemetry 默认 shadow：只写独立 JSONL sink，永不进 prompt/工具返回；失败只计数不打断。
	DSH_SRC_TELEMETRY: "shadow",
	// state 视图默认 legacy（v1）：v2 决策视图经 detail="summary" 或本 flag=2 显式启用；
	// 手册 §7 的「默认 v2」与 §13.1 灰度（先 10%）矛盾，按灰度原则默认 1，A/B 后再翻。
	DSH_SRC_STATE_VERSION: "1",
	// orchestrator 本轮只落 shadow（纯函数 planner/建议）；on 模式需 host 后台 tick 钩子，未实施。
	DSH_SRC_ORCHESTRATOR: "off",
	// router v2：off=沿用 substring 召回；shadow=额外计算 v2 候选写 telemetry，不改变选择；
	// on=v2 候选接管选择（灰度数据达标后才开）。
	DSH_SRC_ROUTE_V2: "off",
	// §10 事件落盘（local.77）：off=零新增表写入，行为与当前完全一致；shadow=领域写入先 append
	// src_events 旁账（幂等键去重）但不变更读取路径；on=另跑双折叠校验（divergence 经 telemetry 旁路）。
	DSH_SRC_EVENT_STORE: "off",
	// Phase 7 测绘种子闭环（local.81）：off=工具不注册，行为与当前完全一致；shadow/on 注册 src_survey_seed。
	DSH_SRC_SURVEY: "off"
});

function readFlag(name) {
	const raw = String(process.env[name] ?? "").trim().toLowerCase();
	if (raw === "") return DEFAULTS[name];
	return VALID[name].includes(raw) ? raw : DEFAULTS[name];
}

export const srcTelemetryFlag = () => readFlag("DSH_SRC_TELEMETRY");
export const srcStateVersionFlag = () => readFlag("DSH_SRC_STATE_VERSION");
export const srcOrchestratorFlag = () => readFlag("DSH_SRC_ORCHESTRATOR");
export const srcRouteV2Flag = () => readFlag("DSH_SRC_ROUTE_V2");
export const srcEventStoreFlag = () => readFlag("DSH_SRC_EVENT_STORE");
export const srcSurveyFlag = () => readFlag("DSH_SRC_SURVEY");

/** 测试辅助：恢复全部默认（删除进程内覆盖）。 */
export function resetFlagsForTests() {
	for (const name of Object.keys(DEFAULTS)) delete process.env[name];
}
