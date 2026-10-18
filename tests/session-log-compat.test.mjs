// [local.142] 0.2 宿主移除了 `Session.events` 读取器（改 `snapshotEvents()/ownEvents()`）。
// 三处读取必须同时兼容 0.1(events) 与 0.2：用户命令守卫、人类目标派生、子代理失败探测。
// 现场证据（session-f63f1da9，dsh 0.2.1-rc.1 桌面/Web）：
//   /src-approve approval-1 allow → command/done kind:error SRC_GATE_USER_COMMAND_REQUIRED ×5。
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionLogEvents} from '../lib/src/session-log.js';
import {assertUserCommand} from '../lib/src/egress/user-commands.js';
import {explicitUserScope} from '../lib/src/egress/user-scope.js';
import {childTurnFailure} from '../lib/src/child-outcome.js';
import {withEgressExecution} from '../lib/src/egress/runtime.js';

const userMessageEvent=(text)=>Object.freeze({type:'agent/inbox/spliced',data:{inserted:[{role:'user',source:{kind:'user',rpcId:'rpc-fixture'},content:[{type:'text',text}]}]}});
const commandRunEvent=(commandId,name,source={kind:'user'})=>Object.freeze({type:'command/run',data:{commandId,name,source}});
// 0.1 会话形状：只有 events 读取器（复用同一份冻结快照）。
const v01Session=(events)=>({id:'s',header:{},seq:events.length,events:Object.freeze([...events])});
// 0.2 会话形状：只有 snapshotEvents()/ownEvents()，没有 events。
const v02Session=(events)=>({id:'s',header:{},seq:events.length,snapshotEvents:()=>Object.freeze([...events]),ownEvents:()=>Object.freeze([...events])});

test('[local.142] 会话日志读取器同时兼容 0.1(events) 与 0.2(snapshotEvents)，读不到即空日志',()=>{
  const events=[userMessageEvent('仅用于读取器回归')];
  const v01=v01Session(events),v02=v02Session(events);
  assert.deepEqual(sessionLogEvents(v01),sessionLogEvents(v02),'两条运行时的读取器给同一份日志');
  assert.equal(sessionLogEvents(v01),v01.events,'0.1：直接复用宿主冻结快照，不复制');
  assert.equal(sessionLogEvents(v02).length,1);
  // ownEvents 只在 snapshotEvents 缺失时兜底。
  assert.equal(sessionLogEvents({id:'s',ownEvents:()=>events}).length,1);
  // 无效对象/读取器抛错：空日志，不抛（调用方各自 fail-closed）。
  for(const broken of [undefined,null,42,'session',{}, {snapshotEvents:'nope'}, {snapshotEvents:()=>{throw new Error('fixture broken reader');}}]) assert.deepEqual(sessionLogEvents(broken),[]);
  assert.deepEqual(sessionLogEvents({events:'nope',snapshotEvents:()=>{throw new Error('fixture broken reader');}}),[]);
});

test('[local.142] 0.2 下用户命令守卫仍能签发审批，缺事件/非用户来源/模型上下文仍拒绝',()=>{
  const session=v02Session([userMessageEvent('目标：https://eci.example.com:80'),commandRunEvent('cmd-user-1','src-approve')]);
  const invocation={commandId:'cmd-user-1',rawInput:'approval-1 allow',agent:{session}};
  assert.doesNotThrow(()=>assertUserCommand(invocation,'src-approve'),'0.2 会话（只有 snapshotEvents）必须能通过守卫');
  // 0.1 形状保持同一结论。
  assert.doesNotThrow(()=>assertUserCommand({...invocation,agent:{session:v01Session(session.snapshotEvents())}},'src-approve'));
  // commandId/命令名不匹配 = 不是本次命令的日志行 → 拒绝。
  assert.throws(()=>assertUserCommand({...invocation,commandId:'cmd-user-2'},'src-approve'),{code:'SRC_GATE_USER_COMMAND_REQUIRED'});
  assert.throws(()=>assertUserCommand(invocation,'src-egress-scope'),{code:'SRC_GATE_USER_COMMAND_REQUIRED'});
  // 非 user 来源（模型合成 followup 的 command/run）→ 拒绝。
  const synthetic=v02Session([commandRunEvent('cmd-user-1','src-approve',{kind:'model'})]);
  assert.throws(()=>assertUserCommand({...invocation,agent:{session:synthetic}},'src-approve'),{code:'SRC_GATE_USER_COMMAND_REQUIRED'});
  // 0.2 宿主读不到日志（旧 API 缺失）→ 也必须拒绝，绝不因为读不到而放行。
  const unreadable={id:'s',header:{},events:void 0};
  assert.throws(()=>assertUserCommand({...invocation,agent:{session:unreadable}},'src-approve'),{code:'SRC_GATE_USER_COMMAND_REQUIRED'});
  // 模型工具执行上下文内一律拒绝（模型不得自我批准）。
  withEgressExecution({sessionId:'s'},()=>assert.throws(()=>assertUserCommand(invocation,'src-approve'),{code:'SRC_GATE_MODEL_CANNOT_APPROVE'}));
  // 已取消的调用不再签发。
  const controller=new AbortController();controller.abort(new Error('fixture cancellation'));
  assert.throws(()=>assertUserCommand({...invocation,signal:controller.signal},'src-approve'),/fixture cancellation/);
});

test('[local.142] 0.2 下人类目标句仍派生出精确范围（现场：该自动生效的却被卡）',()=>{
  const text='挖掘该资产 src 漏洞， 不进行资产收集，只针对该目标：https://eci-2zec3z682q4ut1t3ytr1.cloudeci1.ichunqiu.com:80';
  const expected={origins:['https://eci-2zec3z682q4ut1t3ytr1.cloudeci1.ichunqiu.com:80'],domains:['cloudeci1.ichunqiu.com']};
  assert.deepEqual(explicitUserScope(v02Session([userMessageEvent(text)])),expected,'0.2 会话必须仍能派生范围');
  assert.deepEqual(explicitUserScope(v01Session([commandRunEvent('cmd-1','src-todo'),userMessageEvent(text)])),expected);
  // 读不到日志 → 不授予任何目标（fail-closed）。
  assert.deepEqual(explicitUserScope({id:'s',header:{}}),{origins:[],domains:[]});
});

test('[local.142] 0.2 下子代理失败回合仍被观测到，新回合不算旧失败',()=>{
  const failed=[{type:'turn/start'},{type:'turn/end',data:{reason:{kind:'error',error:{code:'INVALID_REQUEST',message:'fixture child failure'}}}}];
  assert.deepEqual(childTurnFailure(v02Session(failed)),{code:'INVALID_REQUEST',message:'fixture child failure'});
  assert.deepEqual(childTurnFailure(v01Session(failed)),{code:'INVALID_REQUEST',message:'fixture child failure'});
  assert.equal(childTurnFailure(v02Session([...failed,{type:'turn/start'}])),undefined,'新回合不是旧失败');
  assert.equal(childTurnFailure(v02Session([{type:'turn/start'},{type:'turn/end',data:{reason:{kind:'completed'}}}])),undefined);
  assert.equal(childTurnFailure({id:'s',header:{}}),undefined);
});
