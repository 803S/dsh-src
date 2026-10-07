// 只消费宿主持有的人类原始消息；工具输出、模型目标和合成followup均不授予范围。
export function explicitUserScope(session) {
  const empty={origins:[],domains:[]};
  if(session?.header?.parentSession)return empty;
  for(const event of [...(session?.events??[])].reverse()) {
    if(event.type!=='agent/inbox/spliced')continue;
    for(const message of [...(event.data?.inserted??[])].reverse()) {
      if(message.role!=='user'||message.source?.kind!=='user'||!message.source.rpcId)continue;
      const text=(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
      // 最近的人类撤回/排除不能被更早的目标消息重新授权。
      if(/撤回|撤销|(?:停止|暂停|取消)(?:当前|全部|所有|该|本次)?(?:测试|扫描|任务|授权|范围)|^(?:停止|暂停|取消)[。！!\s]*$|不要[^。；\n]*(?:测试|扫描|访问)|禁止[^。；\n]*(?:测试|扫描|访问)|不再|do not|\bstop\b|revoke|exclude/i.test(text))return empty;
      // 不把引用、日志、排除项、疑问或待确认的地址当作人类明确指定目标。
      if(/```|^\s*>|示例|例如|引用|日志|不确定|是否|不要(?:测试|扫描|访问)|禁止(?:测试|扫描|访问)|不(?:测试|扫描|访问)|do not|for example|example\s*:|\bexclude\b/im.test(text))continue;
      if(!/(?:针对|目标|资产|范围|target|scope|测试|扫描|\bscan\b|\btest\b)/i.test(text)||!/(?:测试|漏洞挖掘|审计|扫描|test|scan|audit|assess)/i.test(text))continue;
      const urls=[...text.matchAll(/https?:\/\/[^\s<>"'`，。；、）)\]]+/g)].map(m=>m[0]);
      const origins=[];
      for(const raw of urls){try{const url=new URL(raw);if(url.username||url.password)return empty;origins.push(url.origin);}catch{return empty;}}
      // 多个不同目标的复杂任务不猜范围；本入口只处理明确单资产任务。
      const unique=[...new Set(origins)];
      if(urls.length)return unique.length===1?{origins:unique,domains:[]}:empty;
      // 无协议时只接受整句明确指定的单域；裸域不推断为整个注册域。
      const bare=text.trim().match(/^(?:针对|目标资产|目标|资产|范围|target|scope|测试|扫描|test|scan)\s*[:：]?\s*((?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,63})\s*(?:进行)?\s*(?:SRC|src)?\s*(?:测试|漏洞挖掘|审计|扫描|test|scan|audit)?[。.!\s]*$/i);
      if(!bare)return empty;
      try{const domain=domainGrant(bare[1]);return bare[1].startsWith('*.')?{origins:[],domains:[domain]}:{origins:['http://'+domain,'https://'+domain],domains:[]};}catch{return empty;}
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
