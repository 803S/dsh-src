import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
export function registerEgressTaskTool(ctx) {
  ctx.tools.register(defineTool({name:'src_egress_plan',description:'审核有限bash扫描任务。绑定精确请求及预算，不按命令名授权；待审时不得执行，获准后原bash工具自动走出口。超范围必须新计划。',
    parameters:{
      entries:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        request:{type:'object',required:true,additionalProperties:false,properties:{url:{type:'string',required:true},method:{type:'string',required:true,enum:['GET','HEAD','OPTIONS']},headers:{type:'array',items:{type:'array',items:{type:'string'}}},bodyBase64:{type:'string'}}},
        maxRequests:{type:'number',required:true},
      }}},
      maxRequests:{type:'number',required:true},minIntervalMs:{type:'number',required:true},lifetimeMs:{type:'number',required:true},purpose:{type:'string',required:true},
    },
    output:{schema:{type:'object',additionalProperties:true,properties:{}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:async(args,exec)=>{
      if(Object.keys(args).some(key=>!['entries','maxRequests','minIntervalMs','lifetimeMs','purpose'].includes(key)))throw gateError('INVALID_PLAN_FIELD');
      const context=currentEgressExecution();
      if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
      return context.manager.proposeShellTask(context.sessionId,args,exec);
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
