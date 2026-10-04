"""Exact-request egress adapter. All errors deny; no policy or human approval here.
Launch only with private immutable configuration, lazy connections, no upstream
certificate sniffing, HTTP/1 only, rawtcp disabled, and no passthrough hosts.
"""
import asyncio
import base64
from http.client import HTTPConnection
import json
import ipaddress
import os
import re
import socket
from mitmproxy import ctx, exceptions, http

MAX_BODY = 65536
SOCKET = os.environ["SRC_GATE_CONTROL_SOCKET"]
TOKEN = os.environ["SRC_GATE_CONTROL_TOKEN"]

class UnixConnection(HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)

def control(endpoint, value):
    conn = UnixConnection("localhost", timeout=3)
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
            raise ValueError(code if re.fullmatch(r"SRC_GATE_[A-Z_]+", code) else "control rejected")
        return value
    finally:
        conn.close()

def configure(updated):
    o = ctx.options
    if (o.connection_strategy != "lazy" or o.upstream_cert or o.http2 or o.rawtcp
            or o.ignore_hosts or o.tcp_hosts or o.ssl_insecure or o.mode != ["regular"]
            or o.stream_large_bodies is not None or o.body_size_limit != "64k"):
        raise exceptions.OptionsError("SRC gate requires strict immutable HTTP/1 inspection settings")

def deny(flow, reason="SRC_GATE_POLICY_DENIED"):
    reason = reason if re.fullmatch(r"SRC_GATE_[A-Z_]+", reason) else "SRC_GATE_ADAPTER_FAILURE"
    flow.response = http.Response.make(403, b"SRC_GATE_BLOCKED_NOT_SENT", {
        "content-type": "text/plain", "x-src-gate": "not-sent", "x-src-gate-reason": reason
    })

def requestheaders(flow):
    flow.request.stream = False
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
        # curl's proxy hop preference is not an origin request header. Validate
        # exactly one benign value, then remove it before both review and send.
        hop = request.headers.get_all("proxy-connection")
        if hop:
            if len(hop) != 1 or hop[0].lower() not in ("keep-alive", "close"):
                raise ValueError("SRC_GATE_UNSUPPORTED_HEADERS")
            del request.headers["proxy-connection"]
        value = {
            "url": request.url, "method": request.method,
            "headers": list(request.headers.items(multi=True)),
            "bodyBase64": base64.b64encode(body).decode("ascii")
        }
        result = await asyncio.to_thread(control, "/claim", value)
        dispatch_id = result.get("dispatchId")
        if not isinstance(dispatch_id, str) or not dispatch_id:
            raise ValueError("invalid dispatch")
        flow.metadata["src_dispatch_id"] = dispatch_id
        address = str(ipaddress.ip_address(result["upstreamAddress"]))
        port = result["upstreamPort"]
        if type(port) is not int or port != request.port:
            raise ValueError("invalid pinned port")
        flow.server_conn.address = (address, port)
        flow.server_conn.sni = request.host
    except Exception as error:
        await finish(flow, "outcome_unknown")
        deny(flow, str(error))

async def finish(flow, outcome):
    dispatch_id = flow.metadata.pop("src_dispatch_id", None)
    if dispatch_id:
        try:
            value = {"dispatchId": dispatch_id, "outcome": outcome}
            if outcome == "response_received":
                response = flow.response
                body = response.raw_content
                if body is None or len(body) > MAX_BODY:
                    value["outcome"] = "outcome_unknown"
                else:
                    value["response"] = {"status": response.status_code,
                        "headers": list(response.headers.items(multi=True)),
                        "bodyBase64": base64.b64encode(body).decode("ascii")}
            await asyncio.to_thread(control, "/finish", value)
        except Exception:
            # Unfinished claims remain occupied. No retry and no budget refund.
            ctx.log.error("SRC gate outcome unavailable; dispatch remains locked")

async def response(flow):
    await finish(flow, "response_received")

async def error(flow):
    await finish(flow, "outcome_unknown")

def tcp_start(flow):
    flow.kill()

def websocket_start(flow):
    flow.kill()
