// Real DSH agents/ToolRuntime/approval service; only runner-owned publications.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connect} from 'node:net';
export async function proofLifecycleProbe({ctx,agent,call,selection,SessionId,installModelSelection,log,origin}){
 const handles=[],sockets=[];
 const create=async(parent)=>{
  const handle=await ctx.agents.create({sessionId:SessionId(`session-${randomUUID()}`),meta:{cwd:process.cwd(),...(parent?{parentSession:parent.session.id,origin:'subagent',delegationDepth:1}:{})},agentOptions:{provider:selection.provider,model:selection.model},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'src-hunter');installModelSelection(agentCtx,{current:selection,assembled:undefined});}});
  handles.push(handle);return handle;
 };
 const publish=async owner=>{
  const turn=(owner.session.events.findLast(event=>event.type==='turn/start')?.data.turn??0)+1;
  owner.session.append('turn/start',{turn});
  try{return await call('src_serve_proof',{payload:'synthetic-proof',filename:'fixture.txt',contentType:'text/plain',ttlSeconds:10},owner);}
  finally{owner.session.append('turn/end',{turn,reason:{kind:'completed'}});}
 };
 const local=record=>{const url=new URL(record.url);url.hostname='127.0.0.1';return url;};
 const readable=async record=>{const response=await fetch(local(record),{signal:AbortSignal.timeout(2000)});assert.equal(await response.text(),'synthetic-proof');};
 const gone=async record=>{await assert.rejects(fetch(local(record),{signal:AbortSignal.timeout(2000)}));};
 const slow=async record=>{
  const socket=connect({host:'127.0.0.1',port:Number(local(record).port)});sockets.push(socket);
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  const ended=new Promise(resolve=>socket.once('close',resolve));socket.write('GET /slow HTTP/1.1\r\nHost: fixture\r\n');
  await new Promise(resolve=>setTimeout(resolve,50));return {socket,ended};
 };
 const bounded=async promise=>{let timer;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native proof cleanup blocked on live socket')),2000);})]);}finally{clearTimeout(timer);}};
 try{
  const child=await create(agent),other=await create();
  const parentProof=await publish(agent),childProof=await publish(child.agent),otherProof=await publish(other.agent);
  await Promise.all([parentProof,childProof,otherProof].map(readable));
  const pending=await slow(childProof);
  await bounded(Promise.all([call('src_add_goal',{target:origin,objective:'Reset live parent and child proof services'}),pending.ended]));
  await gone(parentProof);await gone(childProof);await readable(otherProof);
  const childFresh=await publish(child.agent);await readable(childFresh);
  const childPending=await slow(childFresh);await bounded(Promise.all([child.dispose(),childPending.ended]));
  await gone(childFresh);await readable(otherProof);
  // Exercise the actual user domain-management command, not store mocks.
  const deletionProof=await publish(agent);await readable(deletionProof);
  await Promise.all(ctx.agents.list().map(owner=>owner.whenIdle()));
  const catalog=await ctx.commands.execute(agent,'/src-domains',[],AbortSignal.timeout(5000));
  assert.equal(catalog.result.kind,'success');
  const domains=JSON.parse(catalog.result.text).domains;assert.equal(domains.length,1);
  const target=domains[0].target;
  const deleted=await ctx.commands.execute(agent,`/src-delete-domain ${target} confirm ${target}`,[],AbortSignal.timeout(10000));
  assert.equal(deleted.result.kind,'success',JSON.stringify(deleted));
  await gone(deletionProof);await readable(otherProof);
  await call('src_add_goal',{target:origin,objective:'Continue normal workflow after fixture domain cleanup'});
  assert.equal((await ctx.srcEgress.ready()).user.getScope(agent.session.id),undefined);
  const renewed=await ctx.commands.execute(agent,`/src-egress-scope ${JSON.stringify([origin])}`,[],AbortSignal.timeout(5000));
  assert.equal(renewed.result.kind,'success');
  // A distinct timer service keeps an incomplete request open until expiry.
  const ttlProof=await publish(other.agent),ttlPending=await slow(ttlProof);
  await new Promise(resolve=>setTimeout(resolve,10100));
  await bounded(ttlPending.ended);await gone(ttlProof);await gone(otherProof);
  await call('src_add_goal',{target:'independent.invalid',objective:'Independent parent disposal fixture'},other.agent);
  const descendant=await create(other.agent);
  const otherParent=await publish(other.agent),otherChild=await publish(descendant.agent),survivor=await publish(agent);
  await Promise.all([otherParent,otherChild,survivor].map(readable));
  await other.dispose();await gone(otherParent);await gone(otherChild);await readable(survivor);
  const stopped=await call('src_stop_serve',{serveId:survivor.serveId});assert.equal(stopped.stopped,true);
  log({type:'native-proof-lifecycle-passed',parentResetClosed:2,childDisposeClosed:1,unrelatedSurvived:true,ttlClosed:true,domainDeletionClosed:true,parentDisposeClosed:2});
 }finally{
  for(const socket of sockets)socket.destroy();
  await Promise.all(handles.map(handle=>handle.dispose()));
 }
}
