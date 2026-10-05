import { defineTool } from '@deepseek-ai/dsh-tools';
import { currentEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
export function registerEgressTaskTool(ctx) {
  ctx.tools.register(defineTool({name:'src_egress_plan',description:'审核有限bash扫描任务。获准后绑定下一次实际启动的bash及其后代；先检查脚本再提交计划。精确请求及预算不可扩张，待审时结束当前回合等用户回注，不能用sleep等待。',
    parameters:{
      entries:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
        request:{type:'object',required:true,additionalProperties:false,properties:{url:{type:'string',required:true},method:{type:'string',required:true,enum:['GET','HEAD','OPTIONS']},headers:{type:'array',items:{type:'array',items:{type:'string'}}},bodyBase64:{type:'string'}}},
        maxRequests:{type:'number',required:true},
      }}},
      maxRequests:{type:'number',required:true},minIntervalMs:{type:'number',required:true},lifetimeMs:{type:'number',required:true},purpose:{type:'string',required:true},
    },
    output:{schema:{type:'object',additionalProperties:true,properties:{}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)+(value.state==='pending'?'\n计划待用户确认，未发送请求。无独立工作时结束当前回合；用户决定会回注，禁止sleep或轮询等待。':'\n下一次实际启动的bash绑定此有限计划，按原请求执行。')}]},
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
