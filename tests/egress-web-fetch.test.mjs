import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {withEgressExecution} from '../lib/src/egress/runtime.js';
import {executeGuardedWebFetch} from '../lib/src/egress/web-fetch.js';
function fixture(send){
 const calls=[];
 const context={sessionId:'web-fetch-fixture',manager:{fetch:async(session,url,init,exec)=>{calls.push({session,url,init});return send(url,init,exec);}}};
 return {calls,run:(url,extra={},signal)=>withEgressExecution(context,()=>executeGuardedWebFetch({arguments:{url,...extra},signal}))};
}
test('guarded web_fetch preserves native value shape without executing HTML or loading embedded resources',async()=>{
 const html='<h1>fixture</h1><script src="https://outside.invalid/code.js"></script><img src="/track">';
 const f=fixture(()=>new Response(html,{headers:{'content-type':'text/html;charset=utf-8'}}));
 const result=await f.run('https://fixture.invalid/index.html#section');
 assert.deepEqual(result.value,{url:'https://fixture.invalid/index.html',statusCode:200,body:{kind:'html',content:html},truncated:false});
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].session,'web-fetch-fixture');
 assert.match(result.content[0].text,/HTTP 200/);
});
test('every redirected URL goes through the gateway and later refusal is not reported as zero sends',async()=>{
 const f=fixture(url=>{
  if(url==='https://fixture.invalid/index.html')return new Response(null,{status:302,headers:{location:'/docs.html'}});
  if(url==='https://fixture.invalid/docs.html')return new Response(null,{status:307,headers:{location:'https://outside.invalid/'}});
  throw Object.assign(new Error('scope denied'),{code:'SRC_GATE_OUT_OF_SCOPE',safeNotSent:true});
 });
 await assert.rejects(f.run('https://fixture.invalid/index.html'),{code:'SRC_GATE_OUT_OF_SCOPE',safeNotSent:false});
 assert.deepEqual(f.calls.map(c=>c.url),['https://fixture.invalid/index.html','https://fixture.invalid/docs.html','https://outside.invalid/']);
});
test('redirect loops and long chains are bounded with no automatic retry',async()=>{
 const loop=fixture(()=>new Response(null,{status:302,headers:{location:'/start'}}));
 await assert.rejects(loop.run('https://fixture.invalid/start'),{code:'SRC_GATE_REDIRECT_LOOP',safeNotSent:false});assert.equal(loop.calls.length,1);
 let n=0;const chain=fixture(()=>new Response(null,{status:302,headers:{location:'/step-'+(++n)}}));
 await assert.rejects(chain.run('https://fixture.invalid/start'),{code:'SRC_GATE_REDIRECT_LIMIT',safeNotSent:false});assert.equal(chain.calls.length,6);
});
test('gzip and character sets decode correctly, output is bounded and compression bombs fail after send',async()=>{
 const f=fixture(()=>new Response(gzipSync(Buffer.alloc(17000,120)),{headers:{'content-type':'text/plain','content-encoding':'gzip'}}));
 const result=await f.run('https://fixture.invalid/file.txt');assert.equal(result.value.body.content,'x'.repeat(16000));assert.equal(result.value.truncated,true);
 const charset=fixture(()=>new Response(Buffer.from([0xe9]),{headers:{'content-type':'text/plain; charset=windows-1252'}}));
 assert.equal((await charset.run('https://fixture.invalid/file.txt')).value.body.content,'é');
 const bomb=fixture(()=>new Response(gzipSync(Buffer.alloc(8*1024*1024+1)),{headers:{'content-type':'text/plain','content-encoding':'gzip'}}));
 await assert.rejects(bomb.run('https://fixture.invalid/file.txt'),{safeNotSent:false});assert.equal(bomb.calls.length,1);
});
test('invalid fields and initial cancellation never call a sender; binary responses are not fabricated as text',async()=>{
 const f=fixture(()=>new Response('png',{headers:{'content-type':'image/png'}}));
 await assert.rejects(f.run('https://fixture.invalid/',{method:'DELETE'}),{code:'SRC_GATE_INVALID_WEB_FETCH_ARGUMENTS'});assert.equal(f.calls.length,0);
 await assert.rejects(f.run('https://fixture.invalid/',{},AbortSignal.abort()));assert.equal(f.calls.length,0);
 await assert.rejects(f.run('https://fixture.invalid/file.png'),{code:'SRC_GATE_WEB_FETCH_BINARY_CONTENT',safeNotSent:false});assert.equal(f.calls.length,1);
 await assert.rejects(executeGuardedWebFetch({arguments:{url:'https://fixture.invalid/'}}),{code:'SRC_GATE_MISSING_EXECUTION_CONTEXT'});
});

import {verifyWebFetchModel} from '../scripts/egress-feasibility/web-fetch-model-assert.mjs';
test('model acceptance permits independent concurrency but rejects duplicates, missing reads and unsafe sends',()=>{
 const origin='https://fixture.invalid';
 const report={exit:0,completion:{status:'completed',stopped:'',model:{model:'fixture'}},outsideArrivals:[],arrivals:['/read','/assets/model-packed.js','/index.html','/docs.html','/curl-normal'].map(path=>({method:'GET',path})),events:[
  {type:'assistant',content:[{type:'tool-call',name:'web_fetch'},{type:'tool-call',name:'web_fetch'}]},
  {type:'onboarding-user-scope',result:{result:{kind:'success'}}},
  {type:'tool-result',name:'web_fetch',arguments:{url:origin+'/index.html'},value:{url:origin+'/docs.html',statusCode:200,body:{content:'synthetic'}}},
  {type:'tool-result',name:'web_fetch',arguments:{url:origin+'/assets/model-packed.js'},value:{statusCode:200,truncated:true,body:{content:'/* fixture-js-v1 */'}}},
  {type:'tool-result',name:'src_http',arguments:{method:'DELETE'},value:{pendingApprovalId:'approval-2'}},
 ]};
 assert.equal(verifyWebFetchModel(report,origin).passed,true);
 for(const arrivals of [[...report.arrivals,{method:'GET',path:'/assets/model-packed.js'}],report.arrivals.slice(1),[...report.arrivals,{method:'DELETE',path:'/delete'}],[...report.arrivals].reverse()])assert.throws(()=>verifyWebFetchModel({...report,arrivals},origin));
});
