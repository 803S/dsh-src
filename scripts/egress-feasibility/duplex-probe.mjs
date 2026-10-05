import {currentEgressExecution} from '../../lib/src/egress/runtime.js';
export async function duplexProbe(ctx,exec,origin,log){
 const context=currentEgressExecution();if(!context||context.exec!==exec)throw new Error('Duplex probe did not reach guarded ToolRuntime context');
 const handle=ctx.shell.startGuardedTransport({command:'node fixture-duplex-worker.cjs',signal:exec.signal});
 let buffer='',id=0;const pending=new Map();
 handle.stdout.setEncoding('utf8');handle.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const result=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(result.id);if(p){pending.delete(result.id);clearTimeout(p.timer);p.resolve(result);}}});
 const call=(path,direct=false)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error('Duplex response timeout'));},15000);pending.set(key,{resolve,reject,timer});handle.stdin.write(JSON.stringify({id:key,url:origin+path,direct})+'\n');});
 try{
  const a=await call('/duplex/read-a'),denied=await call('/duplex/must-not-send',true),b=await call('/duplex/read-b');
  if(a.exit!==0||b.exit!==0||a.body!=='synthetic'||b.body!=='synthetic'||a.pid!==b.pid||denied.exit===0)throw new Error('Duplex isolation mismatch');
  log({type:'native-duplex-roundtrip',a,denied,b});
 }finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Duplex closing'));}pending.clear();await handle.terminate();await handle.done;}
 log({type:'native-duplex-terminated'});
 const controller=new AbortController();
 const cancelled=ctx.shell.startGuardedTransport({command:'node fixture-duplex-worker.cjs',signal:controller.signal});
 try{
  const hello=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Cancel worker readiness timeout')),3000);cancelled.stdout.once('data',chunk=>{clearTimeout(timer);resolve(JSON.parse(String(chunk)));});cancelled.stdin.write(JSON.stringify({id:1,hello:true})+'\n');});
  controller.abort(new Error('fixture cancellation'));
  const outcome=await cancelled.done;
  if(!outcome.signal&&outcome.exitCode===0)throw new Error('Cancel did not stop a live worker');
  log({type:'native-duplex-aborted',pid:hello.pid,outcome});
 }finally{await cancelled.terminate();await cancelled.done;}
 return {value:{kind:'foreground',exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:30000,stdout:{text:'duplex-fixture-passed',truncated:false},stderr:{text:'',truncated:false}},content:[{type:'text',text:'duplex-fixture-passed'}]};
}
