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
const themeSource = await readFile(path.join(homedir(), '.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'), 'utf8');
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
 assert.match(await card.innerText(),/识别到删除或破坏性操作/);
 for(const label of ['操作目的（模型说明）','可能后果','恢复条件','为什么需要确认','无意义模板'])assert.ok(!(await card.innerText()).includes(label));
 assert.equal(await card.locator('details[open]').count(),0);
 assert.equal(await card.getByRole('button',{name:'需补执行材料'}).isDisabled(),true);
 await p.evaluate(()=>{src.pendingApprovals[0].reason='执行前判定'+JSON.stringify({effect:'unknown',risk:'unknown',action:'pending',fallback:false,mode:'on',hardVeto:false});src.pendingApprovals[0].body=JSON.stringify({entries:[{maxRequests:1,request:{method:'POST',url:'https://fixture.invalid/render',headers:{'content-type':'application/json'},body:'{"template":12345}'}}],safety:null});renderSrc();});
 assert.equal(await card.getByRole('button',{name:'确认低影响并放行',exact:true}).isEnabled(),true);
 assert.match(await card.innerText(),/template（数字）/);
 await card.getByRole('button',{name:'确认低影响并放行',exact:true}).click();
 await card.getByRole('button',{name:'确认无副作用，发送一次',exact:true}).click();
 assert.ok(await p.evaluate(()=>commands.includes('/src-approve approval-1 allow-read')));
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',userDecision:'allow',executionState:'failed-before-send',executionError:'SRC_GATE_RESOURCE_REQUIRES_REVIEW'};renderSrc();});
 assert.equal(await card.getByRole('button',{name:'核验未发送并重试',exact:true}).isEnabled(),true);
 await card.getByRole('button',{name:'核验未发送并重试',exact:true}).click();await card.getByRole('button',{name:'确认无副作用，发送一次',exact:true}).click();

 assert.equal(await card.getByRole('button',{name:'拒绝',exact:true}).isEnabled(),true);
 await p.setViewportSize({width:390,height:844});assert.ok(await card.evaluate(e=>e.scrollWidth<=e.clientWidth+1));await card.screenshot({path:path.join(output,'approval-compact-mobile.png')});
 await card.getByText('查看冻结请求（脱敏，非抓包）',{exact:true}).click();assert.match(await card.innerText(),/template/);
 await card.getByText('查看冻结请求（脱敏，非抓包）',{exact:true}).click();
 await p.evaluate(()=>{src.pendingApprovals[0]={...src.pendingApprovals[0],status:'approved',executionState:'failed-before-send'};renderSrc();});await card.getByText('未发送',{exact:true}).waitFor();
 await p.getByTestId('src-view-report').click();await p.getByTestId('src-report').waitFor();
 assert.deepEqual(errors,[]);
 await writeFile(path.join(output,'results.json'),JSON.stringify({passed:true,evidence,errors,checks:['compact-approval-real-reason/mobile/request-details/not-sent','infra-copy-readback-pre-goal','infra-save/reset/failures','infra-mobile/tab-remount','saved-key-reveal/hide/blur','save/clear/retain-key','four-modes','test-preserves-draft','failure-feedback','mobile','dark/light-contrast','delete-cancel/esc/focus','delete-no-input','delete-error/retry/double-click','report-navigation']},null,2));
 console.log(JSON.stringify({passed:true,output,evidence},null,2));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
