#!/usr/bin/env python3
"""
Laya 决策守护进程（HTTP 服务）
- 加载 Laya 模型（离线模式，启动约 1s）
- 监听 127.0.0.1:3166（可配置）提供 /health 和 /decide 接口
- 失败时 fail-open：返回 503 让调用方降级到原有流程

用法：
    cd ~/models/laya
    source laya-env/bin/activate
    export HF_HOME=/Users/lihua-dis/models/laya/hf_cache
    export HF_HUB_OFFLINE=1
    python3 scripts/laya-decision-daemon.py
"""
import os
import sys
import json
import http.server
import socketserver
import threading

# 加载 laya-mlx
os.environ.setdefault("HF_HOME", "/Users/lihua-dis/models/laya/hf_cache")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

import laya_mlx as laya

MODEL_ID = "aac6fef/laya-multilingual-mlx"
PORT = int(os.getenv("DSH_SRC_LAYA_PORT", "3166"))

print(f"[laya-daemon] Loading model {MODEL_ID} ...", flush=True)
try:
    agent = laya.load(MODEL_ID, compile=True, cache_prompts=True)
    print("[laya-daemon] Model loaded.", flush=True)
    _loaded = True
except Exception as e:
    print(f"[laya-daemon] WARNING: model load failed: {e}", flush=True)
    agent = None
    _loaded = False

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            resp = {"ok": _loaded, "model": MODEL_ID if _loaded else None}
            self._send_json(resp)
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/decide":
            self.send_error(404)
            return
        if not _loaded or agent is None:
            self.send_error(503, "Laya model not loaded")
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            text = payload.get("text", "")
            schema = payload.get("schema", {})
            # Laya 只接受特定结构：{name: {type, instructions, criteria}}
            norm_schema = {}
            for k, v in schema.items():
                if isinstance(v, dict) and "type" in v and "instructions" in v and "criteria" in v:
                    norm_schema[k] = v
            result = agent.predict(text, norm_schema)
            self._send_json({"answers": result["answers"]})
        except Exception as e:
            self.send_error(400, str(e))

    def _send_json(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def log_message(self, format, *args):
        pass  # 关掉默认 stderr 日志

with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"[laya-daemon] Listening on http://127.0.0.1:{PORT}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[laya-daemon] Shutting down.", flush=True)
