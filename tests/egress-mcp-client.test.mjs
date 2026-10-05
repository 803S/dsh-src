import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {createConfinedMcpClient} from '../lib/src/egress/mcp-client.js';
import {startConfinedBrowser} from '../lib/src/egress/browser-process.js';
import {withEgressExecution,currentEgressExecution} from '../lib/src/egress/runtime.js';
function fixture(t,options={}){
 const sent=[],stdout=new PassThrough();let finish,terminations=0;
 const handle={stdout,stdin:new Writable({write(chunk,encoding,done){sent.push(JSON.parse(String(chunk)));done();}}),done:new Promise(r=>finish=r),async terminate(){terminations++;finish({signal:'SIGTERM'});}};
 const client=createConfinedMcpClient(handle,{rootUri:'file:///fixture/',...options});
 t.after(()=>client.close());
 return {client,handle,sent,send:message=>stdout.write(JSON.stringify(message)+'\n'),terminateCount:()=>terminations};
}
test('MCP initialize, fragmented response, sequential calls and bounded client roots contract',async t=>{
 const f=fixture(t);const p=f.client.initialize();assert.equal(f.sent[0].method,'initialize');
 f.send({jsonrpc:'2.0',id:1,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});await p;
 assert.equal(f.sent[1].method,'notifications/initialized');
 const call=f.client.request('tools/call',{name:'browser_snapshot'});
 await assert.rejects(f.client.request('tools/list',{}),{code:'SRC_GATE_MCP_BUSY'});
 f.send({jsonrpc:'2.0',id:'server-1',method:'roots/list'});assert.deepEqual(f.sent.at(-1).result,{roots:[{uri:'file:///fixture/',name:'workspace'}]});
 f.send({jsonrpc:'2.0',id:'server-2',method:'sampling/createMessage',params:{messages:['untrusted']}});assert.equal(f.sent.at(-1).error.code,-32601);
 f.handle.stdout.write('{"jsonrpc":"2.0","id":2,');f.handle.stdout.write('"result":{"content":[]}}\n');assert.deepEqual(await call,{content:[]});
 await f.client.close();assert.equal(f.terminateCount(),1);
 await assert.rejects(f.client.request('tools/list',{}),{code:'SRC_GATE_MCP_CLOSED'});
});
test('MCP cancellation kills the worker and never reports an operation as definitely unsent',async t=>{
 const f=fixture(t),controller=new AbortController();const p=f.client.request('tools/call',{}, {signal:controller.signal});controller.abort();
 await assert.rejects(p,{code:'SRC_GATE_MCP_ABORTED',safeNotSent:false});await f.client.close();assert.equal(f.terminateCount(),1);assert.equal(f.sent.length,1);
});
test('MCP timeout and exit reject in-flight calls without retry',async t=>{
 const f=fixture(t,{timeoutMs:5});await assert.rejects(f.client.request('tools/call',{}),{code:'SRC_GATE_MCP_TIMEOUT',safeNotSent:false});assert.equal(f.sent.length,1);
 const g=fixture(t);const p=g.client.request('tools/list',{});await g.handle.terminate();await assert.rejects(p,{code:'SRC_GATE_MCP_EXITED'});
});
test('MCP malformed, oversize, ambiguous and unrelated responses close the protocol',async t=>{
 for(const bytes of ['not json\n','{"jsonrpc":"2.0","id":99,"result":{}}\n','{"jsonrpc":"2.0","id":1,"result":{},"error":{}}\n','x'.repeat(1025)]){
  const f=fixture(t,{maxMessageBytes:1024}),p=f.client.request('tools/list',{});f.handle.stdout.write(bytes);await assert.rejects(p,{safeNotSent:false});assert.equal(f.client.closed,true);assert.equal(f.sent.length,1);
 }
});
test('MCP notification flood, request limit and remote errors do not become host actions',async t=>{
 const f=fixture(t),p=f.client.request('tools/list',{});
 f.handle.stdout.write(Array.from({length:257},()=>JSON.stringify({jsonrpc:'2.0',method:'notifications/message'})).join('\n')+'\n');await assert.rejects(p,{code:'SRC_GATE_MCP_NOTIFICATION_LIMIT'});
 const g=fixture(t);await assert.rejects(g.client.request('tools/call',{code:'x'.repeat(256*1024)}),{code:'SRC_GATE_MCP_REQUEST_LIMIT'});assert.equal(g.sent.length,0);
 const h=fixture(t),q=h.client.request('tools/call',{});h.send({jsonrpc:'2.0',id:1,error:{code:-1,message:'untrusted'}});await assert.rejects(q,{code:'SRC_GATE_MCP_REMOTE_ERROR',safeNotSent:false});assert.equal(h.sent.length,1);
});
test('browser process uses the native duplex seam without granting deployment-file read access',async()=>{
 await assert.rejects(startConfinedBrowser({}),{code:'SRC_GATE_MISSING_EXECUTION_CONTEXT'});
 let finish,spec,seen;const handle={stdout:new PassThrough(),stdin:new Writable({write(c,e,done){done();}}),done:new Promise(r=>finish=r),async terminate(){finish();}};
 const context={exec:{agent:{session:{header:{cwd:'/fixture'},id:'s'}}},proxy:{alive:()=>true},readablePaths:['/installed/capability'],ctx:{shell:{startGuardedTransport(s){spec=s;seen=currentEgressExecution();return handle;}}}};
 const client=await withEgressExecution(context,()=>startConfinedBrowser({packagePath:'/installed/mcp',executablePath:'/installed/browser',outputDir:'/fixture/output'}));
 assert.equal(spec.workdir,'/fixture');assert.match(spec.command,/'-e'/);assert.match(spec.command,/createConnection/);assert.deepEqual(seen.readablePaths,['/installed/capability']);assert.equal(seen.exec,context.exec);
 await client.close();
 await assert.rejects(withEgressExecution(context,()=>startConfinedBrowser({packagePath:'relative',executablePath:'/browser',outputDir:'/out'})),{code:'SRC_GATE_INVALID_BROWSER_PATH'});
});
