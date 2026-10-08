import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFofaLookup,fofaQuery,readFofaAccounts} from '../lib/src/egress/fofa.js';
async function fixture(t,send){const home=await mkdtemp(path.join(tmpdir(),'fofa-gate-'));t.after(()=>rm(home,{recursive:true,force:true}));await writeFile(home+'/capabilities.yaml','settings:\n  fofaKey: "secret&key"\n  fofaEmail: "fixture@example.invalid"\n  fofaKeyBackup: "backup-key"\n');return {home,run:createFofaLookup({home,send,pin:async origin=>{assert.equal(origin,'https://fofa.info');return [{address:'203.0.113.2',family:4}];},wait:async()=>{}})};}
const exec=args=>({name:'mcp__fofa__get_alerts',arguments:args});
test('FOFA query is data only; unknown endpoint/key/header fields and invalid args rejected',()=>{
 assert.equal(fofaQuery({domain:'fixture.invalid'}),'domain="fixture.invalid"&&status_code=200');
 assert.equal(fofaQuery({body:'a"b\\c',status_code:''}),'body="a\\"b\\\\c"');
 for(const args of [{url:'https://target.invalid/delete'},{key:'attacker'},{status_code:'200||port=22'},{domain:12},{domain:'x\ny'},{domain:'a'.repeat(2049)},{status_code:''}])assert.throws(()=>fofaQuery(args));
});
test('FOFA pins only fixed index, never follows returned hosts, preserves structured MCP output and redacts echoed keys',async t=>{
 let sent=0;
 const {run}=await fixture(t,async(url,init)=>{sent++;const u=new URL(url);assert.equal(u.origin+u.pathname,'https://fofa.info/api/v1/search/all');assert.equal(u.searchParams.get('key'),'secret&key');assert.equal(u.searchParams.get('fields'),'host,ip,port');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');return Response.json({results:[['https://target.invalid/delete?token=secret%26key','1.2.3.4',443]],size:1});});
 const r=await run(exec({domain:'fixture.invalid'}),'s');assert.equal(sent,1);assert.equal(r.value.structuredContent.result.count,1);assert.match(r.value.structuredContent.result.data,/redacted/);assert.ok(!JSON.stringify(r).includes('secret'));assert.deepEqual(JSON.parse(r.value.content[0].text),r.value.structuredContent.result);
});
test('FOFA auth/quota fallback bounded to configured accounts and redirects never followed',async t=>{
 let sent=0;const {run}=await fixture(t,async()=>++sent===1?new Response('{}',{status:429}):Response.json({results:[]}));
 assert.deepEqual((await run(exec({ip:'1.2.3.4'}),'s')).value.structuredContent.result.account_tried,['primary','backup']);assert.equal(sent,2);
 const f=await fixture(t,async()=>{sent++;return new Response('',{status:302,headers:{location:'http://127.0.0.1/delete'}});});
 assert.match((await f.run(exec({domain:'fixture.invalid'}),'s')).value.structuredContent.result.error,/redirect refused/);assert.equal(sent,3);
});
test('missing credentials, cancellation, DNS denial, invalid schema and request budgets do not fail open',async t=>{
 let sent=0;const {run,home}=await fixture(t,async()=>{sent++;return Response.json({results:[]});});
 for(let i=0;i<12;i++)await run(exec({domain:'fixture.invalid'}),'s');await assert.rejects(run(exec({domain:'fixture.invalid'}),'s'),{code:'SRC_GATE_FOFA_BUDGET'});assert.equal(sent,12);
 await assert.rejects(run({...exec({}),signal:AbortSignal.abort()},'other'));assert.equal(sent,12);
 const denied=createFofaLookup({home,pin:async()=>{throw new Error('private DNS');},wait:async()=>{},send:async()=>assert.fail('DNS refusal sent')});await assert.rejects(denied(exec({}),'s'),/private DNS/);
 await writeFile(home+'/capabilities.yaml','settings: {}');assert.deepEqual(await readFofaAccounts(home),[]);assert.match((await run(exec({}),'new')).value.structuredContent.result.error,/未配置/);assert.equal(sent,12);
});
test('transport and upstream errors never expose credential-bearing URLs',async t=>{
 const {run}=await fixture(t,async url=>{throw new Error(url);});const r=await run(exec({}),'s');assert.ok(!JSON.stringify(r).includes('secret'));assert.match(r.value.structuredContent.result.error,/传输失败/);
 const f=await fixture(t,async()=>Response.json({results:[['bad-shape']]}));await assert.rejects(f.run(exec({}),'s'),{code:'SRC_GATE_FOFA_INVALID_RESULTS'});
});

import {installEgressExecution} from '../lib/src/egress/host-integration.js';
test('unregistered FOFA tool is rejected before manager, credentials or any sending path',async()=>{
 let execute;
 const ctx={effect(){},on(event,handler){if(event==='tools/execute')execute=handler;},shell:{srcEgressPolicyVersion:1},tools:{get:()=>undefined}};
 installEgressExecution(ctx,{}, {own(){},ready(){assert.fail('Unavailable tool opened manager');}});
 await assert.rejects(execute({...exec({}),callId:'unavailable-fofa-fixture',agent:{session:{id:'s'}}},()=>assert.fail('Unconfined provider called')),{code:'SRC_GATE_UNAVAILABLE_TOOL'});
});
test('FOFA oversized rows and decode failures report after-send errors, not zero traffic',async t=>{
 const {run}=await fixture(t,async()=>Response.json({results:[['a'.repeat(2049),'192.0.2.1',80]]}));
 await assert.rejects(run(exec({}),'s'),{code:'SRC_GATE_FOFA_INVALID_RESULTS',safeNotSent:false});
});
test('credential redaction cannot corrupt JSON numbers or boolean metadata',async t=>{
 const {home}=await fixture(t,async()=>{});await writeFile(home+'/capabilities.yaml','settings:\n  fofaKey: "1"\n');
 const run=createFofaLookup({home,pin:async()=>[{address:'203.0.113.2',family:4}],wait:async()=>{},send:async()=>Response.json({results:[['host1','192.0.2.1',81]],size:1})});
 const result=(await run(exec({domain:'fixture.invalid'}),'s')).value.structuredContent.result;
 assert.equal(result.count,1);assert.equal(result.size,1);assert.equal(result.raw_results[0][2],81);assert.equal(result.raw_results[0][0],'host[redacted]');
});
test('cancellation during unresolved DNS returns promptly and cannot send later',async t=>{
 const {home}=await fixture(t,async()=>{});let resolvePin,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const run=createFofaLookup({home,wait:async()=>{},pin:()=>{started();return new Promise(resolve=>{resolvePin=resolve;});},send:async()=>assert.fail('Cancelled DNS lookup sent')});
 const controller=new AbortController(),pending=run({...exec({}),signal:controller.signal},'s');await ready;controller.abort(new Error('fixture cancelled'));
 await assert.rejects(pending,/fixture cancelled/);resolvePin([{address:'203.0.113.2',family:4}]);await new Promise(resolve=>setImmediate(resolve));
});
