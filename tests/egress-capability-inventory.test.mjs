import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readCapsManifest} from '../lib/src/capability-loader.js';

test('legacy installed MCP inventory resolves existing standard dirs without granting missing or declared installs',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'src-cap-inventory-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(home+'/capabilities/playwright',{recursive:true});await mkdir(home+'/capabilities/declared',{recursive:true});
 const capabilities=[{id:'playwright',kind:'mcp',from:'npm:@playwright/mcp',status:'installed'},
  {id:'missing',kind:'mcp',status:'installed'}, {id:'declared',kind:'mcp',status:'unknown'},
  {id:'../control',kind:'mcp',status:'installed'}, {id:'explicit',kind:'mcp',status:'installed',dir:'/owner/explicit'}];
 await writeFile(home+'/capabilities/index.json',JSON.stringify({capabilities}));
 const result=await readCapsManifest(home);assert.equal(result.source,'index');
 assert.equal(result.items[0].dir,home+'/capabilities/playwright');
 for(const i of [1,2,3])assert.equal(result.items[i].dir,undefined);
 assert.equal(result.items[4].dir,'/owner/explicit');
 await rm(home+'/capabilities/index.json');
 await writeFile(home+'/capabilities.yaml','capabilities:\n  - id: playwright\n    kind: mcp\n    from: npm:@playwright/mcp\n');
 const fallback=await readCapsManifest(home);assert.equal(fallback.source,'yaml');assert.equal(fallback.items[0].dir,undefined);assert.equal(fallback.items[0].status,'unknown');
});
