// 只消费宿主持有的人类原始消息；工具输出、模型目标和合成followup均不授予范围。
// 一份人类任务里写出多个主域/通配域/URL 是 SRC 常态（多品牌资产），逐个授权即可，不再开局挂范围审批。
// 授权来源仍只有用户自己写下的目标句：不推断、不从子域倒推注册域、不从模型文本取范围。
// 目标句标志：声明词或测试意图词（“扫描这个站点 http://…”同样是目标句）。
const SCOPE_START=/(?:针对|目标|资产|范围|攻击面|测试|扫描|审计|target|scope|test|scan|audit)/i;
// 同一子句出现排除/撤回语气 → 该子句放弃（宁可少授权，让人工再问一次）。
const SCOPE_CLAUSE_EXCLUDE=/(?:不要|无需|禁止|不准|排除|除外|不包括|不包含|不含|不测|别测|不再|exclude|except|do not|revoke|撤回|撤销|停止|暂停|取消)/i;
// 整条消息就是撤回（且没有声明目标）时，不回吃更早的目标消息。
const SCOPE_REVOKE=/撤回|撤销|(?:停止|暂停|取消)(?:当前|全部|所有|该|本次)?(?:测试|扫描|任务|授权|范围)|^(?:停止|暂停|取消)[。！!\s]*$|不要[^。；\n]*(?:测试|扫描|访问)|禁止[^。；\n]*(?:测试|扫描|访问)|不再|do not|\bstop\b|revoke|exclude/i;
const URL_TOKEN=/https?:\/\/[^\s<>"'`，。；、）)\]]+/g;
const WILDCARD_TOKEN=/\*\.((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})/gi;
const BARE_TOKEN=/(?:^|[^a-z0-9@._-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?![a-z0-9-])/gi;
/** 解析一份人类消息里的显式目标：URL→精确 origin；*.域→整域；裸域→默认 http/https 两个 origin + 该域整域。
 *  用户写下「example.com」就等于声明该域空间；子域发现据此自动放行，不再逐个子域问人。 */
function declaredTargets(text){
  const origins=new Set(),domains=new Set();
  const lines=String(text).split('\n');
  const header=lines.find(line=>line.trim()!=='')??'';
  // 目标清单常见写法：首行「目标资产如下：」，后续行只列域名。
  const listHeader=SCOPE_START.test(header);
  for(const line of lines){
    if(!(SCOPE_START.test(line)||listHeader))continue;
    for(const clause of line.split(/[，,、;；]+/)){
      if(SCOPE_CLAUSE_EXCLUDE.test(clause))continue;
      let remainder=clause;
      for(const match of clause.matchAll(URL_TOKEN)){
        try{const url=new URL(match[0]);if(url.username||url.password)return {unusable:true};origins.add(url.origin);}catch{return {unusable:true};}
        remainder=remainder.replace(match[0],' ');
      }
      for(const match of remainder.matchAll(WILDCARD_TOKEN)){try{domains.add(domainGrant(match[0]));}catch{return {unusable:true};}remainder=remainder.replace(match[0],' ');}
      for(const match of remainder.matchAll(BARE_TOKEN)){try{const domain=domainGrant(match[1]);domains.add(domain);origins.add('http://'+domain);origins.add('https://'+domain);}catch{/* 非法标签序列不是目标 */}}
    }
  }
  if(origins.size>256||domains.size>256)return {unusable:true};
  return {unusable:false,origins:[...origins].sort(),domains:[...domains].sort()};
}
export function explicitUserScope(session) {
  const empty={origins:[],domains:[]};
  if(session?.header?.parentSession)return empty;
  for(const event of [...(session?.events??[])].reverse()) {
    if(event.type!=='agent/inbox/spliced')continue;
    for(const message of [...(event.data?.inserted??[])].reverse()) {
      if(message.role!=='user'||message.source?.kind!=='user'||!message.source.rpcId)continue;
      const text=(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
      // 不把引用、日志、示例、疑问或待确认的地址当作人类明确指定目标。
      if(/```|^\s*>|示例|例如|引用|日志|不确定|是否|do not|for example|example\s*:|\bexclude\b/im.test(text))continue;
      const {unusable,origins,domains}=declaredTargets(text);
      if(unusable)return empty;
      // 同一份消息里声明了目标就以它为准（同行/同子句写出的排除已在解析时剔除）。
      if(origins.length||domains.length)return {origins,domains};
      // 整条消息是撤回且没有声明目标：不授权，也不回吃更早的目标消息。
      if(SCOPE_REVOKE.test(text))return empty;
    }
  }
  return empty;
}
export const explicitUserOrigins=session=>explicitUserScope(session).origins;
export function domainGrant(value) {
  const domain=String(value).toLowerCase().replace(/^\*\./,'').replace(/\.$/,'');
  if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))throw new Error('INVALID_DOMAIN_GRANT');
  return domain;
}
export const withinDomain=(host,domain)=>host===domain||host.endsWith('.'+domain);
