#!/bin/bash
# dsh web 启动脚本（幂等）——带优化特性开关 env 注入。
# 用法：bash ~/Software/dsh-src/scripts/start-dsh-web.sh
# 开关改这里（全部惰性求值，改完重跑本脚本生效）：
#   DSH_SRC_TELEMETRY=off|shadow|on   （默认 shadow：独立 JSONL，永不进 prompt）
#   DSH_SRC_STATE_VERSION=1|2         （默认 1，A/B 后再翻 2）
#   DSH_SRC_ORCHESTRATOR=off|shadow|on（本轮只到 shadow）
#   DSH_SRC_ROUTE_V2=off|shadow|on    （灰度数据达标后才开）
#   DSH_SRC_LAYA_NEXT=off|shadow|on     （默认 off：生产不启用每轮 next-action 建议）
set -u
export DSH_SRC_TELEMETRY="${DSH_SRC_TELEMETRY:-shadow}"
export DSH_SRC_STATE_VERSION="${DSH_SRC_STATE_VERSION:-1}"
export DSH_SRC_ORCHESTRATOR="${DSH_SRC_ORCHESTRATOR:-off}"
export DSH_SRC_ROUTE_V2="${DSH_SRC_ROUTE_V2:-off}"
export DSH_SRC_EVENT_STORE="${DSH_SRC_EVENT_STORE:-shadow}"
# 决策服务主开关/接口/key/模型在基础设施全局设置，以下LAYA命名env仅保留旧职责开关兼容。
# Jev仅作风险形态/简单分工/文档匹配提示；复杂决策和采纳由主模型负责。
# next-action/tool-advisory 不进生产主循环，风险审批硬闸仍保留。
export DSH_SRC_LAYA_TIMEOUT_MS="${DSH_SRC_LAYA_TIMEOUT_MS:-120000}"
export DSH_SRC_LAYA_NEXT="${DSH_SRC_LAYA_NEXT:-off}"
export DSH_SRC_LAYA_DELEGATE="${DSH_SRC_LAYA_DELEGATE:-on}"
export DSH_SRC_LAYA_SKILL="${DSH_SRC_LAYA_SKILL:-on}"
export DSH_SRC_LAYA_DECISION="${DSH_SRC_LAYA_DECISION:-on}"
export DSH_SRC_BROWSER_DECIDER_URL="${DSH_SRC_BROWSER_DECIDER_URL:-http://127.0.0.1:8791/v1/systemone}"

LOG=/tmp/dsh-web-latest.log
PIDFILE=/tmp/dsh-web.pid

# 拒绝在已运行任务中重启；API失败也不能把SPA的HTTP200当空闲。
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if lsof -ti tcp:3080 -sTCP:LISTEN >/dev/null 2>&1; then
  node "$SCRIPT_DIR/check-web-idle.mjs" || { echo "无法确认Web空闲，停止重启" >&2; exit 1; }
fi
# 幂等：旧进程在就杀掉（仅限本脚本拉起的）
if [ -f "$PIDFILE" ]; then
  OLD=$(sed 's/PID //' "$PIDFILE" 2>/dev/null)
  [ -n "${OLD:-}" ] && kill "$OLD" 2>/dev/null && sleep 1
fi
# 兜底：3080 端口残留进程
lsof -ti tcp:3080 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null; sleep 1

# local.106: browser-index decisions use the global Jev service. Do not auto-start
# or terminate unrelated legacy localdecide processes here; MCP execution is unchanged.

cd ~/.dsh/profiles/web
nohup dsh web > "$LOG" 2>&1 &
NEW=$!
echo "PID $NEW" > "$PIDFILE"
sleep 4
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3080/management.html)
echo "event_store=$DSH_SRC_EVENT_STORE telemetry=$DSH_SRC_TELEMETRY state=$DSH_SRC_STATE_VERSION orch=$DSH_SRC_ORCHESTRATOR route_v2=$DSH_SRC_ROUTE_V2"
echo "http://localhost:3080/management.html -> $CODE (PID $NEW, log $LOG)"
