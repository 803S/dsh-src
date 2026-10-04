import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../scripts/deployment-manifest.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
test('deployment includes every runtime entry and the Python inspection addon',()=>{
 const files=runtimeFiles(repo);
 for(const entry of ['lib/src-egress.js','lib/src-bash-executor.js','lib/src/egress/manager.js','lib/src/egress/mitm-addon.py','lib/ui-src.client.js'])assert.ok(files.includes(entry),entry);
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
