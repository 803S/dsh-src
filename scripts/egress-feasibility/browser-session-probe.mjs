import path from 'node:path';
import {currentEgressExecution} from '../../lib/src/egress/runtime.js';
export async function browserSessionProbe(ctx,pool,action,origin,log){
 const context=currentEgressExecution();if(!context)throw new Error('Missing native session context');
 const exec=context.exec,session=exec.agent.session;
 const policyKey=JSON.stringify(ctx.sandboxPolicy.resolve({session}));
 let result;
 if(action==='invalidate')await pool.invalidate(session.id);
 else{
  result=await pool.run({sessionId:session.id,policyKey,signal:exec.signal,options:{packagePath:process.env.DSH_EVAL_MCP_PACKAGE,executablePath:process.env.DSH_EVAL_BROWSER_EXECUTABLE,outputDir:path.join(session.header.cwd,'session-browser-output')}},async client=>{
   await context.manager.sessionProxy(context.sessionId);
   const calls={navigate:{name:'browser_navigate',arguments:{url:origin+'/browser.html'}},snapshot:{name:'browser_snapshot',arguments:{}},evaluate:{name:'browser_evaluate',arguments:{function:`async()=>{const out=[];for(const method of ['GET','DELETE']){const r=await fetch(${JSON.stringify(origin+'/session/read')},{method});out.push({method,status:r.status,gate:r.headers.get('x-src-gate'),body:await r.text()});}return out;}`}}};
   if(!calls[action])throw new Error('Unknown fixture browser action');
   return client.request('tools/call',calls[action],{signal:exec.signal});
  });
  if(result.isError)throw new Error('Browser session action failed '+JSON.stringify(result));
  if(action==='snapshot'&&!JSON.stringify(result).includes('synthetic-browser'))throw new Error('Independent call lost browser page state');
  if(action==='evaluate'){
   const text=result.content.find(c=>c.type==='text'&&c.text.startsWith('### Result\n'))?.text;
   const values=JSON.parse(text?.split('### Result\n')[1]?.split('\n### Ran Playwright code')[0]??'null');
   if(values?.length!==2||values[0].status!==200||values[0].body!=='synthetic'||values[1].status!==403||values[1].gate!=='not-sent')throw new Error('Session read/delete matrix failed');
  }
 }
 log({type:'native-browser-session-action',action,result,status:pool.status()});
 return {kind:'foreground',exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:30000,stdout:{text:'browser-session-'+action+'-passed',truncated:false},stderr:{text:'',truncated:false}};
}
