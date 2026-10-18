// Browser regression using the real plugin bundle and installed Harness theme.
// All commands are mocked; never deletes production domains or edits live Jev settings.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.DSH_UI_PLAYWRIGHT ?? path.join(homedir(), '.dsh/capabilities/playwright/node_modules/playwright'));
const output = await mkdtemp(path.join(tmpdir(), 'dsh-ui-settings-'));
// [2026-10-18] 主题改从**运行时实际加载**的那份取：web profile 已升到 0.2.1-rc.1，
// 共享 farm（~/.dsh/profiles/node_modules）仍是 0.1 的主题；两边变量名相同，但对比度回归
// 要对齐真实运行时的配色。按 profile 优先顺序取第一份能解析出默认主题的。
const themeCandidates = [
  path.join(homedir(), '.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  path.join(homedir(), '.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  path.join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
];
let themeSource = null;
for (const candidate of themeCandidates) {
  try { themeSource = await readFile(candidate, 'utf8'); break; } catch { /* 下一个 */ }
}
if (!themeSource) throw new Error(`找不到任何 dsh-client-ui-theme 客户端产物，试过：\n${themeCandidates.join('\n')}`);
const theme = JSON.parse(themeSource.match(/var design_platform_css_default = ("[^\n]*");/)[1]);
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><style>body{margin:0;font-family:system-ui;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#app{height:100vh;width:100%;}*{box-sizing:border-box}</style></head><body><div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
window.__ModuleLoader__={load({factory}){window.plugin=factory(name=>name==='react'?React:name==='react-dom'?ReactDOM:{jsx:(t,p,k)=>React.createElement(t,{...p,key:k}),jsxs:(t,p,k)=>React.createElement(t,{...p,key:k}),Fragment:React.Fragment})}};
window.commands=[];window.failDelete=false;window.failLoad=false;window.failSave=false;window.failTest=false;window.delayDelete=0;
window.settings={enabled:true,endpoint:'https://decision.example/v1/systemone',model:'jev-latest',timeoutMs:120000,apiKey:'test-stored-secret',hasKey:true,riskMode:'on',delegateMode:'shadow',skillMode:'on',browserMode:'off'};
window.rows=[{target:'demo.test',sessions:2,assets:8,findings:1,notes:3,lastUpdated:1791280000000}];
window.src={goal:{id:'goal-1',target:'demo.test',objective:'仅使用合成数据验证前端',authorization:'本地界面测试'},nodes:[],assets:[],edges:[],coverage:[],research:[],checkpoints:[],observations:[],userTodos:[],pendingApprovals:[],infra:{}};
window.infra={proxyUrl:'',httpTimeoutMs:'8000',burpMcpPort:'9876',burpProxyJarPath:'',testAccount:'',testPhone:''};window.overrideKeys=[];window.failInfraRead=false;window.failInfraSave=false;window.failInfraCopy=false;
window.runCommand=async line=>{
 window.commands.push(line);
 if(line==='/src-authoritative-state')return{kind:'success',text:JSON.stringify(src)};
 if(line==='/src-infra-status')return failInfraRead?{kind:'error',text:'模拟回读失败'}:{kind:'success',text:JSON.stringify({infra,overrideKeys,initialized:false,source:{sessionId:'fixture-previous',updatedAt:1791280000000,keys:['proxyUrl','testPhone']}})};
 if(line==='/src-infra-copy'){if(failInfraCopy)return{kind:'error',text:'模拟沿用失败'};infra={...infra,proxyUrl:'http://192.0.2.88:7893',testPhone:'13800138000'};overrideKeys=['proxyUrl','testPhone'];return{kind:'success',text:'已沿用2项配置'}};
 if(line.startsWith('/src-infra ')){if(failInfraSave)return{kind:'error',text:'模拟保存失败'};const [,key,...parts]=line.split(' '),v=parts.join(' ');infra[key]=v==='-'?({httpTimeoutMs:'8000',burpMcpPort:'9876'}[key]??''):v;overrideKeys=overrideKeys.filter(k=>k!==key);if(v!=='-')overrideKeys.push(key);return{kind:'success',text:'已保存'}};
 if(line.startsWith('/src-approve '))return{kind:'success',text:'合成批准成功（未发包）'};
 if(line==='/src-domains')return failLoad?{kind:'error',text:'模拟列表失败'}:{kind:'success',text:JSON.stringify({domains:rows})};
 if(line.startsWith('/src-delete-domain ')){if(delayDelete)await new Promise(r=>setTimeout(r,delayDelete));if(failDelete)return{kind:'error',text:'有任务正在运行，不能删除'};rows=[];return{kind:'success',text:'已清理'}};
 if(line==='/src-decision-status')return{kind:'success',text:JSON.stringify(settings)};
 if(line.startsWith('/src-decision-save ')){if(failSave)return{kind:'error',text:'模拟保存失败'};const n=JSON.parse(line.slice('/src-decision-save '.length));settings={...settings,...n,apiKey:n.clearKey?'':n.apiKey||settings.apiKey};settings.hasKey=!!settings.apiKey;return{kind:'success',text:JSON.stringify(settings)}};
 if(line==='/src-decision-test')return{kind:failTest?'error':'success',text:failTest?'模拟连接失败':'合成连接测试成功，不代表准确率'};
 return{kind:'error',text:'Unexpected mock command'};
};
</script><script src="/bundle.js"></script><script>
let View,dict;
plugin.apply({effect:f=>f(),locale:{register:(_,{zh})=>{dict=zh;return()=>{}},bind:()=>key=>dict[key]??key},sessions:{list:{getSnapshot:()=>({current:'fixture',byId:{fixture:{agentPreset:'src-hunter'}}}),subscribe:()=>()=>{}}},slots:{inject:(_,f)=>f(),register:(_,v)=>{View=v;return()=>{}}}});
const root=ReactDOM.createRoot(document.querySelector('#app'));window.renderSrc=()=>root.render(React.createElement(View,{useProjection:()=>src,t:key=>dict[key]??key,runCommand}));renderSrc();
</script></body></html>`;
const uiModules = path.join(repo, 'src/dsh-client-ui-src/node_modules');
const files = { '/react.js': path.join(uiModules,'react/umd/react.development.js'), '/react-dom.js':path.join(uiModules,'react-dom/umd/react-dom.development.js'), '/bundle.js':path.join(repo,'lib/ui-src.client.js') };
const server = createServer(async (req,res) => {
 try { const data = req.url==='/'?html:req.url==='/theme.css'?theme:files[req.url]?await readFile(files[req.url]):null;
 if(data===null){res.writeHead(404);res.end();return;}
 res.setHeader('content-type', req.url==='/theme.css'?'text/css':req.url==='/'?'text/html':'text/javascript');res.end(data);
 }catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({executablePath:process.env.DSH_UI_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const errors=[]; const evidence=[];
try {
 const context = await browser.newContext({viewport:{width:1365,height:1050}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>{errors.push('Native prompt appeared');void d.dismiss()});
 await p.goto(base);await p.getByTestId('src-tab-infra').click();
 await p.getByLabel('决策模型',{exact:true}).waitFor();
 assert.equal(await p.getByLabel('决策 API key',{exact:true}).inputValue(),'');
 assert.equal(await p.getByLabel('决策 API key',{exact:true}).getAttribute('type'),'password');
 await p.getByRole('button',{name:'显示密钥',exact:true}).click();
 assert.equal(await p.getByLabel('已保存的 API key',{exact:true}).inputValue(),'test-stored-secret');
 await p.getByRole('button',{name:'隐藏密钥',exact:true}).click();
 assert.equal(await p.getByLabel('已保存的 API key',{exact:true}).count(),0);
 const contrast = locator => locator.evaluate(el=>{
  const s=getComputedStyle(el), rgb=c=>c.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}),lum=c=>{const [r,g,b]=rgb(c);return r*.2126+g*.7152+b*.0722};
  const fg=lum(s.color), bg=lum(s.backgroundColor);return {fg:s.color,bg:s.backgroundColor,ratio:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
 });
 for(const dark of [false,true]){
  await p.emulateMedia({colorScheme:dark?'dark':'light'});
  await p.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark);
  const c=await contrast(p.getByTestId('src-view-report')); assert.ok(c.ratio>=4.5,JSON.stringify(c));evidence.push({theme:dark?'dark':'light',report:c});
  await p.getByLabel('决策模型',{exact:true}).fill('jev-draft');
  const save=await contrast(p.getByRole('button',{name:'保存决策设置',exact:true}));assert.ok(save.ratio>=4.5);
  await p.getByTestId('decision-settings').screenshot({path:path.join(output,`jev-${dark?'dark':'light'}.png`)});
 }
 await p.getByRole('group',{name:'HTTP 风险审批'}).getByRole('button',{name:'观测',exact:true}).click();
 await p.getByRole('group',{name:'主 / 子代理分工'}).getByRole('button',{name:'关闭',exact:true}).click();
 await p.getByRole('group',{name:'Skill 文档推荐'}).getByRole('button',{name:'观测',exact:true}).click();
 await p.getByRole('group',{name:'Browser 候选选择'}).getByRole('button',{name:'生效',exact:true}).click();
 await p.getByRole('button',{name:'测试已保存的连接',exact:true}).click();
 assert.equal(await p.getByLabel('决策模型',{exact:true}).inputValue(),'jev-draft','test must not discard draft');
 await p.getByRole('button',{name:'保存决策设置',exact:true}).click();
 await p.getByText('已全局保存。下一次调用立即生效，无需重启。').waitFor();
 const saveCommand=await p.evaluate(()=>commands.findLast(c=>c.startsWith('/src-decision-save ')));
 const payload=JSON.parse(saveCommand.slice('/src-decision-save '.length));assert.equal(payload.model,'jev-draft');assert.equal(payload.riskMode,'shadow');assert.equal(payload.delegateMode,'off');assert.equal(payload.skillMode,'shadow');assert.equal(payload.browserMode,'on');assert.ok(!('apiKey' in payload),'stored key must not be echoed back');
 await p.getByLabel('决策 API key',{exact:true}).fill('test-new-secret');
 await p.getByRole('button',{name:'显示密钥',exact:true}).click();assert.equal(await p.getByLabel('决策 API key',{exact:true}).getAttribute('type'),'text');
 await p.getByRole('button',{name:'保存决策设置',exact:true}).click();await p.getByText('配置已同步',{exact:true}).waitFor();
 assert.equal(await p.getByLabel('决策 API key',{exact:true}).inputValue(),'');
 await p.getByRole('button',{name:'显示密钥',exact:true}).click();assert.equal(await p.getByLabel('已保存的 API key',{exact:true}).inputValue(),'test-new-secret');
 await p.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await p.getByLabel('已保存的 API key',{exact:true}).count(),0);
 await p.getByLabel('保存时清除已保存的 key').check();await p.getByRole('button',{name:'保存决策设置',exact:true}).click();await p.getByText('尚未配置密钥',{exact:true}).waitFor();
 await p.evaluate(()=>{failSave=true;failTest=true});await p.getByLabel('决策模型',{exact:true}).fill('keep-after-failure');await p.getByRole('button',{name:'保存决策设置',exact:true}).click();await p.getByRole('alert').getByText('模拟保存失败').waitFor();assert.equal(await p.getByLabel('决策模型',{exact:true}).inputValue(),'keep-after-failure');
 await p.getByRole('button',{name:'测试已保存的连接',exact:true}).click();await p.getByRole('alert').getByText('模拟连接失败').waitFor();
 await p.setViewportSize({width:390,height:844});await p.getByTestId('decision-settings').screenshot({path:path.join(output,'jev-mobile.png')});
 assert.ok(await p.evaluate(()=>document.querySelector('[data-testid=decision-settings]').scrollWidth<=document.querySelector('[data-testid=decision-settings]').clientWidth+1));
 // Infra copy/readback must work without a projection update and before a goal exists.
 const infraPanel=p.getByTestId('src-infrastructure');
 await infraPanel.getByLabel('HTTP 代理',{exact:true}).waitFor();
 assert.equal(await infraPanel.getByLabel('HTTP 代理',{exact:true}).inputValue(),'');
 await infraPanel.getByRole('button',{name:'沿用上次配置',exact:true}).click();
 await p.getByText('已沿用2项配置',{exact:true}).waitFor();
 assert.equal(await infraPanel.getByLabel('HTTP 代理',{exact:true}).inputValue(),'http://192.0.2.88:7893');
 assert.equal(await infraPanel.getByLabel('测试手机号',{exact:true}).inputValue(),'13800138000');
 const proxyForm=infraPanel.locator('form').filter({has:p.getByLabel('HTTP 代理',{exact:true})});
 assert.equal(await proxyForm.getByRole('button',{name:'保存',exact:true}).isEnabled(),false,'unmodified save cannot clear resolved value');
 await infraPanel.getByLabel('HTTP 代理',{exact:true}).fill('http://192.0.2.99:7894');
 await p.evaluate(()=>{failInfraSave=true});await proxyForm.getByRole('button',{name:'保存',exact:true}).click();await infraPanel.getByRole('alert').waitFor();assert.equal(await infraPanel.getByLabel('HTTP 代理',{exact:true}).inputValue(),'http://192.0.2.99:7894');await p.evaluate(()=>{failInfraSave=false});
 assert.equal(await infraPanel.getByRole('button',{name:'沿用上次配置',exact:true}).isEnabled(),false);
 await proxyForm.getByRole('button',{name:'保存',exact:true}).click();await p.getByText('已保存',{exact:true}).first().waitFor();
 assert.equal(await infraPanel.getByLabel('HTTP 代理',{exact:true}).inputValue(),'http://192.0.2.99:7894');
 await proxyForm.getByRole('button',{name:'恢复默认',exact:true}).click();await p.waitForFunction(()=>infra.proxyUrl==='');
 await infraPanel.getByRole('button',{name:'刷新配置',exact:true}).click();assert.equal(await infraPanel.getByLabel('HTTP 代理',{exact:true}).inputValue(),'');
 await p.evaluate(()=>{failInfraCopy=true});await infraPanel.getByRole('button',{name:'沿用上次配置',exact:true}).click();await infraPanel.getByRole('alert').waitFor();assert.match(await infraPanel.getByRole('alert').innerText(),/模拟沿用失败/);
 await p.evaluate(()=>{failInfraCopy=false;failInfraRead=true});await infraPanel.getByRole('button',{name:'沿用上次配置',exact:true}).click();await p.getByText(/但回读失败/).waitFor();
 await p.evaluate(()=>{failInfraRead=false});await infraPanel.getByRole('button',{name:'刷新配置',exact:true}).click();await p.waitForFunction(()=>document.querySelector('#infra-proxyUrl').value==='http://192.0.2.88:7893');
 await p.setViewportSize({width:1365,height:1050});await infraPanel.screenshot({path:path.join(output,'infra-dark.png')});
 await p.setViewportSize({width:390,height:844});await infraPanel.screenshot({path:path.join(output,'infra-mobile.png')});assert.ok(await infraPanel.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 await p.getByTestId('src-tab-overview').click();await p.getByTestId('src-tab-infra').click();
 await p.waitForFunction(()=>document.querySelector('#infra-proxyUrl')?.value==='http://192.0.2.88:7893');
 await p.getByTestId('src-tab-domains').click();await p.getByRole('button',{name:'删除域数据',exact:true}).click();
 const dialog=p.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('input').count(),0);
 assert.equal(await p.evaluate(()=>document.activeElement.textContent),'取消');
 await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>document.activeElement.textContent),'确认删除域数据');
 await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>commands.filter(c=>c.startsWith('/src-delete-domain ')).length),0);
 await p.setViewportSize({width:1365,height:1050});
 await p.getByRole('button',{name:'删除域数据',exact:true}).click();
 for(const dark of [false,true]){await p.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark);const c=await contrast(dialog.getByRole('button',{name:'确认删除域数据'}));assert.ok(c.ratio>=4.5);await dialog.screenshot({path:path.join(output,`delete-${dark?'dark':'light'}.png`)});}
 await p.evaluate(()=>{failDelete=true});await dialog.getByRole('button',{name:'确认删除域数据'}).click();await dialog.getByRole('alert').waitFor();assert.match(await dialog.innerText(),/有任务正在运行/);
 await p.evaluate(()=>{failDelete=false;delayDelete=600});await dialog.getByRole('button',{name:'确认删除域数据'}).dblclick();await p.getByText('暂无 SRC 域数据',{exact:true}).waitFor();
 assert.deepEqual(await p.evaluate(()=>commands.filter(c=>c.startsWith('/src-delete-domain '))),['/src-delete-domain demo.test confirm demo.test','/src-delete-domain demo.test confirm demo.test']);
 await p.evaluate(()=>{src.pendingApprovals=[{id:'approval-1',method:'TASK',url:'src-egress://fixture',category:'egress/task',status:'pending',createdAt:1,updatedAt:1,reason:'执行前判定'+JSON.stringify({effect:'destructive',risk:'high',action:'pending',fallback:false,mode:'on'}),justification:'操作目的（模型说明）：无意义模板不要显示',body:JSON.stringify({entries:[{request:{method:'POST',url:'https://fixture.invalid/render',headers:{'content-type':'application/json'},body:'synthetic destructive fixture'}}],safety:null})}];renderSrc();});
 await p.getByTestId('src-tab-todos').click();const card=p.getByTestId('src-approval-card');await card.waitFor();
 assert.match(await card.innerText(),/可能修改或删除目标数据/);
 assert.match(await card.innerText(),/发送前中断可恢复/);
 for(const label of ['操作目的（模型说明）','可能后果','恢复条件','为什么需要确认','无意义模板'])assert.ok(!(await card.innerText()).includes(label));
 assert.equal(await card.locator('details[open]').count(),0);
 assert.equal(await card.getByText('查看执行边界状态',{exact:true}).count(),1);
 assert.equal(await card.getByRole('button',{name:'需补执行材料'}).count(),0);
 assert.equal(await card.getByRole('button',{name:'批准并执行一次',exact:true}).isEnabled(),true);
 await p.evaluate(()=>{const frozen=JSON.parse(src.pendingApprovals[0].body);frozen.safety={effect:'compute',object:'错误的计算说明'};src.pendingApprovals[0].body=JSON.stringify(frozen);renderSrc();});
 assert.equal(await card.getByRole('button',{name:'需补执行材料'}).count(),0);
 assert.equal(await card.getByRole('button',{name:'批准并执行一次',exact:true}).isEnabled(),true);
 assert.equal(await card.getByRole('button',{name:'拒绝',exact:true}).isEnabled(),true);
 await p.evaluate(()=>{src.pendingApprovals[0].reason='执行前判定'+JSON.stringify({effect:'unknown',risk:'unknown',action:'pending',fallback:false,mode:'on',hardVeto:false});src.pendingApprovals[0].body=JSON.stringify({entries:[{maxRequests:1,request:{method:'POST',url:'https://fixture.invalid/render',headers:{'content-type':'application/json'},body:'{"template":12345}'}}],safety:null});renderSrc();});
 assert.equal(await card.getByRole('button',{name:'确认低影响并放行',exact:true}).isEnabled(),true);
 await card.getByText('查看技术判定',{exact:true}).click();
 assert.match(await card.innerText(),/template（数字）/);
 await card.getByRole('button',{name:'确认低影响并放行',exact:true}).click();
 await card.getByRole('button',{name:'确认无副作用，发送一次',exact:true}).click();
 assert.ok(await p.evaluate(()=>commands.includes('/src-approve approval-1 allow-read')));
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',userDecision:'allow',executionState:'failed-before-send',executionError:'SRC_GATE_RESOURCE_REQUIRES_REVIEW'};renderSrc();});
 assert.equal(await card.getByRole('button',{name:'核验未发送并重试',exact:true}).isEnabled(),true);
 await card.getByRole('button',{name:'核验未发送并重试',exact:true}).click();await card.getByRole('button',{name:'确认无副作用，发送一次',exact:true}).click();

 assert.equal(await card.getByRole('button',{name:'拒绝',exact:true}).isEnabled(),true);
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',executionState:'authorized',executionError:''};renderSrc();});
 assert.equal(await card.getByRole('button',{name:'核验并继续执行',exact:true}).isEnabled(),true);
 assert.equal(await card.getByRole('button',{name:'拒绝',exact:true}).isEnabled(),true);
 await card.getByRole('button',{name:'拒绝',exact:true}).click();await card.getByRole('button',{name:'确认拒绝',exact:true}).click();
 assert.ok(await p.evaluate(()=>commands.includes('/src-approve approval-1 reject')));
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],executionState:'unknown',executionError:'ECONNREFUSED'};renderSrc();});
 await card.getByText('执行记录：ECONNREFUSED',{exact:true}).waitFor();
 assert.match(await card.innerText(),/ECONNREFUSED/);assert.match(await card.innerText(),/请求可能已经发送但结果未知/);
 assert.equal(await card.getByRole('button').count(),0);
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',executionState:'failed-before-send',executionError:'SRC_GATE_RESOURCE_REQUIRES_REVIEW'};renderSrc();});
 await p.setViewportSize({width:390,height:844});assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await card.screenshot({path:path.join(output,'approval-compact-mobile.png')});
 await card.getByText('查看冻结请求（脱敏，非抓包）',{exact:true}).click();assert.match(await card.innerText(),/template/);
 await card.getByText('查看冻结请求（脱敏，非抓包）',{exact:true}).click();
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',executionState:'failed-before-send'};renderSrc();});await card.getByText('未发送',{exact:true}).waitFor();
 // [local.106] Jev 面板：数据只来自权威快照（src.jev），只读视图（不发命令）、未知值渲染原文、缺 jev 走空态。
 const commandsBeforeJev = await p.evaluate(()=>commands.length);
 await p.evaluate(()=>{src.jev={stats:{total:9,byTask:{'risk-grade':6,'skill-activate':2,unsupported:1},byAction:{allow:5,pending:2,skip:2},byEffect:{read:5,unknown:2,write:2},bySource:{jev:8,local:1},byModel:{'jev-latest':8,'judge-x':1},byMode:{on:7,shadow:2},fallback:2,errors:{'http-503':1,'circuit-open':1},latency:{count:9,sum:2700,max:800,last:120},offered:2,adopted:1,offeredByTask:{'skill-activate':2},adoptedByTask:{'skill-activate':1},startedAt:1,updatedAt:2,lastAt:2,decisionSeq:9,last:null},recent:[
  {seq:9,kind:'decision',at:1791280000000,taskType:'risk-grade',action:'allow',effect:'read',risk:'low',source:'jev',provider:'systemone',model:'jev-latest',fallback:false,mode:'on',subject:'GET demo.test/api/users'},
  {seq:8,kind:'decision',at:1791279000000,taskType:'scan-plan',action:'pending',effect:'unknown',source:'jev',provider:'systemone',model:'judge-x',fallback:true,errorType:'http-503',mode:'on',subject:'3 个请求 · demo.test/api'},
  {seq:7,kind:'offer',at:1791278000000,taskType:'skill-activate',action:'skip',effect:'unknown',source:'jev',provider:'systemone',model:'jev-latest',fallback:false,mode:'on',subject:'短信轰炸 / 无频率限制',skillId:'lesson:sms-bomb@fixture',recommendationId:'skillrec-3'},
  {seq:6,kind:'tampered',at:0,taskType:'unknown-task',action:'',effect:'',source:'',provider:'',model:'',fallback:false,mode:'',subject:''}
 ]};renderSrc();});
 await p.setViewportSize({width:1365,height:1050});
 await p.getByTestId('src-tab-jev').click();
 const jev=p.getByTestId('src-jev');await jev.waitFor();
 assert.equal(await p.getByTestId('src-jev-total').innerText(),'9');
 assert.equal(await p.getByTestId('src-jev-fallback').innerText(),'2');
 assert.equal(await p.getByTestId('src-jev-latency').innerText(),'300 ms');
 assert.equal(await p.getByTestId('src-jev-adopt').innerText(),'1 / 2');
 const zh=await p.evaluate(()=>dict);
 assert.match(await p.getByTestId('src-jev-task-unsupported').innerText(),new RegExp(zh['jev.task.unsupported']));
 assert.match(await p.getByTestId('src-jev-task-unsupported').innerText(),/1\b/);
 assert.match(await p.getByTestId('src-jev-by-model').innerText(),/judge-x/,'未知模型键必须原样显示（不做词条查询）');
 const rows=p.getByTestId('src-jev-row');assert.equal(await rows.count(),4);
 assert.equal(await rows.nth(0).getAttribute('data-fallback'),'false');
 assert.equal(await rows.nth(0).innerText().then(s=>s.includes('GET demo.test/api/users')),true);
 assert.equal(await rows.nth(1).getAttribute('data-fallback'),'true');assert.match(await rows.nth(1).innerText(),/http-503/);
 assert.equal(await rows.nth(3).getAttribute('data-kind'),'tampered');
 assert.match(await rows.nth(3).innerText(),/unknown-task/,'未知职责必须原样显示');
 assert.equal(/jev\.[a-z]/.test(await jev.innerText()),false,'未知值不得触发词条查询（会渲染成原始键名）');
 assert.deepEqual(await p.evaluate(n=>commands.slice(n),commandsBeforeJev),[],'Jev 面板是只读视图，不得发任何命令');
 for(const dark of [false,true]){
  await p.evaluate(d=>document.body.toggleAttribute('data-ds-dark-theme',d),dark);
  const c=await contrast(p.getByTestId('src-jev-metric-total'));assert.ok(c.ratio>=4.5,JSON.stringify(c));evidence.push({theme:dark?'dark':'light',jev:c});
  await jev.screenshot({path:path.join(output,`jev-tab-${dark?'dark':'light'}.png`)});
 }
 await p.setViewportSize({width:390,height:844});assert.ok(await jev.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await jev.screenshot({path:path.join(output,'jev-tab-mobile.png')});
 await p.setViewportSize({width:1365,height:1050});
 /* 旧状态（本改动之前建立的会话/checkpoint）没有 jev：必须走空态，不崩、不查词条。 */
 await p.evaluate(()=>{delete src.jev;renderSrc();});
 await p.getByTestId('src-jev-empty').waitFor();
 assert.equal(await p.getByTestId('src-jev-total').count(),0);
 assert.equal(await p.getByTestId('src-jev-row').count(),0);
 assert.equal(/jev\.[a-z]/.test(await p.getByTestId('src-jev').innerText()),false);
 assert.deepEqual(await p.evaluate(n=>commands.slice(n),commandsBeforeJev),[]);
 await p.getByTestId('src-view-report').click();await p.getByTestId('src-report').waitFor();
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,evidence,errors,checks:['compact-approval-real-reason/mobile/request-details/not-sent','infra-copy-readback-pre-goal','infra-save/reset/failures','infra-mobile/tab-remount','saved-key-reveal/hide/blur','save/clear/retain-key','four-modes','test-preserves-draft','failure-feedback','mobile','dark/light-contrast','delete-cancel/esc/focus','delete-no-input','delete-error/retry/double-click','jev-tab-readonly/metrics/recent/unknown-values/empty-state/mobile/dark-light','report-navigation']},null,2));
 console.log(JSON.stringify({passed:true,output,evidence},null,2));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
