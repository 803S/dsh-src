import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../scripts/deployment-manifest.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
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

test('Web launcher detaches from caller and never trusts a stale PID file',()=>{
 const script=readFileSync(new URL('../scripts/start-dsh-web.sh',import.meta.url),'utf8');
 assert.match(script,/detached:true/);
 assert.match(script,/child\.unref\(\)/);
 assert.match(script,/commands?=|command=/);
 assert.doesNotMatch(script,/xargs kill|kill \"\$OLD\".*sleep 1/);
 assert.match(script,/DSH API health check failed/);
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
