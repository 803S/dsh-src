// Opt-in real browser + owned SRC proxy regression. Synthetic loopback only, never production.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createEgressManager} from '../lib/src/egress/manager.js';
import {renderBrowserNetwork} from '../lib/src/egress/target-context.js';
import {dispatchHttp} from '../lib/src/egress/http-dispatch.js';
if(!process.argv.includes('--run'))throw Error('Use --run for synthetic local browser/proxy regression');
const require=createRequire(import.meta.url),{chromium}=require(process.env.DSH_UI_PLAYWRIGHT??path.join(homedir(),'.dsh/capabilities/playwright/node_modules/playwright'));
const home=await mkdtemp(path.join(tmpdir(),'src-target-boundary-')),rows=new Map(),records=[],hits=[];let localHits=0,browser,manager;
const local=http.createServer((req,res)=>{localHits++;res.end('LOCAL_SECRET_MUST_NOT_BE_REACHED');});
await new Promise(r=>local.listen(0,'127.0.0.1',r));const localURL=`http://127.0.0.1:${local.address().port}`;
const target=http.createServer((req,res)=>{hits.push(req.url);if(req.url==='/redirect'){res.writeHead(302,{location:localURL+'/private'});res.end();return;}res.setHeader('content-type','text/html');if(req.url==='/denied'){res.writeHead(403);res.end('real target denial');return;}res.end(`<title>Authorized fixture</title><body data-api-prefix="${localURL}">authorized page<script>fetch('${localURL}/api').catch(()=>{});</script></body>`);});
await new Promise(r=>target.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${target.address().port}`;
try{
 const store={listScopeApprovals:async()=>[],addPendingApproval:async(sessionId,data)=>{const row={...data,id:'approval-'+(rows.size+1),sessionId,status:'pending',createdAt:Date.now()};rows.set(row.id,row);return row;},getPendingApproval:async(s,id)=>rows.get(id),updateApprovalExecution:async(s,id,p)=>Object.assign(rows.get(id),p)};
 manager=await createEgressManager({home,allowLoopbackFixtures:true,storeFor:async()=>store,directFetch:dispatchHttp,assess:async()=>({action:'allow',effect:'read',risk:'low',confidence:.99,fallback:false,mode:'on'})});
 await manager.user.setScope('fixture',[origin]);const proxy=await manager.sessionProxy('fixture');
 const off=manager.watchNetwork('fixture',r=>records.push(r));
 browser=await chromium.launch({executablePath:process.env.DSH_UI_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--proxy-bypass-list=<-loopback>'],proxy:{server:proxy.url,bypass:'<-loopback>'}});
 const page=await browser.newPage();await page.goto(origin);await page.waitForTimeout(1200);assert.equal(await page.title(),'Authorized fixture',JSON.stringify({body:await page.locator('body').innerText(),records,hits}));assert.equal(localHits,0);
 assert.ok(records.some(r=>r.code==='SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'));assert.match(renderBrowserNetwork(records),/本地被阻断/);
 // JS fetch cannot rewrite its authorization, even when it uses a numeric alias.
 await page.evaluate(url=>fetch(url).catch(()=>{}),localURL.replace('127.0.0.1','2130706433')+'/alias');
 await page.goto(origin+'/redirect');assert.match(await page.locator('body').innerText(),/SRC_GATE_BLOCKED_NOT_SENT/);assert.equal(localHits,0);
 const before=records.length;const response=await page.goto(origin+'/denied');assert.equal(response.status(),403);assert.equal(await page.locator('body').innerText(),'real target denial');assert.equal(records.length,before,'real target 403 must not be labelled local gate');
 assert.throws(()=>manager.checkTarget('fixture',localURL+'/direct'),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});
 assert.throws(()=>manager.checkTarget('fixture',origin.replace('http:','https:')+'/direct'),{code:'SRC_GATE_LOCAL_TARGET_NOT_AUTHORIZED'});
 await page.goto(origin);assert.equal(await page.title(),'Authorized fixture');assert.equal(localHits,0);assert.equal(rows.size,0,'page localhost cannot open a new scope approval');off();
 await writeFile(path.join(home,'passed.json'),JSON.stringify({passed:true,localHits,authorizedHits:hits.length,gateRecords:records,checks:['automatic page localhost denied','JS numeric alias denied','redirect denied','real target 403 not mislabeled','normal target remains readable','wrong origin preflight refused']},null,2));
 console.log(JSON.stringify({passed:true,output:home,localHits,authorizedHits:hits.length}));
}finally{await browser?.close();await manager?.close();for(const s of [local,target]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
