import { jevDecide } from '../decision/jev-client.js';

// A captured single HTTP request uses the existing request-semantic contract.
// Do not bury it under a scan manifest: that loses method/URL context in the
// single-request classifier. A multi-request plan still requires whole-plan review.
export function assessEgressPlan(plan,exec={},decide=jevDecide) {
  if(plan.maxRequests===1&&plan.entries?.length===1&&plan.entries[0].maxRequests===1){
    const request=plan.entries[0].request;
    return decide({taskType:'risk-grade',method:request.method,url:request.url,
      headers:Object.fromEntries(request.headers),body:Buffer.from(request.bodyBase64,'base64').toString('utf8'),
      justification:plan.purpose,scopeChecked:true,
      authorization:'出口已由用户确认精确目标；仅低风险操作可自动发送，高危或未知操作仍需人工批准。',
      objective:'审核这一笔真实冻结的目标请求，不授予后续请求或其他目标权限。'},exec);
  }
  return decide({taskType:'scan-plan',plan,scopeChecked:true},exec);
}
