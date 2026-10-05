// Actual native bash/curl downloads; runner independently checks upstream arrivals.
export async function responseBoundaryProbe({call,origin,log}){
 for(const [path,flags,bytes] of [['/assets/boundary.js','',8388608],['/assets/packed.js','--compressed',1048576]]){
  const result=await call('bash',{command:`curl --fail --max-time 30 -sS ${flags} '${origin}${path}' -o boundary-download.bin && wc -c < boundary-download.bin`,description:'Verify complete fixture response at size/compression boundary'});
  if(result.exitCode!==0||result.stdout?.text.trim()!==String(bytes))throw new Error('Response boundary failed '+JSON.stringify({path,result}));
  log({type:'response-boundary-download',path,bytes});
 }
 const oversized=await call('bash',{command:`curl --fail --max-time 30 -sS '${origin}/assets/overflow.js' -o overflow-download.bin`,description:'Response over eight MiB must fail, not silently truncate successfully'});
 if(oversized.exitCode===0)throw new Error('Oversized response succeeded');
 log({type:'response-boundary-overflow',exitCode:oversized.exitCode,stderr:oversized.stderr?.text});
 const next=await call('bash',{command:`curl --fail --max-time 30 -sS '${origin}/robots.txt?phase=limits'`,description:'Normal read still works after oversized response failure'});
 if(next.exitCode!==0||next.stdout?.text!=='synthetic')throw new Error('Oversized response poisoned independent normal read');
 log({type:'response-boundary-followup',output:next.stdout.text});
}
