import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserSessions} from '../lib/src/egress/browser-sessions.js';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
function fixture(t,settings={}){
 const clients=[];const pool=createBrowserSessions({...settings,start:async({signal})=>{const client={signal,closed:false,inits:0,async initialize(){this.inits++;},async close(){this.closed=true;}};clients.push(client);return client;}});t.after(()=>pool.close());
 const run=(id,operation,extra={})=>pool.run({sessionId:id,policyKey:'v1',options:{},...extra},operation);
 return {pool,run,clients};
}
test('browser workers persist within a session and serialize calls without sharing other sessions',async t=>{
 const f=fixture(t),ready=deferred(),release=deferred();
 const a=f.run('a',async client=>{ready.resolve();await release.promise;return client;});await ready.promise;
 let ran=false;const b=f.run('a',client=>{ran=true;return client;});await Promise.resolve();assert.equal(ran,false);
 const other=await f.run('b',client=>client);release.resolve();assert.equal(await a,await b);assert.notEqual(await a,other);assert.equal(f.clients.length,2);assert.equal(f.clients[0].inits,1);
});
test('policy changes revoke a live worker and invalidate its queued operations',async t=>{
 const f=fixture(t),ready=deferred();let queued=false;
 const running=f.run('a',client=>new Promise(resolve=>{ready.resolve();client.signal.addEventListener('abort',()=>resolve('aborted'),{once:true});}));await ready.promise;
 const q=f.run('a',()=>{queued=true;});const rejected=assert.rejects(q,{code:'SRC_GATE_BROWSER_SESSION_CLOSED'});
 const replacement=f.run('a',client=>client,{policyKey:'v2'});assert.equal(await running,'aborted');await rejected;const client=await replacement;
 assert.equal(queued,false);assert.equal(f.clients[0].closed,true);assert.notEqual(client,f.clients[0]);
});
test('capacity and queue bounds reject excess work before spawning; queued cancellation does not kill active work',async t=>{
 const f=fixture(t,{maxWorkers:1,maxQueued:2}),ready=deferred(),release=deferred();
 const running=f.run('a',async client=>{ready.resolve();await release.promise;assert.equal(client.signal.aborted,false);});await ready.promise;
 const controller=new AbortController();const queued=f.run('a',()=>assert.fail('Cancelled operation executed'),{signal:controller.signal});controller.abort();
 await assert.rejects(f.run('a',()=>{}),{code:'SRC_GATE_BROWSER_QUEUE_LIMIT'});await assert.rejects(f.run('b',()=>{}),{code:'SRC_GATE_BROWSER_CAPACITY'});
 const rejected=assert.rejects(queued,{code:'SRC_GATE_BROWSER_ABORTED'});release.resolve();await running;await rejected;assert.equal(f.clients[0].closed,false);assert.equal(f.clients.length,1);
});
test('active cancellation closes the worker and explicit later call starts fresh, never retries failed operation',async t=>{
 const f=fixture(t),controller=new AbortController(),ready=deferred();let calls=0;
 const operation=f.run('a',client=>new Promise((resolve,reject)=>{calls++;ready.resolve();client.signal.addEventListener('abort',()=>reject(new Error('operation aborted')),{once:true});}),{signal:controller.signal});await ready.promise;controller.abort();
 await assert.rejects(operation,/operation aborted/);assert.equal(calls,1);assert.equal(f.clients[0].closed,true);
 await f.run('a',()=>{});assert.equal(f.clients.length,2);
});
test('idle eviction and pool disposal close workers and reject future work',async t=>{
 const f=fixture(t,{idleMs:5});await f.run('a',()=>{});await new Promise(r=>setTimeout(r,20));assert.equal(f.clients[0].closed,true);assert.equal(f.pool.status().workers,0);
 await f.run('b',()=>{});await f.pool.close();assert.equal(f.clients[1].closed,true);await assert.rejects(f.run('c',()=>{}),{code:'SRC_GATE_BROWSER_POOL_CLOSED'});
});
test('disposal during startup prevents initialization and closes the late worker',async()=>{
 const started=deferred(),release=deferred();let initialized=0,closed=0;
 const pool=createBrowserSessions({start:async()=>{started.resolve();await release.promise;return {async initialize(){initialized++;},async close(){closed++;}};}});
 const request=pool.run({sessionId:'a',policyKey:'v1',options:{}},()=>assert.fail('Disposed operation ran'));await started.promise;
 const rejected=assert.rejects(request,{code:'SRC_GATE_BROWSER_SESSION_CLOSED'});const closing=pool.close();release.resolve();await rejected;await closing;
 assert.equal(initialized,0);assert.ok(closed>=1);assert.equal(pool.status().workers,0);
});
test('related-session invalidation cancels active child and rejects its queued work',async t=>{
 const f=fixture(t),ready=deferred();let queuedRan=false;
 const options={authorizationSessionId:'parent'};
 const active=f.run('child',client=>new Promise(resolve=>{ready.resolve();client.signal.addEventListener('abort',()=>resolve('stopped'),{once:true});}),options);
 await ready.promise;
 const queued=f.run('child',()=>{queuedRan=true;},options);
 const rejected=assert.rejects(queued,{code:'SRC_GATE_BROWSER_SESSION_CLOSED'});
 await f.run('unrelated',()=>{});
 await f.pool.invalidateRelated(['parent']);await rejected;
 assert.equal(await active,'stopped');assert.equal(queuedRan,false);assert.equal(f.clients[0].closed,true);assert.equal(f.clients[1].closed,false);assert.equal(f.pool.status().workers,1);
 await f.run('child',()=>{},options);assert.equal(f.clients.length,3);
});
