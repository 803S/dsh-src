import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
import { PENDING_CONTINUATION } from './notifications.js';
export function registerEgressTaskTool(ctx) {
  ctx.tools.register(defineTool({name:'src_egress_plan',description:`审核有限bash扫描任务。自动获准后绑定下一次实际启动的bash及其后代；人工待审只挂起本计划，批准后先携原taskId及原参数恢复，再启动对应bash；先检查脚本再提交计划。精确请求及预算不可扩张。${PENDING_CONTINUATION}`,
    parameters:{
      taskId:{type:'string',description:'人工批准后的原计划ID；恢复时保留原参数，不重建预算。'},
      entries:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        request:{type:'object',required:true,additionalProperties:false,properties:{url:{type:'string',required:true},method:{type:'string',required:true,enum:['GET','HEAD','OPTIONS']},headers:{type:'array',items:{type:'array',items:{type:'string'}}},bodyBase64:{type:'string'}}},
        maxRequests:{type:'number',required:true},
      }}},
      maxRequests:{type:'number',required:true},minIntervalMs:{type:'number',required:true},lifetimeMs:{type:'number',required:true},purpose:{type:'string',required:true},
    },
    output:{schema:{type:'object',additionalProperties:true,properties:{}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)+(value.state==='pending'?`\n计划待用户确认，未发送请求。${PENDING_CONTINUATION}`:'\n下一次实际启动的bash绑定此有限计划，按原请求执行。')}]},
    execute:async(args,exec)=>{
      if(Object.keys(args).some(key=>!['taskId','entries','maxRequests','minIntervalMs','lifetimeMs','purpose'].includes(key)))throw gateError('INVALID_PLAN_FIELD');
      const context=currentEgressExecution();
      if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
      const {taskId,...input}=args;
      return context.manager.proposeShellTask(context.sessionId,input,exec,taskId);
    },
  }));
  ctx.tools.register(defineTool({name:'src_egress_prepare',description:'为已捕获的单笔待审请求补充安全材料，不发送、不批准。原审批作废，用户须审核新的摘要。',
    parameters:{approvalId:{type:'string',required:true},safetyPlan:{type:'object',required:true,additionalProperties:true}},
    output:{schema:{type:'object',additionalProperties:true,properties:{}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args,exec)=>{
      if(Object.keys(args).some(key=>!['approvalId','safetyPlan'].includes(key)))throw gateError('INVALID_PLAN_FIELD');
      const context=currentEgressExecution();if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
      return context.manager.preparePending(context.sessionId,args.approvalId,args.safetyPlan,exec);
    },
  }));

}
