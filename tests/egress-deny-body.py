"""拒绝正文必须自解释：真实原因码随“未发送”一起写出，审批卡存在时保留可操作指引。"""
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True


class Response:
    @staticmethod
    def make(status, body, headers):
        return SimpleNamespace(status=status, body=body, headers=headers)


sys.modules['mitmproxy'] = SimpleNamespace(ctx=None, exceptions=None, http=SimpleNamespace(Response=Response))
os.environ['SRC_GATE_CONTROL_SOCKET'] = '/unused-fixture'
os.environ['SRC_GATE_CONTROL_TOKEN'] = 'fixture-only'
spec = importlib.util.spec_from_file_location('addon', Path(__file__).resolve().parents[1] / 'lib/src/egress/mitm-addon.py')
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

flow = lambda: SimpleNamespace(response=None)  # noqa: E731

# 1) 无审批卡的拒绝：正文必须带真实原因码，不再是 25 字节裸文本。
denied = addon.GateDenied('SRC_GATE_REQUEST_NOT_APPROVED', {'hint': '该请求不在冻结计划的精确清单内。'})
first = flow(); addon.deny(first, 'SRC_GATE_REQUEST_NOT_APPROVED', denied)
body = first.response.body.decode('utf-8')
assert body != 'SRC_GATE_BLOCKED_NOT_SENT', body
assert body.startswith('SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_REQUEST_NOT_APPROVED'), body
assert '不在冻结计划的精确清单内' in body, body
assert 'approval-' not in body, body

# 2) 无提示的控制面失败也要显式原因码（例如添加步骤里没有 hint 字段的旧实现）。
second = flow(); addon.deny(second, 'SRC_GATE_TASK_NOT_ACTIVE', addon.GateDenied('SRC_GATE_TASK_NOT_ACTIVE', {}))
body = second.response.body.decode('utf-8')
assert body == 'SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_TASK_NOT_ACTIVE', body

# 3) 待审/已拒绝仍然给出审批编号与处置动作，且不因新格式丢失。
third = flow(); addon.deny(third, 'SRC_GATE_PENDING_OR_REJECTED', addon.GateDenied('SRC_GATE_PENDING_OR_REJECTED', {'approvalId': 'approval-7', 'state': 'pending'}))
body = third.response.body.decode('utf-8')
assert body.startswith('SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_PENDING_OR_REJECTED\nrequest approval: approval-7'), body
assert 'Wait for the user' in body, body
fourth = flow(); addon.deny(fourth, 'SRC_GATE_PENDING_OR_REJECTED', addon.GateDenied('SRC_GATE_PENDING_OR_REJECTED', {'approvalId': 'approval-7', 'state': 'denied', 'kind': 'scope'}))
body = fourth.response.body.decode('utf-8')
assert 'scope confirmation (not traffic authorization): approval-7' in body, body
assert 'do not retry or switch channels' in body, body

# 4) 非 GateDenied 的内部校验失败同样带原因码；非法原因码仍被归一化。
fifth = flow(); addon.deny(fifth, 'SRC_GATE_UNSUPPORTED_HEADERS', ValueError('SRC_GATE_UNSUPPORTED_HEADERS'))
assert fifth.response.body.decode('utf-8') == 'SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_UNSUPPORTED_HEADERS'
sixth = flow(); addon.deny(sixth, 'not-a-code')
assert sixth.response.body.decode('utf-8') == 'SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_ADAPTER_FAILURE'

# 5) 头部契约不变：观察者仍能拿到 x-src-gate 与真实原因头。
seventh = flow(); addon.deny(seventh, 'SRC_GATE_BUDGET_EXHAUSTED', addon.GateDenied('SRC_GATE_BUDGET_EXHAUSTED', {'hint': '预算已用完。'}))
headers = seventh.response.headers
assert headers['x-src-gate'] == 'not-sent' and headers['x-src-gate-reason'] == 'SRC_GATE_BUDGET_EXHAUSTED', headers
assert seventh.response.status == 403

# 6) 超长 hint 不得进入正文（控制面已经截断，适配层再次设限）。
eighth = flow(); addon.deny(eighth, 'SRC_GATE_RATE_LIMIT', addon.GateDenied('SRC_GATE_RATE_LIMIT', {'hint': 'x' * 401}))
assert eighth.response.body.decode('utf-8') == 'SRC_GATE_BLOCKED_NOT_SENT\nSRC_GATE_RATE_LIMIT'

print('deny-body-ok')
