import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {capabilityProbeCommand,testConfinedCapability} from '../lib/src/egress/capability-test.js';
import {withEgressExecution,currentEgressExecution} from '../lib/src/egress/runtime.js';
async function setup(t){
 const home=await mkdtemp(path.join(tmpdir(),'cap-probe-')),dir=home+'/capabilities/probe',pkg=dir+'/node_modules/fixture-mcp';
 await mkdir(pkg,{recursive:true});await writeFile(pkg+'/cli.js','// installed fixture');
 await writeFile(pkg+'/package.json',JSON.stringify({name:'fixture-mcp',bin:{fixture:'cli.js'}}));
 const cap={id:'probe',kind:'mcp',status:'installed',dir,from:'npm:fixture-mcp'};
 await writeFile(home+'/capabilities/index.json',JSON.stringify({capabilities:[cap]}));
 t.after(()=>rm(home,{recursive:true,force:true}));return {home,dir,pkg,cap};
}
test('probe selects installed local bin; rejects ambiguous and escaping entries',async t=>{
 const f=await setup(t);assert.deepEqual(await capabilityProbeCommand(f.cap),{root:await realpath(f.dir),command:process.execPath,args:[await realpath(f.pkg+'/cli.js')]});
 await writeFile(f.pkg+'/package.json',JSON.stringify({name:'fixture-mcp',bin:{one:'cli.js',two:'other.js'}}));
 await assert.rejects(capabilityProbeCommand(f.cap),{code:'SRC_GATE_AMBIGUOUS_CAPABILITY_ENTRY'});
 await assert.rejects(capabilityProbeCommand({...f.cap,from:'path:fixture',entry:'../outside.js'}),{code:'SRC_GATE_INVALID_CAPABILITY_ENTRY'});
 await writeFile(f.home+'/outside.js','// outside');await symlink(f.home+'/outside.js',f.dir+'/escape.js');
 await assert.rejects(capabilityProbeCommand({...f.cap,from:'path:fixture',entry:'escape.js'}),{code:'SRC_GATE_INVALID_CAPABILITY_ENTRY'});
});
test('health uses denied-network transport and only handshake/discovery, then awaits cleanup',async t=>{
 const f=await setup(t),oldHome=process.env.DSH_HOME;process.env.DSH_HOME=f.home;t.after(()=>{if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;});
 let closed=0,finish;const methods=[],stdout=new PassThrough(),done=new Promise(resolve=>finish=resolve);
 const stdin=new Writable({write(chunk,_encoding,callback){const row=JSON.parse(String(chunk));methods.push(row.method);if(row.id!==undefined){const result=row.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'read',inputSchema:{type:'object'}}]};queueMicrotask(()=>stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result})+'\n'));}callback();}});
 const exec={agent:{session:{id:'fixture',header:{cwd:f.home}}}},context={exec,ctx:{tools:{get:name=>name==='mcp__probe__read'},shell:{startGuardedTransport(request){assert.equal(currentEgressExecution().proxy.denyNetwork,true);assert.ok(!request.command.includes('npx'));return {stdin,stdout,done,terminate:async()=>{closed++;finish();}};}}}};
 const result=await withEgressExecution(context,()=>testConfinedCapability({id:'probe'},exec));
 assert.equal(result.ok,true);assert.equal(result.protocolReady,true);assert.equal(result.registeredCount,1);assert.equal(closed,1);
 assert.deepEqual(methods,['initialize','notifications/initialized','tools/list']);
});
test('FOFA health selects installed offline server without its credential/download launcher',async t=>{
 const f=await setup(t);await writeFile(f.dir+'/fofa.py','# offline server');
 await mkdir(f.dir+'/.venv/bin',{recursive:true});await writeFile(f.dir+'/.venv/bin/python','fixture');
 for(const entry of [undefined,'fofa-launcher.mjs']){
  const command=await capabilityProbeCommand({...f.cap,id:'fofa',from:'path:fixture',entry});
  assert.equal(command.command,(await realpath(f.dir))+'/.venv/bin/python');
  assert.deepEqual(command.args,[(await realpath(f.dir))+'/fofa.py']);
 }
 await assert.rejects(capabilityProbeCommand({...f.cap,id:'fofa',from:'path:fixture',entry:'../outside.py'}),{code:'SRC_GATE_INVALID_CAPABILITY_ENTRY'});
});
