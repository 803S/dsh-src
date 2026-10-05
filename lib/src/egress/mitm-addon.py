"""Exact-request egress adapter. All errors deny; no policy or human approval here.
Launch only with private immutable configuration, lazy connections, no upstream
certificate sniffing, HTTP/1 only, rawtcp disabled, and no passthrough hosts.
"""
import asyncio
import base64
import hashlib
from http.client import HTTPConnection
import json
import ipaddress
import os
import re
import socket
from mitmproxy import ctx, exceptions, http

# Kept in sync with timing.js by the cross-language timeout contract test.
RESPONSE_SLOT_WAIT_SECONDS = 125
CONTROL_TIMEOUT_SECONDS = 125
MAX_BODY = 65536
MAX_RESPONSE = 8 * 1024 * 1024
# Waiting clients buffer at most a 64KiB request each. Only four requests may
# enter the upstream/response-buffering phase (8MiB per response).
MAX_CLIENTS = 32
CLIENTS = set()
DRAINING = {}
RESPONSE_SLOTS = asyncio.Semaphore(4)
SOCKET = os.environ["SRC_GATE_CONTROL_SOCKET"]
TOKEN = os.environ["SRC_GATE_CONTROL_TOKEN"]

class UnixConnection(HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)

class GateDenied(ValueError):
    def __init__(self, code, details):
        super().__init__(code)
        candidate = details.get("approvalId", "")
        self.approval_id = candidate if isinstance(candidate, str) and re.fullmatch(r"approval-\d+", candidate) else None
        self.scope = details.get("kind") == "scope"
        self.rejected = details.get("state") in ("denied", "rejected")

def control(endpoint, value):
    conn = UnixConnection("localhost", timeout=CONTROL_TIMEOUT_SECONDS)
    try:
        conn.request("POST", endpoint, json.dumps(value), {
            "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"
        })
        response = conn.getresponse()
        body = response.read(8193)
        if len(body) > 8192:
            raise ValueError("control rejected")
        value = json.loads(body)
        if response.status != 200:
            code = value.get("error", "") if isinstance(value, dict) else ""
            raise GateDenied(code if re.fullmatch(r"SRC_GATE_[A-Z_]+", code) else "SRC_GATE_CONTROL_FAILURE", value if isinstance(value, dict) else {})
        return value
    finally:
        conn.close()

def configure(updated):
    o = ctx.options
    if (o.connection_strategy != "lazy" or o.upstream_cert or o.http2 or o.rawtcp
            or o.ignore_hosts or o.tcp_hosts or o.ssl_insecure or o.mode != ["regular"]
            or o.stream_large_bodies is not None or o.body_size_limit != "8m"):
        raise exceptions.OptionsError("SRC gate requires strict immutable HTTP/1 inspection settings")

def client_connected(client):
    # Connections and response buffers have separate bounds.
    if len(CLIENTS) >= MAX_CLIENTS:
        client.error = "SRC_GATE_CONNECTION_CAPACITY"
    else:
        CLIENTS.add(client.id)

def client_disconnected(client):
    CLIENTS.discard(client.id)
    flow = DRAINING.pop(client.id, None)
    if flow is not None:
        release_slot(flow)

def deny(flow, reason="SRC_GATE_POLICY_DENIED", details=None):
    reason = reason if re.fullmatch(r"SRC_GATE_[A-Z_]+", reason) else "SRC_GATE_ADAPTER_FAILURE"
    body = b"SRC_GATE_BLOCKED_NOT_SENT"
    if isinstance(details, GateDenied) and details.approval_id:
        action = "User rejected this operation. Stop; do not retry or switch channels." if details.rejected else "Wait for the user to handle the pending approval. Do not repeat requests."
        kind = "scope confirmation (not traffic authorization)" if details.scope else "request approval"
        body += f"\n{reason}\n{kind}: {details.approval_id}\n{action}".encode("utf-8")
    flow.response = http.Response.make(403, body, {
        "content-type": "text/plain", "x-src-gate": "not-sent", "x-src-gate-reason": reason
    })

def requestheaders(flow):
    flow.request.stream = False
    lengths = flow.request.headers.get_all("content-length")
    # Chunked request framing was already forbidden by canonicalRequest. Reject
    # before buffering now that the global cap accommodates larger responses.
    if flow.request.headers.get_all("transfer-encoding") or len(lengths) > 1:
        deny(flow, "SRC_GATE_UNSUPPORTED_HEADERS")
    elif lengths and (not re.fullmatch(r"[0-9]+", lengths[0]) or len(lengths[0]) > 10 or int(lengths[0]) > MAX_BODY):
        deny(flow, "SRC_GATE_BODY_LIMIT")
    if flow.request.http_version not in ("HTTP/1.0", "HTTP/1.1"):
        deny(flow)

async def request(flow):
    if flow.response is not None:
        return
    request = flow.request
    body = request.raw_content
    if body is None or len(body) > MAX_BODY:
        deny(flow)
        return
    try:
        # Client-hop persistence preferences are not origin operation headers.
        # Strip only a single benign token before BOTH review and forwarding.
        # Never honor Connection header nominations or protocol upgrades.
        for name in ("proxy-connection", "connection"):
            hop = request.headers.get_all(name)
            if hop:
                if len(hop) != 1 or hop[0].lower() not in ("keep-alive", "close"):
                    raise ValueError("SRC_GATE_UNSUPPORTED_HEADERS")
                del request.headers[name]
        value = {
            "url": request.url, "method": request.method,
            "headers": list(request.headers.items(multi=True)),
            "bodyBase64": base64.b64encode(body).decode("ascii")
        }
        await asyncio.wait_for(RESPONSE_SLOTS.acquire(), timeout=RESPONSE_SLOT_WAIT_SECONDS)
        flow.metadata["src_response_slot"] = True
        # A client may disappear while queued. Never claim/send for it.
        if not flow.client_conn.connected:
            raise ValueError("SRC_GATE_CLIENT_CLOSED")
        result = await asyncio.to_thread(control, "/claim", value)
        dispatch_id = result.get("dispatchId")
        if not isinstance(dispatch_id, str) or not dispatch_id:
            raise ValueError("invalid dispatch")
        flow.metadata["src_dispatch_id"] = dispatch_id
        if not flow.client_conn.connected:
            raise ValueError("SRC_GATE_CLIENT_CLOSED")
        address = str(ipaddress.ip_address(result["upstreamAddress"]))
        port = result["upstreamPort"]
        if type(port) is not int or port != request.port:
            raise ValueError("invalid pinned port")
        flow.server_conn.address = (address, port)
        flow.server_conn.sni = request.host
    except asyncio.CancelledError:
        await finish(flow, "outcome_unknown")
        release_slot(flow)
        raise
    except Exception as error:
        release_slot(flow)
        await finish(flow, "outcome_unknown")
        deny(flow, str(error), error)

async def finish(flow, outcome):
    dispatch_id = flow.metadata.pop("src_dispatch_id", None)
    if dispatch_id:
        try:
            value = {"dispatchId": dispatch_id, "outcome": outcome}
            if outcome == "response_received":
                response = flow.response
                body = response.raw_content
                if body is None or len(body) > MAX_RESPONSE:
                    value["outcome"] = "outcome_unknown"
                else:
                    value["response"] = {"status": response.status_code,
                        "headers": list(response.headers.items(multi=True)),
                        "bodyBase64": base64.b64encode(body[:MAX_BODY]).decode("ascii"),
                        "totalBytes": len(body), "bodySha256": hashlib.sha256(body).hexdigest()}
            await asyncio.to_thread(control, "/finish", value)
        except Exception:
            # Unfinished claims remain occupied. No retry and no budget refund.
            ctx.log.error("SRC gate outcome unavailable; dispatch remains locked")

def release_slot(flow):
    if flow.metadata.pop("src_response_slot", False):
        RESPONSE_SLOTS.release()

async def response(flow):
    # response() runs BEFORE downstream transmission. Releasing here would let
    # slow readers retain up to MAX_CLIENTS full response bodies. Force this
    # HTTP/1 connection closed and retain its slot until downstream disconnect.
    if flow.metadata.get("src_response_slot"):
        flow.response.headers["connection"] = "close"
        DRAINING[flow.client_conn.id] = flow
    await finish(flow, "response_received")

async def error(flow):
    DRAINING.pop(flow.client_conn.id, None)
    try:
        await finish(flow, "outcome_unknown")
    finally:
        release_slot(flow)

def tcp_start(flow):
    flow.kill()

def websocket_start(flow):
    flow.kill()
