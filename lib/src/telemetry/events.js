// Telemetry emitter (optimization handbook Phase 1).
// createTelemetry: fire-and-forget emit with budgeted rows; failures are
// swallowed so telemetry can never block a tool path（含 budgetEvent 阶段：
// 循环引用等序列化异常也必须吞掉）。
// createDefaultTelemetry: flag-aware wiring used by tool registration
// (DSH_SRC_TELEMETRY=off|shadow|on, default shadow; lazy env read)。
// flushDefaultTelemetry: 测试/诊断用——await 所有默认实例的在途写入，保证
// emit 后立即读 JSONL 不竞态。

import { randomUUID } from "node:crypto";
import { promises as fsPromises } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { budgetEvent, TELEMETRY_MAX_EVENT_BYTES } from "./budget.js";
import { createJsonlSink } from "./sink.js";
import { srcTelemetryFlag, srcLayaDecisionFlag, srcLayaDelegateFlag, srcLayaSkillFlag } from "../flags.js";

export function createTelemetry({ sink, clock = { now: () => Date.now() }, randomId = randomUUID, enabled = () => true, maxEventBytes = TELEMETRY_MAX_EVENT_BYTES } = {}) {
	const pending = new Set();
	return {
		/** Fire-and-forget. Returns the row id ("" when disabled). Never throws. */
		emit(event, context = {}, payload = {}) {
			if (!enabled() || sink === void 0) return "";
			let row;
			try {
				row = budgetEvent({
					id: randomId(),
					event,
					occurredAt: clock.now(),
					schemaVersion: 1,
					...context,
					sessionId: context.sessionId ?? "",
					engagementId: context.engagementId ?? context.sessionId ?? "",
					payload
				}, maxEventBytes);
			} catch {
				return "";
			}
			const write = Promise.resolve(sink.append(row)).catch(() => undefined);
			pending.add(write);
			write.finally(() => pending.delete(write)).catch(() => undefined);
			return row.id;
		},
		/** Test/diagnostic hook: await all in-flight writes. */
		async flush() {
			await Promise.allSettled([...pending]);
		},
		stats: () => sink?.stats?.() ?? { errors: 0, writes: 0 }
	};
}

/** 与 approval-locks/burp bridge 同约定：DSH_HOME 优先，缺省 ~/.dsh（惰性求值）。 */
export const dshHomeDir = () => {
	const raw = (process.env.DSH_HOME ?? "").trim();
	return raw !== "" ? nodePath.resolve(raw) : nodePath.join(nodeOs.homedir(), ".dsh");
};

/** Lazy telemetry data dir: env override or $DSH_HOME/storages/src-telemetry.
 * 测试 harness 在模块加载时把 DSH_HOME 指向临时目录，telemetry 因此自动隔离，
 * 不再直接落真实 ~/.dsh。 */
export const srcTelemetryDir = () => (process.env.DSH_SRC_TELEMETRY_DIR ?? "").trim() !== ""
	? process.env.DSH_SRC_TELEMETRY_DIR.trim()
	: nodePath.join(dshHomeDir(), "storages", "src-telemetry");

const defaultInstances = new Set();

/** Flag-aware default telemetry used by tool registration (default: shadow).
 * dir 传 thunk：env 在每次写入时惰性解析，测试改 env 不受创建时机影响。 */
export function createDefaultTelemetry() {
	const instance = createTelemetry({
		enabled: () => srcTelemetryFlag() !== "off",
		sink: createJsonlSink({ dir: srcTelemetryDir, fs: fsPromises })
	});
	defaultInstances.add(instance);
	return instance;
}

/** Await every in-flight write of all default instances (test hook). */
export async function flushDefaultTelemetry() {
	await Promise.allSettled([...defaultInstances].map((instance) => instance.flush()));
}

/** [local.90] Laya 决策事件：仅在对应 taskType 的 shadow/on 模式下由 laya-client 上报，供影子分析与调阈值。
 * payload: {action, confidence, riskScore, method, host, path, taskType} */
export function emitLayaDecision(telemetry, exec, payload = {}) {
	const taskType = String(payload.taskType ?? "risk-grade");
	const flagOf = { "risk-grade": srcLayaDecisionFlag, delegate: srcLayaDelegateFlag, skill: srcLayaSkillFlag };
	const flagReader = flagOf[taskType] ?? srcLayaDecisionFlag;
	if (flagReader() === "off") return "";
	const sessionId = exec?.agent?.session?.id ?? "";
	return telemetry.emit("laya.decision", { sessionId }, payload);
}
