"""Local feasibility fixture, not production approval policy. No real Jev calls."""
import json
import os
from mitmproxy import http
HOST = "127.0.0.1"
PORT = int(os.environ["SRC_FIXTURE_TLS_PORT"])
LOG = os.environ["SRC_FIXTURE_MITM_LOG"]

def request(flow: http.HTTPFlow):
    r = flow.request
    permitted = r.scheme == "https" and r.host == HOST and r.port == PORT
    readable = r.method == "GET" and r.path in ("/read", "/redirect")
    compute = r.method == "POST" and r.path == "/compute" and r.get_text(strict=False) == '{"x":1}'
    allow = permitted and (readable or compute)
    with open(LOG, "a") as f:
        f.write(json.dumps({"method": r.method, "url": r.pretty_url, "body": r.get_text(strict=False), "allow": allow}) + "\n")
    if not allow:
        flow.response = http.Response.make(403, b"FIXTURE_BLOCKED_NOT_SENT", {"content-type": "text/plain", "x-fixture-gateway": "not-sent"})
