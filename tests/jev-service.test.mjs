import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { readDecisionSettings, saveDecisionSettings, publicDecisionSettings, decisionSettingsPath } from '../lib/src/decision/service-settings.js';
import { jevDecide, decisionServiceStatus } from '../lib/src/decision/jev-client.js';
import { registerDecisionCommands } from '../lib/src/decision/service-commands.js';
const answer = (choice,options,model='jev-fixture') => {
 const result={ model, answers:{decision:{choice,confidence:.95,probabilities:Object.fromEntries(options.map(k=>[k,k===choice?1:0]))}} };
 result.answers.objectClass={choice:'business-or-unknown',confidence:1,probabilities:{'not-applicable':0,'new-test-file':0,'owned-test-file':0,'business-or-unknown':1}};
 result.answers.risk={choice:'high',confidence:1,probabilities:{low:0,high:1,unknown:0}};
 result.answers.verdict={choice:'pending',confidence:1,probabilities:{allow:0,pending:1}};
 return result;
};
async function fixture(t){const prev=process.env.DSH_HOME, fetch=globalThis.fetch;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jev-service-'));await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);process.env.DSH_HOME=dir;t.after(async()=>{globalThis.fetch=fetch;if(prev===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=prev;await fs.rm(dir,{recursive:true,force:true});});return dir;}
const exec={agent:{session:{id:'fixture'}}};
const args={taskType:'skill-activate',justification:'排查TLS差异',headers:{'api-key':'business-fixture-secret'},candidates:[{id:'network-guide',title:'网络诊断',identity:'v1',excerpt:'比较代理直连和TLS错误'}]};

for(const composite of [false,true])test(`风险审核不截断正文尾部，展示摘要限制不影响审核：composite=${composite}`,async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://a.test/v1/systemone'});
 const body=composite?JSON.stringify({padding:'x'.repeat(6000),operation:'delete-business-records',password:'fixture-private-body'}):'padding='+'x'.repeat(6000)+'&operation=delete-business-records&password=fixture-private-body';
 globalThis.fetch=async(_url,init)=>{
  assert.ok(init.body.includes('delete-business-records'));assert.ok(!init.body.includes('fixture-private-body'));assert.ok(!init.body.includes('截断'));
  const p=JSON.parse(init.body);return new Response(JSON.stringify(answer('destructive',Object.keys(p.questions.decision.criteria))));
 };
 const request={method:'POST',url:'https://fixture.invalid/query',headers:[],bodyBase64:Buffer.from(body).toString('base64')};
 const result=await jevDecide(composite?{taskType:'scan-plan',scopeChecked:true,plan:{entries:[{request,maxRequests:2}],maxRequests:2,purpose:'fixture'}}:{taskType:'risk-grade',scopeChecked:true,method:request.method,url:request.url,body},exec);
 assert.equal(result.fallback,false);assert.equal(result.effect,'destructive');
});

test('Jev settings are global, private, atomic, mask keys, and require key on provider-origin change',async t=>{
 await fixture(t);assert.equal((await readDecisionSettings()).enabled,false);
 const saved=await saveDecisionSettings({enabled:true,endpoint:'https://a.test/v1/systemone',model:'jev-latest',apiKey:'provider-secret'});
 assert.equal(saved.hasKey,true);assert.equal(saved.apiKey,'provider-secret');
 assert.equal((await fs.stat(decisionSettingsPath())).mode&0o777,0o600);
 await assert.rejects(()=>saveDecisionSettings({endpoint:'https://b.test/v1/systemone'}),/origin/);
 assert.equal((await readDecisionSettings()).endpoint,'https://a.test/v1/systemone');
 await saveDecisionSettings({endpoint:'https://b.test/v1/systemone',apiKey:'new-provider'});
 await saveDecisionSettings({model:'jev-preview',apiKey:''});assert.equal((await readDecisionSettings()).apiKey,'new-provider');
 await saveDecisionSettings({clearKey:true});assert.equal((await readDecisionSettings()).apiKey,'');
 for(const endpoint of ['http://remote.test','https://user:pass@a.test','https://a.test/?key=x'])await assert.rejects(()=>saveDecisionSettings({endpoint}));
});

test('Jev direct Skill mapping, remote credential removal, warm cache, config/key/model invalidation',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,endpoint:'https://a.test/v1/systemone',apiKey:'provider-secret'});
 let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(init.redirect,'error');assert.match(init.headers.authorization,/Bearer /);assert.ok(!init.body.includes('business-fixture-secret'));const p=JSON.parse(init.body);assert.ok(p.state.candidates[0].excerpt);return new Response(JSON.stringify(answer('doc-1',Object.keys(p.questions.decision.criteria),p.model)));};
 const first=await jevDecide(args,exec);assert.equal(first.action,'network-guide');assert.equal(first.source,'jev');
 assert.equal((await jevDecide(args,exec)).cached,true);assert.equal(calls,1);
 await saveDecisionSettings({model:'jev-preview'});assert.equal((await jevDecide(args,exec)).model,'jev-preview');assert.equal(calls,2);
 await saveDecisionSettings({apiKey:'replacement-key'});await jevDecide(args,exec);assert.equal(calls,3);
 await saveDecisionSettings({enabled:false});assert.equal((await jevDecide(args,exec)).errorType,'disabled');assert.equal(calls,3);
 assert.equal(JSON.stringify(await decisionServiceStatus()).includes('replacement-key'),true);
});

test('Jev one-shot errors remain neutral; no automatic retry or Laya fallback',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,endpoint:'https://a.test/v1/systemone'});
 let calls=0;
 for(const status of [401,429,503]){
 globalThis.fetch=async()=>{calls++;return new Response('SECRET ECHO',{status});};
 const r=await jevDecide(args,exec);assert.equal(r.errorType,`http-${status}`);assert.equal(r.action,'skip');assert.equal(JSON.stringify(r).includes('SECRET'),false);
 }
 assert.equal(calls,3);
 globalThis.fetch=async()=>new Response('{}');assert.equal((await jevDecide(args,exec)).errorType,'schema');
 globalThis.fetch=async(_u,init)=>new Response(JSON.stringify(answer('outside',Object.keys(JSON.parse(init.body).questions.decision.criteria))));assert.equal((await jevDecide(args,exec)).errorType,'schema');
 globalThis.fetch=async(_u,init)=>new Response(JSON.stringify(answer('skip',Object.keys(JSON.parse(init.body).questions.decision.criteria))));assert.equal((await jevDecide(args,exec)).fallback,false,'next call can succeed; no circuit breaker');
});

test('Jev timeout/cancellation returns neutral and explicit remote operation classification never grants execution',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://a.test/v1/systemone',timeoutMs:1000});
 globalThis.fetch=async(_u,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
 assert.equal((await jevDecide(args,exec)).errorType,'timeout');
 const cancel=new AbortController();cancel.abort();assert.equal((await jevDecide(args,{...exec,signal:cancel.signal})).errorType,'cancelled');
 globalThis.fetch=async(_u,init)=>{assert.ok(!init.body.includes('body-secret'));assert.ok(!init.body.includes('cookie-secret'));return new Response(JSON.stringify(answer('write',Object.keys(JSON.parse(init.body).questions.decision.criteria))));};
 const r=await jevDecide({taskType:'risk-grade',method:'POST',url:'https://fixture.test/delete?token=url-secret',headers:{cookie:'sid=cookie-secret'},body:'{"password":"body-secret"}',justification:'delete synthetic'},exec);
 assert.equal(r.effect,'write');assert.equal(r.action,'pending');assert.equal(r.riskScore,null);assert.equal(r.advisoryOnly,false);
});

test('Jev refuses redirects so authorization cannot leak to a second endpoint',async t=>{
 await fixture(t);let second=0;
 const server=http.createServer((req,res)=>{if(req.url==='/to'){second++;res.end('{}');return;}res.writeHead(302,{location:'/to'});res.end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 await saveDecisionSettings({enabled:true,endpoint:`http://127.0.0.1:${server.address().port}/from`,apiKey:'provider-secret'});
 assert.equal((await jevDecide(args,exec)).fallback,true);assert.equal(second,0);
});

test('Jev control-plane commands suppress input recording and never return keys',async t=>{
 await fixture(t);const commands=new Map();registerDecisionCommands({commands:{register:c=>commands.set(c.name,c)}});
 const save=commands.get('src-decision-save');assert.equal(save.recordInput,false);
 const r=await save.handler({rawInput:JSON.stringify({enabled:true,endpoint:'https://fixture.test/v1/systemone',apiKey:'command-secret'})});assert.equal(r.kind,'success');assert.ok(r.text.includes('command-secret'));
 assert.ok((await commands.get('src-decision-status').handler({})).text.includes('command-secret'));
});

test('Jev Browser candidate seam uses selected endpoint; none/off/shadow never clicks',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,endpoint:'https://a.test/v1/systemone',browserMode:'on'});
 const {chooseBrowserCandidate}=await import('../lib/src/decision/browser-loop.js');
 const candidate={index:0,operation:'click',label:'取消',targetRef:'e1'};
 let picked='0',calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://a.test/v1/systemone');const payload=JSON.parse(init.body);assert.ok(payload.questions.decision.criteria.none);return new Response(JSON.stringify(answer(picked,Object.keys(payload.questions.decision.criteria))));};
 const input={goal:'取消',observation:'button 取消 [ref=e1]',candidates:[candidate]};
 assert.equal((await chooseBrowserCandidate(input,exec)).index,0);
 picked='none';const none=await chooseBrowserCandidate(input,exec);assert.equal(none.index,-1);assert.equal(none.fallback,true);
 await saveDecisionSettings({browserMode:'shadow'});picked='0';assert.equal((await chooseBrowserCandidate(input,exec)).fallback,true);
 await saveDecisionSettings({browserMode:'off'});assert.equal((await chooseBrowserCandidate(input,exec)).fallback,true);assert.equal(calls,3);
});


test('scan-plan evaluates every exact entry once, strips credentials/body secrets, returns risk contract', async t => {
 await fixture(t);
 await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://advisor.invalid/v1/systemone',apiKey:'fixture-provider-secret'});
 let calls=0;
 globalThis.fetch=async (_url,init)=>{
  calls++;
  const p=JSON.parse(init.body);
  assert.equal(p.state.plan.entries.length,2);
  assert.equal(p.state.plan.maxRequests,7);
  assert.equal(p.state.plan.minIntervalMs,500);
  assert.ok(!init.body.includes('business-fixture-secret'));
  assert.ok(!init.body.includes('body-private-secret'));
  assert.ok(!init.body.includes('bodyBase64'));
  assert.match(p.questions.decision.instructions,/每个请求/);
  const result=answer('read',Object.keys(p.questions.decision.criteria));
  result.answers.risk={choice:'low',confidence:.98,probabilities:{low:1,high:0,unknown:0}};
  result.answers.verdict={choice:'allow',confidence:.98,probabilities:{allow:1,pending:0}};
  return new Response(JSON.stringify(result));
 };
 const plan={entries:[
  {request:{method:'GET',url:'https://fixture.invalid/a',headers:[['authorization','Bearer business-fixture-secret']],bodyBase64:''},maxRequests:3},
  {request:{method:'POST',url:'https://fixture.invalid/b',headers:[],bodyBase64:Buffer.from('{"password":"body-private-secret"}').toString('base64')},maxRequests:4}
 ],maxRequests:7,minIntervalMs:500,expiresAt:Date.now()+1000};
 const result=await jevDecide({taskType:'scan-plan',plan,scopeChecked:true},exec);
 assert.equal(result.fallback,false);assert.equal(result.action,'allow');assert.equal(result.effect,'read');assert.equal(result.mode,'on');assert.equal(calls,1);
 assert.ok(plan.entries[1].request.bodyBase64,'advisor must not mutate caller request');
});

test('risk rubric separates read semantics from write recovery and never upgrades unknown verdicts',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://a.test/v1/systemone'});
 let calls=0;
 globalThis.fetch=async(_url,init)=>{
  calls++;const p=JSON.parse(init.body);
  assert.match(p.questions.risk.instructions,/不要求写操作/);
  assert.match(p.questions.risk.instructions,/不是所有GET都是读取/);
  assert.match(p.questions.risk.criteria.high,/自称测试或可恢复不豁免/);
  assert.ok(!p.questions.risk.criteria.low.includes('可恢复'));
  assert.equal(p.state.request.url,'https://fixture.test/catalog/7');
  const r=answer('read',Object.keys(p.questions.decision.criteria));
  r.answers.risk={choice:'unknown',confidence:.8,probabilities:{low:.2,high:0,unknown:.8}};
  r.answers.verdict={choice:'allow',confidence:.9,probabilities:{allow:.9,pending:.1}};
  return new Response(JSON.stringify(r));
 };
 const r=await jevDecide({taskType:'risk-grade',scopeChecked:true,method:'GET',url:'https://fixture.test/catalog/7'},exec);
 assert.equal(r.risk,'unknown');assert.equal(r.action,'allow');
 const {allowsLowImpact}=await import('../lib/src/egress/decision-policy.js');
 assert.equal(allowsLowImpact(r),false);assert.equal(calls,1);
});

test('复合安全计划发给Jev时所有嵌套请求均脱敏，不残留base64凭据副本',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://a.test/v1/systemone'});
 const secret='nested-body-secret',request={method:'POST',url:'https://fixture.invalid/compute',headers:[['authorization','Bearer nested-header-secret']],bodyBase64:Buffer.from(JSON.stringify({password:secret,template:'{{7*7}}'})).toString('base64')};
 globalThis.fetch=async(_url,init)=>{
  assert.ok(!init.body.includes(secret));assert.ok(!init.body.includes('nested-header-secret'));assert.ok(!init.body.includes('bodyBase64'));assert.ok(!init.body.includes(request.bodyBase64));
  const p=JSON.parse(init.body);assert.equal(p.state.plan.hostExecution.request.body.includes('{{7*7}}'),true);
  const value=answer('compute',Object.keys(p.questions.decision.criteria));value.answers.risk={choice:'low',confidence:.99,probabilities:{low:1,high:0,unknown:0}};value.answers.verdict={choice:'allow',confidence:.99,probabilities:{allow:1,pending:0}};
  return new Response(JSON.stringify(value));
 };
 const plan={entries:[{request,maxRequests:1}],maxRequests:1,minIntervalMs:250,lifetimeMs:300000,purpose:'计算',hostExecution:{request,safety:{effect:'compute',object:'算术',recovery:'无自动重试'}}};
 const result=await jevDecide({taskType:'scan-plan',plan,scopeChecked:true},exec);assert.equal(result.effect,'compute');assert.equal(result.fallback,false);
});

test('审核正文保留重复JSON键与尾部语义，脱敏转义键，拒绝有损解码',async()=>{
 const {reviewBody}=await import('../lib/src/decision/review-input.js');
 const text=reviewBody('{"operation":"read","password":"fixture-secret","operation":"drop-database","nested":{"secret":{"key":"nested-private"}}}');
 assert.equal((text.match(/"operation"/g)??[]).length,2);assert.ok(text.includes('drop-database'));assert.ok(!text.includes('fixture-secret'));assert.ok(!text.includes('nested-private'));
 assert.throws(()=>reviewBody(Buffer.from([0xff,0xfe])));
 const escaped='{"'+String.raw`\u0070assword`+'":"unicode-private","operation":"delete"}';assert.ok(!reviewBody(escaped).includes('unicode-private'));
});
test('有损或超限审核材料不能请求Jev后自动放行',async t=>{
 await fixture(t);await saveDecisionSettings({enabled:true,riskMode:'on',endpoint:'https://a.test/v1/systemone'});let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not call');};
 for(const body of [Buffer.from([0xff,0xfe]),'x'.repeat(65537)]){const r=await jevDecide({taskType:'risk-grade',method:'POST',url:'https://fixture.invalid/test',body},exec);assert.equal(r.action,'pending');assert.equal(r.errorType,'unreviewable-input');}
 assert.equal(calls,0);
});
