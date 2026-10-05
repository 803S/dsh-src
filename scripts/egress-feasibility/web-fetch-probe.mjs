export async function webFetchProbe({call,ctx,agent,origin,log}){
 const first=await call('web_fetch',{url:origin+'/index.html'});
 if(first.url!==origin+'/docs.html'||first.statusCode!==200||first.body.content!=='synthetic')throw new Error('Guarded web_fetch normal redirect failed '+JSON.stringify(first));
 const compressed=await call('web_fetch',{url:origin+'/assets/packed.js'});
 if(compressed.statusCode!==200||compressed.body.content!=='x'.repeat(16000)||compressed.truncated!==true)throw new Error('Guarded web_fetch compressed response failed');
 for(const [path,code] of [['/delete-web-fetch','SRC_GATE_PENDING_OR_REJECTED'],['/outside.html','SRC_GATE_OUT_OF_SCOPE']]){
  const result=await ctx.tools.execute({callId:'web-fetch-negative-'+path,name:'web_fetch',arguments:{url:origin+path},agent,signal:AbortSignal.timeout(30000)});
  if(!result.isError||!JSON.stringify(result).includes(code))throw new Error('Unsafe web_fetch was not gated '+JSON.stringify(result));
  if(path==='/delete-web-fetch'&&!JSON.stringify(result).includes('approval-'))throw new Error('Pending web_fetch hid the actionable approval ID');
  log({type:'web-fetch-negative',path,code});
 }
 log({type:'web-fetch-positive',url:first.url,status:first.statusCode,compressedChars:compressed.body.content.length,truncated:compressed.truncated});
}
