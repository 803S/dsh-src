"""Exercise the real addon request hook without installing mitmproxy in test Python."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
sys.modules['mitmproxy'] = SimpleNamespace(ctx=None, exceptions=None, http=None)
os.environ['SRC_GATE_CONTROL_SOCKET'] = '/unused-fixture'
os.environ['SRC_GATE_CONTROL_TOKEN'] = 'fixture-only'
spec = importlib.util.spec_from_file_location('addon', Path(__file__).resolve().parents[1] / 'lib/src/egress/mitm-addon.py')
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)

class Headers:
    def __init__(self, rows): self.rows = list(rows)
    def get_all(self, name): return [v for k, v in self.rows if k.lower() == name]
    def __delitem__(self, name): self.rows = [(k, v) for k, v in self.rows if k.lower() != name]
    def items(self, multi=False): return self.rows[:]

claims = []
def control(endpoint, value):
    assert endpoint == '/claim'
    claims.append(value)
    return dict(dispatchId='fixture-dispatch', upstreamAddress='127.0.0.1', upstreamPort=443)
addon.control = control
addon.deny = lambda flow, reason, details=None: setattr(flow, 'response', reason)

async def check(rows, allowed):
    claims.clear()
    request = SimpleNamespace(headers=Headers(rows), raw_content=b'', url='https://fixture.invalid/read', method='GET', port=443, host='fixture.invalid')
    flow = SimpleNamespace(request=request, response=None, metadata={}, server_conn=SimpleNamespace(), client_conn=SimpleNamespace(connected=True, id=id(request)))
    await addon.request(flow)
    if allowed:
        assert flow.response is None, flow.response
        assert len(claims) == 1
        assert claims[0]['headers'] == [('accept', '*/*')]
        assert request.headers.rows == [('accept', '*/*')]
        assert flow.metadata['src_dispatch_id'] == 'fixture-dispatch'
        addon.release_slot(flow)
    else:
        assert flow.response == 'SRC_GATE_UNSUPPORTED_HEADERS', flow.response
        assert claims == []

async def main():
    for name in ['connection', 'proxy-connection']:
        for value in ['keep-alive', 'close', 'Keep-Alive', 'CLOSE']:
            await check([(name, value), ('accept', '*/*')], True)
        for value in ['upgrade', 'x-original-url', 'keep-alive, close', '', ' close', 'close\r\nx-evil: 1']:
            await check([(name, value)], False)
        await check([(name, 'close'), (name, 'keep-alive')], False)
    await check([('connection', 'close'), ('proxy-connection', 'keep-alive'), ('accept', '*/*')], True)

asyncio.run(main())

async def concurrency():
    addon.RESPONSE_SLOTS = asyncio.Semaphore(4)
    sent = []
    def control(endpoint, value):
        if endpoint == '/claim':
            sent.append(value['url'])
            return dict(dispatchId='fixture-' + str(len(sent)), upstreamAddress='127.0.0.1', upstreamPort=443)
        assert endpoint == '/finish'
        return {}
    addon.control = control
    def flow(i):
        return SimpleNamespace(request=SimpleNamespace(headers=Headers([]), raw_content=b'', url=f'https://fixture.invalid/{i}', method='GET', port=443, host='fixture.invalid'), response=None, metadata={}, server_conn=SimpleNamespace(), client_conn=SimpleNamespace(connected=True, id=i))
    flows = [flow(i) for i in range(8)]
    tasks = [asyncio.create_task(addon.request(f)) for f in flows]
    for _ in range(100):
        if sum(t.done() for t in tasks) == 4: break
        await asyncio.sleep(.01)
    assert sum(t.done() for t in tasks) == 4
    assert len(sent) == 4
    # Cancellation while waiting consumes no dispatch and no response slot.
    cancelled = asyncio.create_task(addon.request(flow(9)))
    await asyncio.sleep(.01)
    cancelled.cancel()
    try: await cancelled
    except asyncio.CancelledError: pass
    # Disconnected waiting client cannot send when a slot becomes free.
    flows[7].client_conn.connected = False
    # Slots remain held after response hook until downstream disconnect.
    for f in flows[:4]:
        f.response = SimpleNamespace(headers={}, raw_content=b'ok', status_code=200)
        # finish is exercised with errors below; omit response evidence here.
        f.metadata.pop('src_dispatch_id')
        await addon.response(f)
        assert f.response.headers['connection'] == 'close'
    assert len(sent) == 4
    for f in flows[:4]:
        addon.client_disconnected(f.client_conn)
        addon.client_disconnected(f.client_conn)  # Idempotent release.
    await asyncio.wait_for(asyncio.gather(*tasks), 2)
    assert len(sent) == 7
    assert flows[7].response == 'SRC_GATE_CLIENT_CLOSED'
    for f in flows[4:]: await addon.error(f)
    assert addon.RESPONSE_SLOTS._value == 4
    # All eight live clients succeeded; the separate hard ceiling stays bounded.
    addon.CLIENTS.clear()
    clients = [SimpleNamespace(id=i, error=None) for i in range(33)]
    for c in clients: addon.client_connected(c)
    assert all(c.error is None for c in clients[:32])
    assert clients[32].error == 'SRC_GATE_CONNECTION_CAPACITY'
    for c in clients: addon.client_disconnected(c)
    assert not addon.CLIENTS

asyncio.run(concurrency())
