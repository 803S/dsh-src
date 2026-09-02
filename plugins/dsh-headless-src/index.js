/**
 * @lihua_dis/dsh-headless-src — headless 单发 runner（src-hunter 预设版）。
 *
 * 与 @deepseek-ai/dsh-headless 的差异只有一处：agent 工厂 setup 里先
 * agentPresets.mount(agentCtx, preset)（默认 "src-hunter"），让 src_* 工具、
 * src:protocol 系统提示词和 persona 随预设挂载到 agent 作用域。
 * 其余（任务驱动/汇总/退出码）逐字照抄 dsh-headless。
 *
 * @deepseek-ai/* 依赖不在本包声明（profile 无 registry 可拉），运行时用
 * 绝对路径动态 import 全局 dsh 安装内的模块。
 */
import { randomUUID } from "node:crypto";

/** 全局 dsh 安装里的 @deepseek-ai 包根（pnpm global）。 */
const DSH_AI = "/Users/lihua-dis/Library/pnpm/global/v11/49f9775095df6513e8ea2f08355f3462023a1e0be26574192d0f5326d06d8439/node_modules/@deepseek-ai";

/** Stable Cordis plugin name. */
export const name = "headless-src-runner";

/** Core services required before the one-shot turn can start. */
export const inject = [
	"agentDefaultModel",
	"agents",
	"sessions",
	"agentPresets"
];

/** The process streams the runner writes to; tests substitute captures. */
const internals = {
	stdout: process.stdout,
	stderr: process.stderr
};

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events, firstSeq) {
	let started = false;
	let text = "";
	let reason;
	for (const event of events) {
		if (event.seq < firstSeq) continue;
		if (event.type === "turn/start") {
			started = true;
			continue;
		}
		if (!started) continue;
		if (event.type === "assistant/message") {
			const joined = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
			if (joined !== "") text = joined;
		}
		if (event.type === "turn/end") reason = event.data.reason;
	}
	return {
		text,
		reason
	};
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io, error) {
	io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
	io.exit(1);
}

/**
 * Run one task through a freshly created Agent (composed on the given preset)
 * and request process exit.
 * @param ctx - plugin context carrying the Agent, default model, Session,
 * agentPresets services, and launcher IO.
 * @param config - validated task config ({ task, preset }).
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	const presets = ctx.get("agentPresets");
	if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;
	const [{ installModelSelection }, { createUserMessage }, { SessionId }] = await Promise.all([
		import(`${DSH_AI}/dsh-agent/lib/index.js`),
		import(`${DSH_AI}/dsh-llm/lib/index.js`),
		import(`${DSH_AI}/dsh-session/lib/index.js`)
	]);
	const selection = defaultModel.currentSelection();
	const { agent } = await agents.create({
		sessionId: SessionId(`session-${randomUUID()}`),
		meta: { cwd: process.cwd() },
		agentOptions: {
			provider: selection.provider,
			model: selection.model
		},
		setup: async (agentCtx) => {
			if (presets !== void 0 && config.preset !== void 0 && config.preset !== "") {
				await presets.mount(agentCtx, config.preset);
			}
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
		}
	});
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	agent.followup(createUserMessage({
		content: [{
			type: "text",
			text: config.task
		}],
		source: { kind: "user" }
	}));
	await agent.whenIdle();
	await sessions.flush(agent.session);
	const outcome = summarize(agent.session.events, firstSeq);
	io.stdout.write(outcome.text + "\n");
	if (outcome.reason?.kind === "error") io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
	io.exit(outcome.reason?.kind === "completed" ? 0 : 1);
}

/**
 * Mount the one-shot direct driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - task config from the profile patch ({ task, preset }).
 */
export function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("headless-src-runner: the launcher must provide ctx.appExit before the tree mounts");
	const io = {
		stdout: internals.stdout,
		stderr: internals.stderr,
		exit
	};
	run(ctx, config ?? {}, io).catch((error) => {
		fail(io, error);
	});
}
