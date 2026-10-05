import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {resolveBrowserRuntime} from '../lib/src/egress/browser-runtime.js';
import {projectBrowserOutput,browserProjectionDecision} from '../lib/src/egress/browser-output.js';
import {isBrowserTool} from '../lib/src/egress/browser-adapter.js';
test('browser runtime uses installed owner inventory and existing executable only',async t=>{
 const home=await mkdtemp(path.join(tmpdir(),'browser-runtime-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const pkg=path.join(home,'cap/node_modules/@playwright/mcp'),cacheDir=path.join(home,'cache');await mkdir(pkg,{recursive:true});
 await writeFile(pkg+'/package.json',JSON.stringify({name:'@playwright/mcp',version:'0.0.80'}));
 const executable=path.join(cacheDir,'chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell');await mkdir(path.dirname(executable),{recursive:true});await writeFile(executable,'fixture',{mode:0o755});
 const item={id:'playwright',kind:'mcp',status:'installed',enabled:true,dir:path.join(home,'cap')};
 assert.deepEqual(await resolveBrowserRuntime([item],{cacheDir,arch:'arm64'}),{packagePath:await realpath(pkg),executablePath:await realpath(executable)});
 for(const items of [[],[item,item],[{...item,enabled:false}],[{...item,status:'unknown'}]])await assert.rejects(resolveBrowserRuntime(items,{cacheDir}),{code:'SRC_GATE_BROWSER_NOT_INSTALLED'});
 await writeFile(pkg+'/package.json',JSON.stringify({name:'@playwright/mcp',version:'unverified'}));await assert.rejects(resolveBrowserRuntime([item],{cacheDir}),{code:'SRC_GATE_UNVERIFIED_BROWSER_RUNTIME'});
 assert.equal(isBrowserTool('mcp__playwright__browser_navigate'),true);for(const name of ['mcp__evil__browser_navigate','mcp__playwright__not_browser','mcp__playwright__browser_navigate/evil'])assert.equal(isBrowserTool(name),false);
});
test('browser images use exact model admission and ordered durable attachments',async()=>{
 let saved;const ref={id:'fixture-image'},signal=new AbortController().signal;
 const ctx={get:key=>key==='attachments'?{saveImages:async images=>{saved=images;return [ref];}}:{resolveModelInfo:async(provider,model)=>{assert.equal(provider,'p');assert.equal(model,'m');return {inputModalities:['text','image']};}}};
 const exec={signal,agent:{session:{requestHeader:()=>({config:{provider:'p',model:'m'}})}}};
 const content=[{type:'text',text:'before'},{type:'image',mimeType:'image/png',data:Buffer.from('fixture-bytes').toString('base64')},{type:'text',text:'after'}];
 const copy=structuredClone(content);const result=await projectBrowserOutput(ctx,exec,content);
 assert.deepEqual(result,[{type:'text',text:'before'},{type:'image',attachment:ref},{type:'text',text:'after'}]);assert.equal(saved[0].mediaType,'image/png');assert.equal(saved[0].data.toString(),'fixture-bytes');assert.deepEqual(content,copy);
});
test('invalid images and non-image models get explicit text, never inline base64 or remote fetching',async()=>{
 let saves=0;const ctx={get:key=>key==='attachments'?{saveImages:async()=>{saves++;return [];}}:{resolveModelInfo:async()=>({inputModalities:['text']})}};
 const exec={agent:{options:{provider:'p',model:'m'},session:{}}};
 for(const block of [{type:'image',mimeType:'image/png',data:'YQ=='},{type:'image',mimeType:'image/svg+xml',data:'YQ=='},{type:'image',mimeType:'image/png',data:'YQ==\n'}]){
  const result=await projectBrowserOutput(ctx,exec,[block]);assert.equal(result[0].type,'text');assert.match(result[0].text,/image unavailable/);assert.ok(!result[0].text.includes('YQ=='));
 }
 assert.equal(saves,0);const resource=await projectBrowserOutput(ctx,exec,[{type:'resource_link',uri:'https://target.invalid/delete'}]);assert.match(resource[0].text,/not fetched/);
});
test('rich browser output never overrides post-execution block, rewrite or cancellation',()=>{
 const p={value:{content:[]},content:[{type:'image',attachment:{attachmentId:'fixture'}}]},result={value:{content:[]}},accept={kind:'accept'};
 assert.deepEqual(browserProjectionDecision(p,{},result,accept),{kind:'accept',content:p.content});
 for(const decision of [{kind:'block',feedback:[]},{kind:'accept',value:{}},{kind:'accept',content:[]}])assert.equal(browserProjectionDecision(p,{},result,decision),decision);
 assert.equal(browserProjectionDecision(p,{signal:AbortSignal.abort()},result,accept),accept);
 assert.equal(browserProjectionDecision(p,{}, {isError:true,value:p.value},accept),accept);
 assert.equal(browserProjectionDecision(p,{}, {value:{content:['changed']}},accept),accept);
});
