#!/bin/bash
# dsh web 启动脚本（幂等）——带优化特性开关 env 注入。
# 用法：bash ~/Software/dsh-src/scripts/start-dsh-web.sh
# 开关改这里（全部惰性求值，改完重跑本脚本生效）：
#   DSH_SRC_TELEMETRY=off|shadow|on   （默认 shadow：独立 JSONL，永不进 prompt）
#   DSH_SRC_STATE_VERSION=1|2         （默认 2：有界 summary；旧全量仅显式 detail=legacy）
#   DSH_SRC_ORCHESTRATOR=off|shadow|on（本轮只到 shadow）
#   DSH_SRC_ROUTE_V2=off|shadow|on    （灰度数据达标后才开）
#   DSH_SRC_LAYA_NEXT=off|shadow|on     （默认 off：生产不启用每轮 next-action 建议）
#   DSH_SRC_BASH_GATE=off|shadow|ask    （默认 ask：bash写/破坏性命令人工确认）
#   DSH_WEB_FORCE=1                     （默认 0：跳过空闲探测强推重启，仅在你确认无任务时用）
#
# [2026-10-18] web profile 已升到 dsh 0.2.1-rc.1：
#   - host 二进制改为 **profile 自带**的 node_modules/@deepseek-ai/dsh/lib/bin.js
#     （全局 `dsh` 仍是 0.1，只服务 headless 等未迁移 profile；不能用它起 web）；
#   - 0.2 的 Web UI 在根路径，`/management.html` 已不存在（404），就绪探针改为 GET / ；
#   - 0.2 回环也有鉴权：GET / 无 token 返回 401（=服务已监听），带 token 才 200。
set -u
export DSH_SRC_TELEMETRY="${DSH_SRC_TELEMETRY:-shadow}"
export DSH_SRC_STATE_VERSION="${DSH_SRC_STATE_VERSION:-2}"
export DSH_SRC_ORCHESTRATOR="${DSH_SRC_ORCHESTRATOR:-off}"
export DSH_SRC_ROUTE_V2="${DSH_SRC_ROUTE_V2:-off}"
export DSH_SRC_EVENT_STORE="${DSH_SRC_EVENT_STORE:-shadow}"
# 决策服务主开关/接口/key/模型在基础设施全局设置，以下LAYA命名env仅保留旧职责开关兼容。
# Jev仅作风险形态/简单分工/文档匹配提示；复杂决策和采纳由主模型负责。
# next-action/tool-advisory 不进生产主循环，风险审批硬闸仍保留。
export DSH_SRC_LAYA_TIMEOUT_MS="${DSH_SRC_LAYA_TIMEOUT_MS:-120000}"
export DSH_SRC_LAYA_NEXT="${DSH_SRC_LAYA_NEXT:-off}"
export DSH_SRC_BASH_GATE="${DSH_SRC_BASH_GATE:-ask}"
export DSH_SRC_LAYA_DELEGATE="${DSH_SRC_LAYA_DELEGATE:-on}"
export DSH_SRC_LAYA_SKILL="${DSH_SRC_LAYA_SKILL:-on}"
export DSH_SRC_LAYA_DECISION="${DSH_SRC_LAYA_DECISION:-on}"
export DSH_SRC_BROWSER_DECIDER_URL="${DSH_SRC_BROWSER_DECIDER_URL:-http://127.0.0.1:8791/v1/systemone}"

LOG=/tmp/dsh-web-latest.log
PIDFILE=/tmp/dsh-web.pid
PORT=3080

# 拒绝在已运行任务中重启；探测不可用时刻意 fail-closed（0.2 无 0.1 的单方法 RPC）。
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  if [ "${DSH_WEB_FORCE:-0}" = "1" ]; then
    echo "DSH_WEB_FORCE=1：跳过空闲探测直接重启" >&2
  else
    node "$SCRIPT_DIR/check-web-idle.mjs" || { echo "无法确认Web空闲，停止重启（确认无任务后可加 DSH_WEB_FORCE=1）" >&2; exit 1; }
  fi
fi
# Only stop the verified DSH listener. A stale PID file is not process identity.
OLD=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null | sort -u)
if [ -n "$OLD" ]; then
  COMMAND=$(ps -p "$OLD" -o command=)
  case "$COMMAND" in
    *dsh/lib/bin.js*web*) kill "$OLD" ;;
    *) echo "$PORT listener is not the expected DSH process; refusing to kill" >&2; exit 1 ;;
  esac
  for i in $(seq 1 40); do
    lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.25
  done
  if lsof -ti tcp:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "DSH did not stop; refusing overlapping startup" >&2; exit 1
  fi
fi

# local.106: browser-index decisions use the global Jev service. Do not auto-start
# or terminate unrelated legacy localdecide processes here; MCP execution is unchanged.

cd ~/.dsh/profiles/web
# A detached session survives the invoking terminal/agent process group closing.
# 0.2 host 只从本 profile 的 node_modules 起，避免把全局 0.1 dsh 拖进来。
NEW=$(node --input-type=module - "$LOG" "$PORT" <<'JS'
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const fd=openSync(process.argv[2],'w');
const host=join(homedir(),'.dsh/profiles/web/node_modules/@deepseek-ai/dsh/lib/bin.js');
const child=spawn(process.execPath,[host,'web','--no-open','--port',process.argv[3]],{detached:true,stdio:['ignore',fd,fd],env:process.env});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('spawn',()=>{console.log(child.pid);child.unref();closeSync(fd);});
JS
) || exit 1
echo "PID $NEW" > "$PIDFILE"
# 0.2：GET / 无 token ⇒ 401（服务在监听），带 token ⇒ 200。两者都算就绪。
CODE=000
for i in $(seq 1 60); do
  CODE=$(curl --max-time 2 -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/") || CODE=000
  [ "$CODE" = 200 ] || [ "$CODE" = 401 ] && break
  kill -0 "$NEW" 2>/dev/null || { echo "DSH exited during startup; see $LOG" >&2; exit 1; }
  sleep 0.5
done
[ "$CODE" = 200 ] || [ "$CODE" = 401 ] || { echo "DSH readiness timed out; see $LOG" >&2; exit 1; }
# 就绪之后还要确认装配完成：启动日志会打印带 token 的 UI 地址（插件行/预设都在此之前装好）。
TOKEN_URL=""
for i in $(seq 1 40); do
  TOKEN_URL=$(grep -o "http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*" "$LOG" | tail -1)
  [ -n "$TOKEN_URL" ] && break
  kill -0 "$NEW" 2>/dev/null || { echo "DSH exited during startup; see $LOG" >&2; exit 1; }
  sleep 0.5
done
[ -n "$TOKEN_URL" ] || { echo "DSH did not publish a UI token URL; see $LOG" >&2; exit 1; }
grep -c "disabling profile plugin row" "$LOG" | xargs -I{} echo "disabled_plugin_rows={}"
echo "event_store=$DSH_SRC_EVENT_STORE telemetry=$DSH_SRC_TELEMETRY state=$DSH_SRC_STATE_VERSION bash_gate=$DSH_SRC_BASH_GATE orch=$DSH_SRC_ORCHESTRATOR route_v2=$DSH_SRC_ROUTE_V2"
echo "$TOKEN_URL (HTTP $CODE, PID $NEW, log $LOG)"
