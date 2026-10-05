// Actual DSH bash -> enforced proxy -> independent loopback receiver.
export async function hopHeaderProbe({call,origin,log}){
 for(const [token,path] of [['keep-alive','read-a'],['close','read-b']]){
  const r=await call('bash',{command:`curl --max-time 30 -sS -H 'Connection: ${token}' '${origin}/hop/${path}'`,description:'Ordinary client-hop persistence preference'});
  if(r.exitCode!==0||r.stdout?.text!=='synthetic')throw new Error('Benign hop header blocked '+JSON.stringify(r));
 }
 for(const headers of ["-H 'Connection: upgrade' -H 'Upgrade: websocket'","-H 'Connection: x-original-url' -H 'X-Original-URL: /delete'","-H 'Connection: keep-alive, close'","-H 'Connection: close' -H 'Connection: keep-alive'","-H 'Proxy-Connection: upgrade'"]){
  const r=await call('bash',{command:`curl --max-time 10 -sS ${headers} '${origin}/hop-must-not-send'`,description:'Reject upgrades, nominated headers and duplicate hop values'});
  if(!r.stdout?.text.includes('SRC_GATE_BLOCKED_NOT_SENT'))throw new Error('Unsafe hop header not explicitly blocked '+JSON.stringify(r));
 }
 const last=await call('bash',{command:`curl --max-time 30 -sS '${origin}/hop/after-denial'`,description:'Normal request remains usable after header refusals'});
 if(last.exitCode!==0||last.stdout?.text!=='synthetic')throw new Error('Header refusal poisoned normal worker');
 log({type:'hop-header-matrix',normal:3,blocked:5});
}
