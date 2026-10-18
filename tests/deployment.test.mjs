import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../scripts/deployment-manifest.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
test('源码卫生检查识别无常见前缀的FOFA凭据，诊断不含凭据原文',async()=>{
 const {sourceHygieneIssues}=await import('../scripts/check-source-hygiene.mjs');
 const secret='a'.repeat(32), source=`settings:\n  fofaKeyBackup2: ${secret}\n`;
 assert.deepEqual(sourceHygieneIssues(source),[{kind:'配置凭据',line:2}]);
 assert.ok(!JSON.stringify(sourceHygieneIssues(source)).includes(secret));
 assert.equal(sourceHygieneIssues(`{"apiKey":"${secret}"}`).length,1);
 assert.equal(sourceHygieneIssues(`fofaKey: ""\napiKey: YOUR_EXAMPLE_API_KEY_HERE`).length,0);
 assert.equal(sourceHygieneIssues('ip: '+[10,0,0,1].join('.')).length,1);
 assert.equal(sourceHygieneIssues('ip: 192.0.2.1').length,0);
 assert.equal(sourceHygieneIssues('apiKey:process.env.JEV_API_KEY').length,0);
});
test('发布回归同时执行源码卫生与预设防膨胀检查',async()=>{
 const {execFileSync}=await import('node:child_process');
 for(const script of ['scripts/check-source-hygiene.mjs','scripts/check-preset-consistency.mjs'])
  execFileSync(process.execPath,[script],{cwd:repo,encoding:'utf8',stdio:'pipe'});
});
test('0.2 行表视图由生成器产出：不含 0.1 专有插件，两个运行时的引擎行都还在自己那份里',async()=>{
 const {renderView,viewDiff,VIEW_FILE,SOURCE_FILE,DROP_MARKER}=await import('../scripts/gen-preset-02.mjs');
 const read=(file)=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
 const body=(text)=>text.split('\n').filter((line)=>!/^\s*#/.test(line)).join('\n');
 const source=read(SOURCE_FILE), view=read(VIEW_FILE);
 assert.equal(viewDiff(repo),'', '视图必须与真源同步（跑 npm run preset:02:build）');
 assert.equal(view,renderView(source));
 assert.ok(source.includes(DROP_MARKER));
 assert.match(body(view),/@deepseek-ai\/dsh-workflow-ptc/, '0.2 视图必须留住 0.2 的工作流引擎行');
 assert.doesNotMatch(body(view),/@deepseek-ai\/dsh-workflow-worker-thread/, '0.2 视图正文不得出现 0.1 专有引擎——0.2 的策略闸会把整份 include 丢掉');
 assert.match(body(source),/@lihua_dis\/dsh-src/, '真源必须留住 src 行');
 assert.match(body(view),/@lihua_dis\/dsh-src\/src/,'真源与视图都必须留住 src 插件行');
 const patch=read('cordis.patch.yml');
 assert.match(patch,/agent-02\.cordis\.yml'/, '0.2 声明行的 include 必须指向生成视图');
 assert.doesNotMatch(patch,/preset\/src-hunter\/agent\.cordis\.yml'/, '0.2 声明行的 include 不得直接指向真源（含 0.1 专有行）');
});
test('deployment includes every runtime entry and the Python inspection addon',()=>{
 const files=runtimeFiles(repo);
 for(const entry of ['lib/src-egress.js','lib/src-bash-executor.js','lib/src/egress/manager.js','lib/src/egress/mitm-addon.py','lib/src/egress/browser-worker.cjs','lib/ui-src.client.js'])assert.ok(files.includes(entry),entry);
 assert.equal(files.length,new Set(files).size);
 assert.ok(files.every(file=>!file.includes('__pycache__')));
 const deployment=readFileSync(new URL('../scripts/deploy.mjs',import.meta.url),'utf8');
 assert.match(deployment,/runtimeFiles\(repo\)/);
});
test('deployment cannot auto-start the retired Laya daemon',()=>{
 const deployment=readFileSync(new URL('../scripts/deploy.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(deployment,/spawn\(|srcLayaDecisionFlag/);
});

test('Web launcher 用 profile 自带的 0.2 host 启动，就绪探针不依赖 0.1 专有端点',()=>{
 const script=readFileSync(new URL('../scripts/start-dsh-web.sh',import.meta.url),'utf8');
 // 注释里会提到旧端点名（解释为什么不那么写），所以负向断言只看可执行正文。
 const body=(text)=>text.split('\n').filter((line)=>!/^\s*#/.test(line)).join('\n');
 assert.match(script,/detached:true/);
 assert.match(script,/child\.unref\(\)/);
 assert.match(script,/commands?=|command=/);
 assert.doesNotMatch(script,/xargs kill|kill \"\$OLD\".*sleep 1/);
 assert.match(script,/profiles\/web\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/,'必须用 profile 自带的 0.2 host：全局 dsh 只有 0.1，起不了 0.2 web');
 assert.doesNotMatch(body(script),/management\.html/,'0.2 已无 management.html，留着会让就绪探针永远 404');
 assert.match(body(script),/"\$CODE" = 401/,'0.2 回环也鉴权：401 = 服务已监听，与 200 同为就绪');
 assert.match(body(script),/"\$CODE" = 200/,'仍要接受带 token 时的 200');
 assert.match(script,/check-web-idle\.mjs/,'重启前必须跑空闲探测');
 assert.match(script,/DSH_WEB_FORCE/,'0.2 无单方法 RPC 时探测失败是预期，必须有显式强推开关');
});
test('空闲守卫两层探测并在探测不可用时 fail-closed',()=>{
 const script=readFileSync(new URL('../scripts/check-web-idle.mjs',import.meta.url),'utf8');
 assert.match(script,/\/api\/\$\{method\}/,'第一层仍是 0.1 的单方法 RPC');
 assert.match(script,/session_projcache/,'第二层读 host 侧投影缓存');
 assert.match(script,/openTurnStartSeq/,'用进行中的轮次判定忙闲');
 assert.match(script,/exitCode = 3/,'两层都不可用必须 fail-closed，不得默认空闲');
});
test('投影缓存只认 openTurnStartSeq；陈旧 openStep 不算忙',async()=>{
 const {summarizeProjection}=await import('../scripts/check-web-idle.mjs');
 const entry=(id,openTurnStartSeq,openStep,ageMs=1000)=>({id,openTurnStartSeq,openStep,ageMs});
 const step={turn:1,step:3};
 const result=summarizeProjection([
  entry('busy',42,step,2000),
  entry('stale',null,step,9e8),   // 真实环境 486 份投影里有 70 份这种崩溃残留
  entry('idle',null,null),
 ]);
 assert.deepEqual(result.busy.map(row=>row.id),['busy'],'只有 openTurnStartSeq 非空才算忙');
 assert.equal(result.staleOpenSteps.length,1,'陈旧 openStep 单独统计，用来诊断但不是忙');
 assert.equal(result.oldestBusyAgeMs,2000);
 assert.deepEqual(summarizeProjection([entry('x',null,step,9e8)]).busy,[]);
});

test('npm package keeps runtime assets but excludes evaluation fixtures and raw evidence',async()=>{
 const {execFileSync}=await import('node:child_process');
 const raw=JSON.parse(execFileSync('npm',['pack','--dry-run','--json','--ignore-scripts'],{cwd:repo,encoding:'utf8',maxBuffer:16*1024*1024}));
 const packed=Array.isArray(raw)?raw[0]:raw['@lihua_dis/dsh-src'];
 assert.ok(packed&&Array.isArray(packed.files),'Unsupported npm pack JSON');
 const entries=new Set(packed.files.map(file=>file.path));
 for(const name of runtimeFiles(repo))assert.ok(entries.has(name),'Not included in npm package: '+name);
 for(const name of [
  'lib/src/egress/browser-worker.cjs', 'scripts/caps-sync.mjs',
  'scripts/start-dsh-web.sh', 'scripts/check-web-idle.mjs',
  'scripts/deploy.mjs', 'scripts/deployment-manifest.mjs', 'scripts/deployment-preflight.mjs',
  'scripts/run-blind-eval.mjs', 'scripts/blind-eval-plugin.mjs', 'tests/blind-range.mjs',
  'tools/burp-mcp-bridge.mjs', 'preset/src-hunter/agent.cordis.yml', 'preset/src-hunter/preset.yml',
  'cordis.patch.yml', 'capabilities.yaml.example', 'docs/CAPABILITIES.md', 'docs/INSTALL-PROMPT.md',
 ])assert.ok(entries.has(name),'Required package asset missing: '+name);
 for(const prefix of ['docs/evaluation/','docs/implementation/','scripts/egress-feasibility/']){
  assert.ok(![...entries].some(name=>name.startsWith(prefix)),'Development-only directory shipped: '+prefix);
 }
});

test('deployment preflight checks the complete plan without modifying any destination',async t=>{
 const {preflightCopyPlan}=await import('../scripts/deployment-preflight.mjs');
 const fs=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const root=fs.mkdtempSync(path.join(tmpdir(),'deploy-preflight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const src=path.join(root,'source'),dest=path.join(root,'target');fs.writeFileSync(src,'new');fs.writeFileSync(dest,'old');
 assert.throws(()=>preflightCopyPlan({copies:[{src,dest},{src:path.join(root,'missing'),dest:path.join(root,'later')}]}),/Missing source/);
 assert.equal(fs.readFileSync(dest,'utf8'),'old');assert.equal(fs.existsSync(path.join(root,'later')),false);
 assert.throws(()=>preflightCopyPlan({copies:[{src,dest}],requiredDirectories:[path.join(root,'missing-profile','lib')]}),/Missing required directory/);
 assert.throws(()=>preflightCopyPlan({copies:[{src,dest:src}]}),/identical/);
 assert.throws(()=>preflightCopyPlan({copies:[{src,dest},{src:dest,dest}]}),/Conflicting destination/);
 assert.throws(()=>preflightCopyPlan({copies:[{src,dest:path.join(dest,'child')}]}),/parent is not a directory/);
 assert.deepEqual(preflightCopyPlan({copies:[{src,dest:path.join(root,'new-dir','file')}],requiredDirectories:[root]}),{files:1,destinations:1});
 assert.equal(fs.existsSync(path.join(root,'new-dir')),false);
 const script=readFileSync(new URL('../scripts/deploy.mjs',import.meta.url),'utf8');
 assert.ok(script.indexOf('const preflight=')<script.indexOf('copyFileSync(f.abs, destination)'));
 assert.match(script,/if\(checkOnly\)/);
});

test('test metrics select only the DSH subtree and report RSS without recording argv',async()=>{
 const {summarizeProcessTree}=await import('../scripts/egress-feasibility/process-tree-metrics.mjs');
 const raw=' 13 12 30 /path/Browser Helper\n 10 1 100 /bin/node\n 12 10 50 /bin/python3\n 9 1 99999 /private/unrelated\ninvalid\n';
 const metrics=summarizeProcessTree(raw,10);
 assert.equal(metrics.processCount,3);assert.equal(metrics.totalRssKiB,180);assert.equal(metrics.rootRssKiB,100);
 assert.equal(metrics.processes[0].executable,'Browser Helper');assert.ok(!JSON.stringify(metrics).includes('unrelated'));
 assert.equal(summarizeProcessTree(raw,99).rootPresent,false);
 assert.equal(summarizeProcessTree(raw,10,[13]).totalRssKiB,150);
});

test('评测报告写入独立临时目录，不污染源码或当前工作目录',async t=>{
 const fs=await import('node:fs');const {tmpdir}=await import('node:os');const path=await import('node:path');const {spawnSync}=await import('node:child_process');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(),'dsh-report-location-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cwd=path.join(root,'workspace'),home=path.join(root,'home'),output=path.join(root,'output');
 for(const dir of [cwd,home,output])fs.mkdirSync(dir);
 // 使用全新且未配置决策服务的DSH_HOME；只验证落盘位置，不访问供应商或目标。
 for(const [script,count,key,status] of [['scripts/egress-feasibility/advisor-probe.mjs',12,'advice',0],['scripts/check-jev-authorization.mjs',10,'decision',2]]){
  const child=spawnSync(process.execPath,[path.join(repo,script)],{cwd,env:{...process.env,DSH_HOME:home,TMPDIR:output,TMP:output,TEMP:output},encoding:'utf8',timeout:10000});
  assert.equal(child.status,status,child.stderr);assert.equal(child.error,undefined);
  const reportPath=child.stdout.split('\n').find(line=>line.startsWith('测试产物：'))?.slice('测试产物：'.length);
  assert.ok(reportPath,child.stdout);assert.ok(reportPath.startsWith(output+path.sep));
  const rows=JSON.parse(fs.readFileSync(reportPath,'utf8'));assert.equal(rows.length,count);
  assert.ok(rows.every(row=>row[key].errorType==='disabled'),'不得访问真实决策服务');
  assert.deepEqual(fs.readdirSync(cwd),[],'不能在调用目录创建docs或测试产物');
  if(process.platform!=='win32')assert.equal(fs.statSync(reportPath).mode&0o777,0o600);
 }
});

/* [local.130] 0.2 的 preset 机制换代后，同一份行表要同时服务两个运行时：
 * 0.1 走 `preset-root` 目录发现（resolvedRoots），0.2 走 cordis.patch.yml 里的
 * `@deepseek-ai/dsh-agent-preset` 声明行 + `cordis:include` 指向同一份 agent.cordis.yml。
 * 两侧靠行级 `disabled: !!js` 闸互斥（闸在叶子插件加载时才求值），所以这里把闸表达式抽出来，
 * 用假的进程入口分别模拟两个运行时：入口能解析 @deepseek-ai/dsh-agent-preset = 0.2。 */
test('preset 行表与 0.2 声明行的 !!js 闸在两个运行时上互斥启用',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const nodeModule=await import('node:module');
 const marker=mkdtempSync(join(tmpdir(),'dsh-o2-marker-')), bare=mkdtempSync(join(tmpdir(),'dsh-o1-marker-'));
 mkdirSync(join(marker,'node_modules/@deepseek-ai/dsh-agent-preset'),{recursive:true});
 writeFileSync(join(marker,'node_modules/@deepseek-ai/dsh-agent-preset/package.json'),JSON.stringify({name:'@deepseek-ai/dsh-agent-preset',version:'0.0.0-test'}));
 const evaluate=(expr,entry)=>new Function('process',`return (${expr});`)({argv:['node',entry],platform:process.platform,getBuiltinModule:(id)=>id==='node:module'?nodeModule:undefined});
 const on01=(expr)=>evaluate(expr,join(bare,'entry.js'));
 const on02=(expr)=>evaluate(expr,join(marker,'entry.js'));
 const gates=new Map();
 let current=null;
 for(const line of readFileSync(new URL('../preset/src-hunter/agent.cordis.yml',import.meta.url),'utf8').split('\n')){
  const row=/^(\s*)- id: (\S+)\s*$/.exec(line);
  if(row){current=row[2];continue;}
  const gate=/^\s*disabled: !!js (.+)$/.exec(line);
  if(gate&&current&&!gates.has(current))gates.set(current,gate[1].trim());
 }
 const oneSideOnly=['persona','workflow-worker-thread'], otherSideOnly=['persona-02','workflow-ptc','present'];
 for(const id of oneSideOnly){const gate=gates.get(id);assert.ok(gate,`${id} 缺少运行时闸`);assert.equal(on01(gate),false,`${id} 应在 0.1 启用（0.1 形态的行）`);assert.equal(on02(gate),true,`${id} 应在 0.2 禁用（0.2 用另一形态的同名插件）`);}
 for(const id of otherSideOnly){const gate=gates.get(id);assert.ok(gate,`${id} 缺少运行时闸`);assert.equal(on01(gate),true,`${id} 应在 0.1 禁用（0.1 无此包）`);assert.equal(on02(gate),false,`${id} 应在 0.2 启用`);}
 for(const [id,gate] of gates)if(gate.includes('createRequire'))assert.match(gate,/try\{[\s\S]*catch\(/,`${id} 的运行时闸必须自带 try/catch——0.1 的 disabledOf 不吞异常，抛异常等于 0.1 启动失败`);
 const patchGate=/^\s*disabled: !!js (.+)$/m.exec(readFileSync(new URL('../cordis.patch.yml',import.meta.url),'utf8'))?.[1]?.trim();
 assert.ok(patchGate,'cordis.patch.yml 缺少 preset 声明行的 disabled 闸');
 assert.equal(on01(patchGate),true,'声明行必须在 0.1 上被禁用（0.1 不装 @deepseek-ai/dsh-agent-preset，loader 对禁用行从不 import）');
 assert.equal(on02(patchGate),false,'声明行必须在 0.2 上启用（否则 0.2 上 src-hunter 预设静默缺失）');
});

/* [local.133] 交付给两个运行时的客户端 bundle 是检入件（不重建）。0.2 换掉的两处
 * 会话读取必须同时成立，否则 0.2 上 SRC 视图页签静默不出现：
 * ① 列表快照不再带 current（主视图改在行上标 retainedBy.mainView）
 * ② 预设不再挂在会话行上（改进行的 projectionValues.agentPreset）
 * 这里从 bundle 里取出这两个判定函数，用两个运行时的真实快照形状跑行为断言。 */
test('交付的 SRC 客户端 bundle 在 0.1/0.2 两种会话形状下都判定出 SRC 页签',()=>{
 const bundle=readFileSync(new URL('../lib/ui-src.client.js',import.meta.url),'utf8');
 // 两个判定的声明顺序随构建器/源码顺序变化（SRC_PRESET 可能排在 currentSessionId 前或后），
 // 从更靠前的那个起切，否则前面那个函数会落在切片外（bundle 是检入件，不能靠顺序碰运气）。
 const markers=['function currentSessionId(','const SRC_PRESET = '];
 const offsets=markers.map(m=>{const i=bundle.indexOf(m);assert.ok(i>=0,`bundle 里找不到 ${m}`);return i;});
 const start=Math.min(...offsets);
 const end=bundle.indexOf('/** Required services for the view registration');
 assert.ok(start>=0&&end>start,'bundle 里找不到 SRC_PRESET 与判定函数');
 const {currentSessionId,isSrcSession}=new Function(`${bundle.slice(start,end)}\nreturn { currentSessionId, isSrcSession };`)();
 // 0.1 形状：current 在快照上、预设挂在会话行上（线上现状）
 const s01={current:'s1',byId:{s1:{agentPreset:'src-hunter'}}};
 assert.equal(currentSessionId(s01),'s1','0.1 必须仍从快照的 current 取当前会话');
 assert.equal(isSrcSession(s01,'s1'),true,'0.1 必须仍从行上的 agentPreset 认出 SRC 会话');
 // 0.2 形状：没有 current（主视图标在行上）、预设在进行投影值里
 const s02={byId:{other:{retainedBy:{aside:1}},s2:{retainedBy:{mainView:1},projectionValues:{agentPreset:'src-hunter'}}}};
 assert.equal(currentSessionId(s02),'s2','0.2 必须从 retainedBy.mainView 认出当前会话');
 assert.equal(isSrcSession(s02,'s2'),true,'0.2 必须从 projectionValues.agentPreset 认出 SRC 会话');
 assert.equal(isSrcSession(s02,'other'),false,'非 SRC 会话不得误判');
 // 子会话继承祖先预设，父链字段仍是 parentId
 const lineage={byId:{s2:{projectionValues:{agentPreset:'src-hunter'}},s3:{parentId:'s2',projectionValues:{agentPreset:null}}}};
 assert.equal(isSrcSession(lineage,'s3'),true,'SRC 会话的子会话必须继承该页签');
 assert.equal(currentSessionId({byId:{}}),undefined,'没有主视图会话时不得凭空造一个 id');
});
