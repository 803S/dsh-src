#!/bin/bash
# dsh web 启动脚本（幂等）——带优化特性开关 env 注入。
# 用法：bash ~/Software/dsh-src/scripts/start-dsh-web.sh
# 开关改这里（全部惰性求值，改完重跑本脚本生效）：
#   DSH_SRC_TELEMETRY=off|shadow|on   （默认 shadow：独立 JSONL，永不进 prompt）
#   DSH_SRC_STATE_VERSION=1|2         （默认 1，A/B 后再翻 2）
#   DSH_SRC_ORCHESTRATOR=off|shadow|on（本轮只到 shadow）
#   DSH_SRC_ROUTE_V2=off|shadow|on    （灰度数据达标后才开）
#   DSH_SRC_EVENT_STORE=off|shadow|on （§10 事件落盘，local.77）
set -u
export DSH_SRC_TELEMETRY="${DSH_SRC_TELEMETRY:-shadow}"
export DSH_SRC_STATE_VERSION="${DSH_SRC_STATE_VERSION:-1}"
export DSH_SRC_ORCHESTRATOR="${DSH_SRC_ORCHESTRATOR:-off}"
export DSH_SRC_ROUTE_V2="${DSH_SRC_ROUTE_V2:-off}"
export DSH_SRC_EVENT_STORE="${DSH_SRC_EVENT_STORE:-shadow}"

LOG=/tmp/dsh-web-latest.log
PIDFILE=/tmp/dsh-web.pid

# 幂等：旧进程在就杀掉（仅限本脚本拉起的）
if [ -f "$PIDFILE" ]; then
  OLD=$(sed 's/PID //' "$PIDFILE" 2>/dev/null)
  [ -n "${OLD:-}" ] && kill "$OLD" 2>/dev/null && sleep 1
fi
# 兜底：3080 端口残留进程
lsof -ti tcp:3080 2>/dev/null | xargs kill 2>/dev/null; sleep 1

cd ~/.dsh/profiles/web
nohup dsh web > "$LOG" 2>&1 &
NEW=$!
echo "PID $NEW" > "$PIDFILE"
sleep 4
CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3080/management.html)
echo "event_store=$DSH_SRC_EVENT_STORE telemetry=$DSH_SRC_TELEMETRY state=$DSH_SRC_STATE_VERSION orch=$DSH_SRC_ORCHESTRATOR route_v2=$DSH_SRC_ROUTE_V2"
echo "http://localhost:3080/management.html -> $CODE (PID $NEW, log $LOG)"
