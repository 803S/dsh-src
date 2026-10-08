import {renderBrowserNetwork} from './target-context.js';
import {browserLifecycle} from './browser-lifecycle.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {currentEgressExecution} from './runtime.js';
import {createBrowserSessions} from './browser-sessions.js';
import {resolveBrowserRuntime} from './browser-runtime.js';
import {projectBrowserOutput,browserProjectionDecision} from './browser-output.js';
import {gateError} from './plan.js';
export const isBrowserTool=name=>/^mcp__playwright__browser_[a-z0-9_]+$/.test(name);
export function createBrowserAdapter(ctx,store,{createSessions=createBrowserSessions,resolveRuntime=resolveBrowserRuntime}={}){
 const pool=createSessions(),catalogs=new WeakMap(),projections=new WeakMap(),disposedSessions=new WeakSet();
 let lifecycle,unsubscribe,closed=false;
 const close=async()=>{closed=true;unsubscribe?.();await pool.close();};
 ctx.effect(()=>close);
 const resetSession=session=>lifecycle?lifecycle.reset([String(session.id)],async()=>{}):pool.invalidateRelated([String(session.id)]);
 ctx.on('session/event',(session,event)=>{if(event.type==='sandbox/mode')return resetSession(session);});
 ctx.on('session/disposed',session=>{disposedSessions.add(session);return resetSession(session);});
 // ToolRuntime re-renders an around-adapter value before post-execute. Restore
 // rich output only if no other policy blocked or changed this exact result.
 ctx.on('tools/post-execute',async(exec,result,next)=>{
  const decision=await next(),projection=projections.get(exec);projections.delete(exec);
  return browserProjectionDecision(projection,exec,result,decision);
 });
 return {close,invalidate:id=>pool.invalidate(id),async execute(exec,capabilities){
  const context=currentEgressExecution();if(!context||context.exec!==exec)throw gateError('MISSING_EXECUTION_CONTEXT');
  const name=String(exec.name),raw=name.slice('mcp__playwright__'.length);
  if(!isBrowserTool(name)||raw.startsWith('browser_install'))throw gateError('UNADAPTED_TOOL');
  if(!ctx.tools.get(name,exec.agent))throw gateError('UNAVAILABLE_TOOL');
  if(closed)throw gateError('BROWSER_POOL_CLOSED');
  if(!lifecycle){const domain=await store.domain();if(closed)throw gateError('BROWSER_POOL_CLOSED');lifecycle=browserLifecycle(domain);if(!unsubscribe)unsubscribe=lifecycle.subscribe(ids=>pool.invalidateRelated(ids));}
  const tickets=[...new Set([context.sessionId,String(exec.agent.session.id)])].map(id=>lifecycle.ticket(id));
  const check=()=>{if(closed)throw gateError('BROWSER_POOL_CLOSED');if(disposedSessions.has(exec.agent.session))throw gateError('BROWSER_SESSION_CLOSED');for(const ticket of tickets)ticket();};
  if(raw==='browser_navigate')context.manager.checkTarget(context.sessionId,exec.arguments?.url);
  const runtime=await resolveRuntime(capabilities);
  const session=exec.agent.session,cwd=session.header?.cwd??process.cwd();
  const options={...runtime,outputDir:path.join(cwd,'.src-browser',createHash('sha256').update(String(session.id)).digest('hex').slice(0,20))};
  const policyKey=JSON.stringify({native:ctx.get('sandboxPolicy').resolve({session}),authorizationSession:context.sessionId,cwd,options,protectedPaths:context.protectedPaths,readablePaths:context.readablePaths,readOnlyPaths:context.readOnlyPaths});
  check();
  const result=await pool.run({sessionId:String(session.id),authorizationSessionId:context.sessionId,policyKey,options,signal:exec.signal},async client=>{
   check();
   await context.manager.sessionProxy(context.sessionId);
   check();
   let tools=catalogs.get(client);
   if(!tools){const catalog=await client.request('tools/list',{}, {signal:exec.signal});if(!Array.isArray(catalog.tools)||catalog.tools.length>256)throw gateError('INVALID_BROWSER_CATALOG');tools=new Set(catalog.tools.map(tool=>tool.name));catalogs.set(client,tools);}
   check();
   if(!tools.has(raw))throw gateError('UNAVAILABLE_TOOL');
   const records=[];
   const off=context.manager.watchNetwork(context.sessionId,record=>{if(records.length<256)records.push(record);});
   try{
     // Direct navigation is checked before browser I/O. Script/redirect/subresource requests
     // are still checked at the actual network boundary; never parse arbitrary JS as policy.
     if(raw==='browser_navigate')context.manager.checkTarget(context.sessionId,exec.arguments?.url);
     const native=await client.request('tools/call',{name:raw,arguments:exec.arguments},{signal:exec.signal});
     return {native,networkNote:renderBrowserNetwork(records)};
   }finally{off();}
  });
  const native=result.native;
  if(native?.isError)throw Object.assign(gateError('BROWSER_TOOL_FAILED'),{safeNotSent:false});
  if(!Array.isArray(native?.content))throw Object.assign(gateError('INVALID_BROWSER_OUTPUT'),{safeNotSent:false});
  const value={content:native.content,...(native.structuredContent!==undefined?{structuredContent:native.structuredContent}:{})};
  const projected=await projectBrowserOutput(ctx,exec,native.content);
  const content=result.networkNote?[{type:'text',text:result.networkNote},...projected]:projected;
  projections.set(exec,{value,content});
  return {value,content};
 }};
}
