// Telemetry JSONL sink (optimization handbook Phase 1).
// 写独立文件（每日一个 JSONL），永不注入 prompt/工具返回。append 永不 throw：
// telemetry 属观测旁路，任何失败只进内部错误计数，不影响工具路径。
// dir 支持传函数（惰性求值）：env 覆盖必须惰性读取（local.54 教训），
// 且 mkdir promise 按目录值缓存——目录切换（测试隔离/DSH_HOME 变更）自动重探。

export function createJsonlSink({ dir, clock = { now: () => Date.now() }, fs }) {
	if (typeof dir !== "string" && typeof dir !== "function") throw new Error("createJsonlSink requires dir (string or lazy thunk)");
	let readyDir;
	let dirReady;
	let errors = 0;
	let writes = 0;
	const append = async (row) => {
		try {
			const base = (typeof dir === "function" ? dir() : dir).replace(/\/$/, "");
			if (base === "") throw new Error("telemetry sink dir is empty");
			if (base !== readyDir || dirReady === void 0) {
				dirReady = fs.mkdir(base, { recursive: true });
				readyDir = base;
			}
			await dirReady;
			const day = new Date(clock.now()).toISOString().slice(0, 10);
			await fs.appendFile(`${base}/src-telemetry-${day}.jsonl`, `${JSON.stringify(row)}\n`, "utf8");
			writes += 1;
		} catch {
			errors += 1;
		}
	};
	return {
		append,
		stats: () => ({ errors, writes })
	};
}
