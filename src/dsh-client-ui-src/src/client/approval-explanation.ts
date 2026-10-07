export type ApprovalExplanationInput = {
  method: string
  url: string
  body?: string
  category?: string
  reason?: string
  justification?: string
  layaAdvice?: string
  safetyPlan?: {backupRef?:string; snapshotVerified?:boolean; recovery?:string; validationError?:string}
  writeOutcome?: {warning?:string}
}

const boundedText=(value:string,limit:number)=>value.length>limit?value.slice(0,limit)+'…':value;

export function approvalTarget(input: ApprovalExplanationInput): string {
  try {
    if(input.method==='ASSET')return '*.'+input.url.replace(/^\*\./,'');
    if(input.method==='SCOPE'){
      const origins:unknown=JSON.parse(input.body??'{}').origins;
      if(!Array.isArray(origins)||!origins.length||!origins.every(o=>typeof o==='string'&&new URL(o).origin===o))throw new Error('scope');
      return origins.join('，');
    }
    if(input.method==='TASK'){
      const stored=JSON.parse(input.body??'');
      const entries=Array.isArray(stored)?stored:stored.entries;
      if(!Array.isArray(entries)||!entries.length)throw new Error('task');
      const targets=entries.map(e=>{
        if(typeof e?.request?.method!=='string'||!['http:','https:'].includes(new URL(e.request.url).protocol))throw new Error('request');
        return e.request.method+' '+e.request.url;
      });
      return targets.slice(0,3).join('；')+(targets.length>3?`；共${targets.length}项，见请求报文`:'');
    }
    return input.method+' '+new URL(input.url).href;
  }catch{return '范围或冻结请求无法解析，请核对，不要批准';}
}

// 卡片展示实际判定/阻断，不把HTTP方法泛化成未经证实的业务后果。
export function approvalBlockReason(input: ApprovalExplanationInput): string {
  if(input.method==='SCOPE')return '未能从人类任务中确定范围，需要补充确认；仅确认范围，不发包。'
  if(input.method==='ASSET')return input.reason || '该域名归属未确认。'
  let assessment: Record<string, unknown> = {}
  try {
    const match=input.reason?.match(/执行前判定(\{[^}]*\})/)
    assessment=JSON.parse(match?.[1] ?? input.layaAdvice ?? '{}')
  } catch { /* 旧记录没有可解析判定时不编造原因。 */ }
  if(assessment.fallback===true)return 'Jev未返回有效判定；本请求未获自动执行许可。'
  if(assessment.hardVeto===true)return '请求存在方法改写或编码歧义，不能自动执行。'
  if(assessment.risk==='high'){
    const effect: Record<string,string>={destructive:'识别到删除或破坏性操作',write:'识别到数据写入或覆盖',external:'识别到外发或费用影响',auth:'认证操作被判为高风险'}
    return `Jev：${effect[String(assessment.effect)] ?? '本次请求被判为高风险'}。${['read','compute'].includes(String(assessment.effect))?'操作分类与风险不一致，请核对原始请求。':'请核对下方实际请求。'}`
  }
  if(assessment.risk==='unknown')return 'Jev未能确定本次操作的实际影响。'
  const action=assessment.action ?? assessment.verdict
  if(assessment.risk==='low'&&action==='allow')return 'Jev已判低风险并放行；此单由执行边界或旧策略挂起，不代表识别出了高危操作。'
  if(assessment.risk==='low')return 'Jev判低风险，但未授予自动执行许可。'
  return input.reason && !input.reason.includes('摘要') ? boundedText(input.reason,180) : '旧审批记录缺少可解析的阻断原因，请查看原始请求。'
}
