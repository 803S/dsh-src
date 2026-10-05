import {startProcessMetrics} from './process-tree-metrics.mjs';
import {runtimeFiles} from '../deployment-manifest.mjs';
// Isolated real Web application smoke/approval fixture. Never restart production.
import {mkdtemp,mkdir,cp,readFile,writeFile,readdir,symlink,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import {webMcpLayers} from './web-mcp-layers.mjs';
if(!process.argv.includes('--run'))throw new Error('Use --run for an isolated local Web fixture');
const ownerLayers=process.argv.includes('--owner-layers'),scopeUI=process.argv.includes('--scope-ui'),mcp=process.argv.includes('--mcp-layers');
const burpActive=process.env.DSH_EVAL_BURP_SEND==='1';
if(burpActive&&(!mcp||process.env.DSH_EVAL_REAL_BURP_HISTORY!=='1'))throw new Error('Burp active validation requires the real installed Burp bridge');
if(mcp&&(!ownerLayers||!scopeUI))throw new Error('MCP layers require owner layers and scope UI');
if(process.argv.includes('--teams-probe')&&!mcp)throw new Error('Teams probe requires full MCP Web composition');
let target,origin,mcpLayers;const arrivals=[],fofaRequests=[],burpPayloads=[];
if(scopeUI){target=createServer((req,res)=>{if(req.url.startsWith('/fofa-index?')){fofaRequests.push(req.method);res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[['https://must-not-follow.invalid/','192.0.2.1',443]],size:1,page:1}));return;}arrivals.push({method:req.method,url:req.url});if(req.url.startsWith('/burp-')){const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{burpPayloads.push({method:req.method,url:req.url,body:Buffer.concat(chunks).toString(),host:req.headers.host,contentType:req.headers['content-type']});res.end('web-fixture');});}else res.end('web-fixture');});await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+target.address().port;}
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const aiRoot=path.join(homedir(),'.dsh/profiles/node_modules/@deepseek-ai');
// DSH_HOME is protected application state, not a writable session workspace.
const home=await mkdtemp(path.join(tmpdir(),'dsh-web-approval-')),profile=home+'/profiles/web',pkg=profile+'/node_modules/@lihua_dis/dsh-src',work=home+'-work';
await mkdir(pkg,{recursive:true});await mkdir(work,{recursive:true});
for(const name of ['lib','preset','scripts','mcp-servers','tools','package.json','cordis.patch.yml']){
 if(name==='lib'&&process.env.DSH_EVAL_RUNTIME_MANIFEST==='1'){
  // A full source-directory copy hid missing deployment leaf files before.
  for(const file of runtimeFiles(repo)){await mkdir(path.dirname(pkg+'/'+file),{recursive:true});await cp(repo+'/'+file,pkg+'/'+file);}
 }else await cp(repo+'/'+name,pkg+'/'+name,{recursive:true});
}
await mkdir(pkg+'/node_modules',{recursive:true});
for(const name of await readdir(repo+'/node_modules'))if(name!=='@deepseek-ai')await symlink(repo+'/node_modules/'+name,pkg+'/node_modules/'+name);
await symlink(aiRoot,pkg+'/node_modules/@deepseek-ai');
await mkdir(profile+'/node_modules/@deepseek-ai',{recursive:true});
for(const name of await readdir(aiRoot))if(name!=='dsh-session-history')await symlink(aiRoot+'/'+name,profile+'/node_modules/@deepseek-ai/'+name);
const extraBundles=[],extraDependencies={},extraRows=[];
if(ownerLayers){
 const installed=path.join(homedir(),'.dsh/profiles/web/node_modules');
 for(const name of ['open-sea-skin','@nanmicoder/dsh-agent-teams','@deepseek-ai/dsh-session-history']){
  await mkdir(path.dirname(profile+'/node_modules/'+name),{recursive:true});
  await symlink(installed+'/'+name,profile+'/node_modules/'+name);
  extraDependencies[name]='file:'+installed+'/'+name;
 }
 extraBundles.push('open-sea-skin','@nanmicoder/dsh-agent-teams');
 extraRows.push({insert:[{id:'session-history',name:'@deepseek-ai/dsh-session-history',inject:['connection'],config:{}}]});
}

if(scopeUI)extraRows.push({id:'src-egress',disabled:true},{insert:[{id:'fixture-egress',name:pkg+'/scripts/egress-feasibility/managed-service.mjs'}]});
if(process.env.DSH_EVAL_REAL_JEV==='1'){
 await mkdir(home+'/settings',{recursive:true});
 const decision=JSON.parse(await readFile(homedir()+'/.dsh/settings/src-decision.json','utf8'));
 await writeFile(home+'/settings/src-decision.json',JSON.stringify({...decision,skillMode:'off',delegateMode:'off',browserMode:'off'}),{mode:0o600});
}
await mkdir(home+'/capabilities',{recursive:true});
if(mcp){mcpLayers=await webMcpLayers({home,pkg,origin});extraRows.push(...mcpLayers.rows);}
await writeFile(profile+'/package.json',JSON.stringify({name:'isolated-web-approval',private:true,dependencies:{'@lihua_dis/dsh-src':`file:${pkg}`,...extraDependencies},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@lihua_dis/dsh-src',...extraBundles]}}}));
await writeFile(profile+'/cordis.yml','[]\n');
await writeFile(profile+'/cordis.patch.yml',yaml.dump([...extraRows,{id:'session-title-llm',disabled:true},{id:'hmr',disabled:true},{insert:[{id:'web-proof-fixture',name:pkg+'/scripts/egress-feasibility/web-proof-plugin.mjs',config:{trace:home+'/proof.jsonl',trigger:home+'/trigger.json',origin,observeMcp:mcp,teamsProbe:process.argv.includes('--teams-probe')}}]}]));
const original=yaml.load(await readFile(path.join(homedir(),'.dsh/settings.yaml'),'utf8'));
const selection=original['agent-default-model'],provider=original['llm-pi-ai'].providers[selection.provider];
await writeFile(home+'/settings.yaml',yaml.dump({'agent-default-model':selection,'agent-presets':{default:'src-hunter'},'llm-pi-ai':{providers:{[selection.provider]:{...provider,baseURL:'http://127.0.0.1:1/fixture-no-model',models:provider.models.filter(model=>model.id===selection.model)}}}}),{mode:0o600});
await writeFile(home+'/.credentials.yaml',yaml.dump({[provider.apiKeyEnv]:'fixture-unused-credential'}),{mode:0o600});
if(process.env.DSH_EVAL_REAL_JEV==='1'){
 await mkdir(home+'/settings',{recursive:true});
 const decision=JSON.parse(await readFile(homedir()+'/.dsh/settings/src-decision.json','utf8'));
 await writeFile(home+'/settings/src-decision.json',JSON.stringify({...decision,skillMode:'off',delegateMode:'off',browserMode:'off'}),{mode:0o600});
}
await mkdir(home+'/capabilities',{recursive:true});if(!mcp)await writeFile(home+'/capabilities/index.json','{"capabilities":[]}');
let logs='',browser,exitCode;const child=spawn(process.execPath,[aiRoot+'/dsh/lib/bin.js','--profile','web','--host','127.0.0.1','--port','0','--no-open'],{cwd:work,env:{...process.env,DSH_HOME:home,DSH_SRC_EVENT_STORE:'off',...mcpLayers?.env},stdio:['ignore','pipe','pipe'],detached:true});
const metrics=process.env.DSH_EVAL_METRICS==='1'?startProcessMetrics(child.pid):undefined;
const done=new Promise(resolve=>child.once('exit',code=>{exitCode=code;resolve();}));child.stdout.on('data',data=>logs+=data);child.stderr.on('data',data=>logs+=data);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
console.log(JSON.stringify({home,pid:child.pid}));
try{
 let base;
 for(let i=0;i<300;i++){
  if(exitCode!==undefined)throw new Error('Isolated Web exited before readiness');
  base=logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
  if(base){try{const r=await fetch(base+'/api/session.list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'fixture-ready',method:'session.list',payload:{}}),signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).result?.ok)break;}catch{}}
  base=undefined;await delay(200);
 }
 assert.ok(base,'Isolated Web RPC readiness timed out');
 await metrics?.mark('rpc-ready-before-tools');
 const require=createRequire(import.meta.url),{chromium}=require(path.join(homedir(),'.dsh/capabilities/playwright/node_modules/playwright'));
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1280,height:1000}});
 const blocked=[];await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===base)return route.continue();blocked.push(url.origin);return route.abort();});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base,{waitUntil:'networkidle'});await delay(3000);
 await page.getByRole('button',{name:'继续',exact:true}).click();
 const rpc=async(method,payload)=>{const r=await fetch(base+'/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload})});const value=await r.json();assert.ok(value.result?.ok,JSON.stringify(value));return value.result.value;};
 const session=await rpc('session.create',{cwd:work,agentPreset:'src-hunter'});
 await rpc('session.rename',{sessionId:session.sessionId,title:'Web proof fixture'});
 await writeFile(home+'/trigger.json',JSON.stringify({sessionId:session.sessionId}));
 await delay(1000);await page.reload({waitUntil:'networkidle'});await delay(1500);
 console.log('UI-before-select',await page.locator('body').innerText());
 await page.getByText('未分组',{exact:true}).click();await delay(500);
 console.log('UI-expanded',await page.locator('body').innerText());
 await page.getByText('Web proof fixture',{exact:true}).first().click();await delay(1500);
 await delay(3000);
 const text=await page.locator('body').innerText();
 const controls=await page.locator('button,input,a').evaluateAll(nodes=>nodes.map(node=>({tag:node.tagName,text:node.textContent?.trim().slice(0,100),placeholder:node.getAttribute('placeholder'),href:node.getAttribute('href')})));
 await page.screenshot({path:home+'/web-start.png',fullPage:true});
 const report={base,ownerLayers,mcp,extraBundles,errors,blocked,text,controls};await writeFile(home+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 assert.ok(text.includes('web-synthetic-proof'),'Native proof approval not rendered');
 await page.getByRole('button',{name:'拒绝',exact:true}).click();
 const rows=async()=>{try{return(await readFile(home+'/proof.jsonl','utf8')).trim().split('\n').map(JSON.parse);}catch{return[];}};
 const waitRows=async(test)=>{for(let i=0;i<200;i++){const all=await rows();assert.ok(!all.some(r=>r.error),JSON.stringify(all));if(test(all))return all;await delay(100);}throw new Error('Proof completion timed out');};
 const denied=await waitRows(all=>all.some(r=>r.command));
 assert.equal(denied.find(r=>r.result)?.result.isError,true,'UI reject started proof');
 await writeFile(home+'/trigger.json',JSON.stringify({sessionId:session.sessionId,attempt:2}));
 await page.getByRole('button',{name:'允许一次',exact:true}).waitFor();
 await page.getByRole('button',{name:'允许一次',exact:true}).click();
 const completed=await waitRows(all=>all.filter(r=>r.command).length===2);
 const results=completed.filter(r=>r.result);assert.equal(results.length,2);assert.ok(!results[1].result.isError,'UI approved proof failed');
 assert.equal(completed.find(r=>r.stopped)?.stopped.value.stopped,true,'Proof was not stopped');
 assert.equal(completed.find(r=>r.stopped).stopped.value.hits.length,1,'Exact one fixture read required');
 assert.ok(completed.filter(r=>r.command).every(r=>r.command?.result?.kind==='success'),'Fixture command failed');
 const audit=results[1].events.filter(e=>e.type==='approval/decided');assert.deepEqual(audit.map(e=>e.data.outcome),['rejected','allowed-once']);
 await writeFile(home+'/approval-passed.json',JSON.stringify({sessionId:session.sessionId,completed},null,2));
 console.log('REAL_WEB_REJECT_ALLOW_PASSED');
 if(scopeUI){
  await writeFile(home+'/trigger.json',JSON.stringify({sessionId:session.sessionId,action:'scope'}));
  await waitRows(all=>all.some(r=>r.scope));
  console.log('PRE_SCOPE_UI',await page.locator('body').innerText());
  console.log('PRE_SCOPE_BUTTONS',await page.locator('button').evaluateAll(ns=>ns.map(n=>({text:n.textContent,role:n.getAttribute('role')}))));
  await page.locator('button').filter({hasText:/^SRC$/}).click();await delay(500);
  await page.locator('button').filter({hasText:/^待办[0-9]*$/}).click();await delay(1000);
  const scopeText=await page.locator('body').innerText();console.log('SCOPE_UI',scopeText);
  await writeFile(home+'/scope-ui.txt',scopeText);await page.screenshot({path:home+'/scope-ui.png',fullPage:true});
  assert.ok(scopeText.includes('确认目标范围'),'Scope card missing from real SRC tab');
  assert.equal(arrivals.length,0,'Scope proposal sent target traffic');
  await page.getByRole('button',{name:'✓ 确认范围（不发包）',exact:true}).click();
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await delay(2000);const approvedText=await page.locator('body').innerText();console.log('AFTER_SCOPE_APPROVE',approvedText);await writeFile(home+'/after-scope-approve.txt',approvedText);
  await page.getByText('范围已确认，尚未发送请求；高危操作仍需另行批准',{exact:false}).waitFor();
  assert.equal(arrivals.length,0,'Confirming scope sent traffic');
  await writeFile(home+'/trigger.json',JSON.stringify({sessionId:session.sessionId,action:'traffic'}));
  const after=await waitRows(all=>all.some(r=>r.traffic)),traffic=after.find(r=>r.traffic).traffic;
  assert.equal(traffic.read.value.status,200);assert.equal(traffic.dangerous.value.approval,'pending');
  assert.deepEqual(arrivals,[{method:'GET',url:'/read'}]);
  await metrics?.mark('after-http-read-and-danger-pending');
  await delay(1000);
  const finalText=await page.locator('body').innerText();await page.screenshot({path:home+'/scope-approved-danger-pending.png',fullPage:true});
  await writeFile(home+'/scope-traffic-passed.json',JSON.stringify({arrivals,traffic,finalText},null,2));
  assert.ok(finalText.includes('DELETE '+origin+'/delete'));assert.ok(finalText.includes('缺少有效安全材料，当前不能执行'));
  assert.equal(await page.getByRole('button',{name:'✓ 确认范围（不发包）',exact:true}).count(),0);
  await page.getByRole('button',{name:'✓ 批准',exact:true}).click();await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText(/SRC_GATE_SAFETY_PLAN_REQUIRED/).waitFor();
  assert.deepEqual(arrivals,[{method:'GET',url:'/read'}]);
  await metrics?.mark('after-incomplete-safety-approval-refused');
  await page.getByRole('button',{name:'✗ 拒绝',exact:true}).click();await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('已拒绝',{exact:true}).waitFor();
  assert.deepEqual(arrivals,[{method:'GET',url:'/read'}]);
  await metrics?.mark('after-user-rejected-danger');
  await writeFile(home+'/scope-danger-rejected.txt',await page.locator('body').innerText());
  console.log('REAL_WEB_SCOPE_TRAFFIC_PASSED');
  if(mcp){
   await writeFile(home+'/trigger.json',JSON.stringify({sessionId:session.sessionId,action:'mcp'}));
   const rows=await waitRows(all=>all.some(r=>r.mcp)),result=rows.find(r=>r.mcp).mcp;
   await metrics?.mark('after-browser-and-mixed-tools');
   assert.ok(!result.browser.isError,JSON.stringify(result.browser));assert.equal(result.fofa.value.structuredContent.result.count,1);
   assert.equal(result.fofaHealth.value?.ok,true,JSON.stringify(result.fofaHealth));
   assert.equal(result.fofaHealth.value.protocolReady,true);assert.ok(result.fofaHealth.value.registeredCount>0);
   for(const read of [result.curl,result.afterDenial]){assert.ok(!read.isError,JSON.stringify(read));assert.equal(read.value.exitCode,0);assert.equal(read.value.stdout.text,'web-fixture');}
   assert.equal(result.dangerousCurl.value.exitCode,22);assert.match(result.dangerousCurl.value.stderr.text,/403/);
   assert.deepEqual(arrivals.filter(r=>!r.url.startsWith('/assessment-burst/')&&!r.url.startsWith('/assessment-shell/')),[{method:'GET',url:'/read'},{method:'GET',url:'/browser.html'},{method:'GET',url:'/curl-read'},{method:'GET',url:'/after-denial'},...(burpActive?[{method:'GET',url:'/burp-read'}]:[]),...(process.argv.includes('--teams-probe')?[{method:'GET',url:'/teams-read'},{method:'GET',url:'/teams-after'},{method:'GET',url:'/teams-resume'},{method:'GET',url:'/teams-staged-read'}]:[])]);assert.deepEqual(fofaRequests,['GET']);
   if(process.env.DSH_EVAL_ASSESSMENT_BURST==='1'){
    assert.equal(result.burst.peak,4);
    assert.equal(result.burst.shell.value?.exitCode,0,JSON.stringify(result.burst.shell));assert.equal(result.burst.shell.value.stdout.text,'web-fixture'.repeat(8));
    assert.deepEqual(arrivals.filter(r=>r.url.startsWith('/assessment-shell/')).sort((a,b)=>a.url.localeCompare(b.url)),Array.from({length:8},(_,i)=>({method:'GET',url:'/assessment-shell/'+i})));
    for(const read of [...result.burst.reads,result.burst.after]){assert.ok(!read.isError,JSON.stringify(read));assert.equal(read.value.status,200);assert.equal(read.value.responseBody,'web-fixture');}
    for(const read of result.burst.destructiveGets){assert.equal(read.value?.status,0);assert.ok(read.value?.pendingApprovalId,JSON.stringify(read));}
    assert.ok(result.burst.danger.value?.pendingApprovalId,JSON.stringify(result.burst.danger));
    assert.deepEqual(arrivals.filter(r=>r.url.startsWith('/assessment-burst/')).sort((a,b)=>a.url.localeCompare(b.url)),[...Array.from({length:8},(_,i)=>String(i)),'after'].map(id=>({method:'GET',url:'/assessment-burst/'+id})));
   }
   let burpWire;
   if(mcpLayers.realBurp){
    burpWire=(await readFile(home+'/burp-wire.jsonl','utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(burpWire.some(r=>r.method==='tools/list'));
    assert.deepEqual(burpWire.filter(r=>r.method==='tools/call').map(r=>r.toolName),['get_proxy_http_history_regex',...(burpActive?['send_http1_request']:[])]);
    assert.deepEqual(mcpLayers.calls,[]);assert.ok(result.burpHistory.bytes>0);
   }else{
    assert.ok(mcpLayers.methods.includes('tools/list'));assert.deepEqual(mcpLayers.calls,[{name:'get_proxy_http_history',arguments:{count:10,offset:0}}]);
    assert.match(JSON.stringify(result.burpHistory),/fixture-recorded-history-no-replay/);
   }
   assert.ok(!result.burpHistory.isError,JSON.stringify(result.burpHistory));
   assert.match(JSON.stringify(result.burpSend),/safety-material-required/);
   if(burpActive){
    assert.ok(!result.burpActive.read.isError,JSON.stringify(result.burpActive.read));
    assert.match(JSON.stringify(result.burpActive.read),/web-fixture/);
    assert.ok(!result.burpActive.prepared.isError,JSON.stringify(result.burpActive.prepared));
    const approvalId=result.burpActive.prepared.value.approvalId;
    const card=page.locator('span').filter({hasText:new RegExp('^'+approvalId+'$')}).locator('..').locator('..');
    await card.getByText('由原生 Burp执行冻结请求（POST）').waitFor();
    assert.equal(arrivals.filter(r=>r.method==='POST').length,0);
    await card.getByRole('button',{name:'✓ 批准',exact:true}).click();await page.getByRole('button',{name:'发送',exact:true}).click();
    await card.getByText('执行状态：executed',{exact:true}).waitFor();
    assert.deepEqual(arrivals.filter(r=>r.url.startsWith('/burp-')),[{method:'GET',url:'/burp-read'},{method:'POST',url:'/burp-compute'}]);
    burpWire=(await readFile(home+'/burp-wire.jsonl','utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(burpWire.filter(r=>r.method==='tools/call').map(r=>r.toolName),['get_proxy_http_history_regex','send_http1_request','send_http1_request']);
    assert.deepEqual(burpPayloads,[{method:'GET',url:'/burp-read',body:'',host:new URL(origin).host,contentType:'application/json'},{method:'POST',url:'/burp-compute',body:'{"expr":"1+1"}',host:new URL(origin).host,contentType:'application/json'}]);
    await card.screenshot({path:home+'/burp-approved.png'});
   }
   const wire=(await readFile(home+'/mcp-wire.jsonl','utf8')).trim().split('\n').map(JSON.parse);assert.equal(wire.filter(r=>r.method==='tools/call').length,0);
   assert.ok(result.registered.every(Boolean));
   await writeFile(home+'/mcp-layers-passed.json',JSON.stringify({result,arrivals,burpPayloads,fofaRequests,burpMethods:mcpLayers.methods,burpCalls:mcpLayers.calls,realBurp:mcpLayers.realBurp,burpWire,wire},null,2));console.log('REAL_WEB_MCP_LAYERS_PASSED');
  }


 }

 assert.equal(errors.length,0,'Real Web client runtime errors');assert.ok(text.trim().length>20,'Web app rendered no content');
}finally{
 if(metrics)await writeFile(home+'/process-metrics.json',JSON.stringify(await metrics.stop(),null,2));
 await browser?.close();
 if(target){target.closeAllConnections();await new Promise(resolve=>target.close(resolve));}
 if(exitCode===undefined){try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([done,delay(5000)]);if(exitCode===undefined){try{process.kill(-child.pid,'SIGKILL');}catch{}await done;}}
 await mcpLayers?.close();
 await writeFile(home+'/server.log',logs);
 await rm(home+'/settings/src-decision.json',{force:true});
 await rm(home+'/.credentials.yaml',{force:true});
}
