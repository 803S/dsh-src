import { requestSecrets, sanitizeEvidence, safeRequestBody } from '../evidence-output.js';
import {reviewBody} from '../decision/review-input.js';

/* 三个通道共用同一投影，但可见性不同：
 *  · 默认（review=false）：打码——凭据类头部与字段名一律 <stored>，供事件/工具结果使用。
 *  · review=true：仍是打码版，另把 body 换成带重复键去重损失的 reviewBody，给**外部判定服务**用
 *    （不把用户凭据发给它，与本地展示无关）。
 *  · raw=true：**原样**——审批卡给用户看的冻结报文。
 * [local.146 用户拍板 2026-10-18] 卡上的 <stored> 是安全戏。——现场取证：卡里 `cookie: <stored>` 的值
 * 就在会话目录的 cookie jar 里（模型 `-b jar.txt` 就能用，`cat jar.txt` 是只读操作、本就不拦），
 * 而 `password=<stored>&confirm=Test@12345` 里那个值是**模型自己编的测试密码**、同一行隔壁就是明文。
 * 打码既不保护用户（值就在自己的 jar 里），也不阻挡模型（它自己写的），只让卡片看起来没头没尾。
 * 用户是单用户本机环境，卡上直接显示原始 method/URL/headers/body。 */
export function presentPlan(plan, {review=false,raw=false}={}) {
  const requests=plan.entries.map(entry=>entry.request);
  const execution=plan.hostExecution;
  if(execution){requests.push(execution.request);if(execution.safety?.precondition)requests.push(execution.safety.precondition.request);if(execution.safety?.verification)requests.push(execution.safety.verification.request);}
  const secrets=requests.flatMap(request=>requestSecrets(Object.fromEntries(request.headers??[])));
  function presentRequest(request){
    const text=Buffer.from(request.bodyBase64??'','base64').toString('utf8');
    if(raw)return {method:request.method,url:request.url,headers:Object.fromEntries(request.headers??[]),body:text};
    return {
    method:request.method,url:sanitizeEvidence(request.url,secrets),
    headers:Object.fromEntries((request.headers??[]).map(([name,value])=>[name,/authorization|cookie|token|key|secret/i.test(name)?'<stored>':sanitizeEvidence(value,secrets)])),
    body:review?reviewBody(Buffer.from(request.bodyBase64??'','base64'),secrets):safeRequestBody(text,secrets),
  };}
  const result={...plan,purpose:raw?plan.purpose:sanitizeEvidence(plan.purpose,secrets),entries:plan.entries.map(({request,maxRequests})=>({maxRequests,request:presentRequest(request)}))};
  if(raw)return result;
  if(execution){
    const safety=execution.safety;
    result.hostExecution={request:presentRequest(execution.request),safety:safety?{
      ...safety,object:sanitizeEvidence(safety.object,secrets),recovery:sanitizeEvidence(safety.recovery,secrets),
      ...(safety.precondition?{precondition:{...safety.precondition,request:presentRequest(safety.precondition.request)}}:{}),
      ...(safety.verification?{verification:{...safety.verification,request:presentRequest(safety.verification.request)}}:{}),
    }:null};
  }
  return result;
}
