// User command plane only. Never register configuration or API keys as model tools.
import { saveDecisionSettings } from './service-settings.js';
import { decisionServiceStatus, probeDecisionService } from './jev-client.js';
export function registerDecisionCommands(ctx) {
  ctx.commands.register({ name:'src-decision-status',description:'读取全局决策服务配置与最近连接结果（不回显密钥）。',recordInput:false,handler:async()=>{
    try{return {kind:'success',text:JSON.stringify(await decisionServiceStatus())};}catch{return {kind:'error',text:'配置无法读取，请检查全局决策设置文件'};}
  }});
  ctx.commands.register({ name:'src-decision-save',description:'保存全局SystemOne决策服务；下一调用生效，不写会话输入。',recordInput:false,input:{hint:'<JSON>'},handler:async(invocation)=>{
    try {let input;try{input=JSON.parse(invocation.rawInput);}catch{return {kind:'error',text:'设置必须是JSON对象'};}
      const saved=await saveDecisionSettings(input);return {kind:'success',text:JSON.stringify(saved)};
    }catch(error){return {kind:'error',text:error.message.startsWith('E')?'配置写入失败':error.message};}
  }});
  ctx.commands.register({name:'src-decision-test',description:'用合成任务测试已保存的决策服务，不发送业务数据、不唤醒主模型。',recordInput:false,handler:async(invocation)=>{
    const result=await probeDecisionService(invocation.signal);
    return {kind:result.fallback?'error':'success',text:result.fallback?`连接失败：${result.errorType}；主模型仍可继续，未回退到其他供应商。`:`SystemOne协议成功；模型 ${result.model}，${result.latency}ms；合成读取分类=${result.effect}。连接成功不代表判断准确率。`};
  }});
}
