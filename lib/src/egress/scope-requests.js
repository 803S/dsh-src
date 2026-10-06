// Scope proposals grant no authority. Durable approval rows are the source of
// truth; only in-flight deduplication/decision locks live in memory.
import { gateError } from './plan.js';
const CAPACITY=128;
export function createScopeRequests({storeFor,setScope,getScope,ticket=()=>()=>{}}) {
  const proposals=new Map(),sessionQueues=new Map(),deciding=new Set();let closed=false;
  const open=()=>{if(closed)throw gateError('CLOSED');};
  const keyOf=(session,id)=>JSON.stringify([session,id]);
  function originsOf(values){
    if(!Array.isArray(values)||!values.length||values.length>256)throw gateError('INVALID_SCOPE');
    return [...new Set(values.map(value=>{
      const u=new URL(value);
      if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw gateError('INVALID_SCOPE');
      return u.origin;
    }))].sort();
  }
  function binding(session,row){
    if(!row||row.sessionId!==session||row.method!=='SCOPE'||row.category!=='egress/scope')throw gateError('STALE_APPROVAL');
    const origins=originsOf(JSON.parse(row.body).origins);
    if(row.body!==JSON.stringify({origins})||!Number.isFinite(row.createdAt))throw gateError('STALE_APPROVAL');
    const state=deciding.has(keyOf(session,row.id))?'deciding':row.userDecision==='reject'||row.status==='rejected'&&row.executionState!=='scope-expired'?'rejected':
      row.status==='approved'?'approved':row.userDecision||row.executionState==='scope-expired'?'stale':row.status==='pending'?'pending':'stale';
    // 人工待办不消耗执行预算，跨天和重启都不改变它的有效性。
    return {session,origins,approvalId:row.id,state,expiresAt:null};
  }
  async function read(session,id){
    open();const store=await storeFor(session),row=await store.getPendingApproval(session,id);open();
    return {store,row,value:binding(session,row)};
  }
  async function propose(session,values){
    open();const origins=originsOf(values),body=JSON.stringify({origins}),key=keyOf(session,body);
    if(proposals.has(key))return proposals.get(key);
    if(proposals.size>=CAPACITY)throw gateError('PENDING_CAPACITY');
    const work=(sessionQueues.get(session)??Promise.resolve()).catch(()=>{}).then(async()=>{
      open();
      const store=await storeFor(session);
      const rows=await store.listScopeApprovals(session);open();
      const matching=rows.filter(row=>row.body===body);
      // Never replace a human rejection, including after restart or expiry.
      const rejected=matching.find(row=>row.userDecision==='reject'||row.status==='rejected'&&row.executionState!=='scope-expired');
      if(rejected)return binding(session,rejected);
      let active=0;
      for(const row of rows){
        const b=binding(session,row);
        if(['pending','deciding','stale'].includes(b.state)){
          active++;
          if(row.body===body)return b;
        }
      }
      if(active>=CAPACITY)throw gateError('PENDING_CAPACITY');
      const row=await store.addPendingApproval(session,{method:'SCOPE',url:origins[0],path:'/',headers:'',body,category:'egress/scope',reason:'确认本次测试的精确目标范围；不发送请求、不批准高危操作。',justification:'首次目标请求尚无出口范围。请用户确认；确认后重试原请求，仍须通过风险审批。'});
      open();return binding(session,row);
    });
    proposals.set(key,work);
    sessionQueues.set(session,work);
    try{return await work;}finally{proposals.delete(key);if(sessionQueues.get(session)===work)sessionQueues.delete(session);}
  }
  return {
    async require(session,values){
      open();if(getScope(session)?.origins?.length)return;
      const b=await propose(session,values);
      const nextAction=b.state==='rejected'?'用户已拒绝该范围；停止，不得重提或换通道。':b.state==='stale'?'范围确认结果不完整；停止重试，请用户核对当前范围并通过 /src-egress-scope 显式设置。':
        '请用户处理范围确认单；无独立工作时结束当前回合，确认结果会作为新消息回注。禁止 sleep、轮询状态或重复发包等待。确认范围不会自动发送或批准高危请求。';
      throw Object.assign(gateError('PENDING_OR_REJECTED'),{message:`SRC_GATE_PENDING_OR_REJECTED: 范围确认 ${b.approvalId}，状态 ${b.state}；${nextAction}`,approvalId:b.approvalId,state:b.state,reason:'scope-confirmation-required',nextAction});
    },
    async has(session,id){open();const store=await storeFor(session),row=await store.getPendingApproval(session,id);open();return row?.sessionId===session&&row.method==='SCOPE'&&row.category==='egress/scope';},
    async inspect(session,id){const {value:b}=await read(session,id);return {...b,kind:'scope',sendsRequest:false};},
    async decide(session,id,action,note='',signal){
      open();const current=ticket(session);if(!['allow','reject'].includes(action))throw gateError('INVALID_DECISION');
      const key=keyOf(session,id);
      if(deciding.has(key))throw gateError('STALE_APPROVAL');
      // Lock before the first await, then revalidate against durable state.
      deciding.add(key);
      try{
        const {store,row,value:b}=await read(session,id);
        if(row.status!=='pending'||row.userDecision||getScope(session))throw gateError('STALE_APPROVAL');
        signal?.throwIfAborted();open();
        await store.updateApprovalExecution(session,id,{approvalSource:'human-command',userDecision:action,note,executionState:'scope-confirming'});
        signal?.throwIfAborted();open();
        current();if(action==='allow')await setScope(session,b.origins,{ifAbsent:true});
        const state=action==='allow'?'approved':'rejected';let notification;
        try{await store.updateApprovalExecution(session,id,{status:state,executionState:action==='allow'?'scope-confirmed':'rejected'});}catch{notification='用户决定已经生效，但审批卡状态刷新失败；请核对出口范围，勿重复批准。';}
        return {state,origins:b.origins,sent:false,...(notification?{notification}:{}),nextAction:action==='allow'?'范围已确认；重试原请求，由风险闸重新审核。':'用户已拒绝范围，不得重试或换通道。'};
      }finally{deciding.delete(key);}
    },
    clear(){closed=true;},
  };
}
