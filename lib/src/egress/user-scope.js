// 只消费宿主持有的人类原始消息；工具输出、模型目标和合成followup均不授予范围。
// 一份人类任务里写出多个主域/通配域/URL 是 SRC 常态（多品牌资产），逐个授权即可，不再开局挂范围审批。
// 用户写下某个 host 就等于声明该 host 所属的注册域空间（www.example.com → example.com 及其子域），
// 但“注册域”用近似公共后缀表 + 共享托管域护栏算出：永远不会扩到公共后缀（com.cn）或共享托管顶点（github.io/*.vercel.app）。
// 授权来源仍只有用户自己写下的目标句：不推断未写出的域名、不从模型文本取范围。
import { sessionLogEvents } from '../session-log.js';

// 目标句标志：声明词或测试意图词（“扫描这个站点 http://…”同样是目标句）。
const SCOPE_START=/(?:针对|目标|资产|范围|攻击面|测试|扫描|审计|target|scope|test|scan|audit)/i;
// 同一子句出现排除/撤回语气 → 该子句放弃（宁可少授权，让人工再问一次）。
const SCOPE_CLAUSE_EXCLUDE=/(?:不要|无需|禁止|不准|排除|除外|不包括|不包含|不含|不测|别测|不再|exclude|except|do not|revoke|撤回|撤销|停止|暂停|取消)/i;
// 整条消息就是撤回（且没有声明目标）时，不回吃更早的目标消息。
const SCOPE_REVOKE=/撤回|撤销|(?:停止|暂停|取消)(?:当前|全部|所有|该|本次)?(?:测试|扫描|任务|授权|范围)|^(?:停止|暂停|取消)[。！!\s]*$|不要[^。；\n]*(?:测试|扫描|访问)|禁止[^。；\n]*(?:测试|扫描|访问)|不再|do not|\bstop\b|revoke|exclude/i;
const URL_TOKEN=/https?:\/\/[^\s<>"'`，。；、）)\]]+/g;
const WILDCARD_TOKEN=/\*\.((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})/gi;
const BARE_TOKEN=/(?:^|[^a-z0-9@._-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?![a-z0-9-])/gi;
// 多级公共后缀（近似、只用于“拒绝”）：父域恰好是它时不剥标签，否则 www.example.co.uk → co.uk 会把整个 ccTLD 授权出去。
const PUBLIC_SUFFIXES=new Set(['co.uk','org.uk','me.uk','ac.uk','net.uk','gov.uk','sch.uk','com.cn','net.cn','org.cn','gov.cn','edu.cn','ac.cn','com.hk','org.hk','com.tw','com.sg','com.my','com.ph','com.vn','co.th','co.id','com.au','net.au','org.au','co.nz','co.jp','ne.jp','or.jp','ac.jp','go.jp','co.kr','or.kr','com.br','com.ar','com.mx','com.co','com.pe','co.za','com.tr','com.sa','com.eg','com.ng','com.ua','com.ru','com.pl','com.es','com.pt','co.in','net.in','org.in','com.pk','com.bd','com.kh','com.mm','com.np','com.lk','co.il']);
// 共享托管（近似、只用于“拒绝”）：这些域下每个子域是不同租户，不替用户跨租户授权。完整 PSL private 段有几千条，本表必定不全。
const SHARED_HOSTS=new Set(['github.io','githubusercontent.com','githubassets.com','herokuapp.com','herokuapp.com','appspot.com','cloudfront.net','amazonaws.com','azurewebsites.net','cloudapp.net','trafficmanager.net','aliyuncs.com','myqcloud.com','qcloud.com','bdysite.com','bcebos.com','pages.dev','workers.dev','vercel.app','netlify.app','web.app','firebaseapp.com','glitch.me','repl.co','replit.dev','ngrok.io','ngrok-free.app','loca.lt','trycloudflare.com','serveo.net','readthedocs.io','blogspot.com','wordpress.com','tumblr.com','myshopify.com','azureedge.net','fastly.net','akamaiedge.net','gitee.io','gitlab.io','bitbucket.io','notion.site','sites.google.com','storage.googleapis.com','run.app','deno.dev','fly.dev','railway.app','onrender.com','surge.sh']);
/** 人类写下的 host → 它隐含的域空间（域名授权）：
 *  - host 本身就是注册域（两段，或父域是公共后缀如 foo.com.cn）→ 给 host 自身
 *  - host 是子域 → 只剥一层给父域（宁少不多；不推到底是因为那需要完整 PSL）
 *  - 公共后缀本身 / 共享托管顶点及其下 / IP → 不给（只留精确 origin）
 *  需求上的“多个主域”靠用户写下域名清单或点确认卡，不靠这个函数推。 */
function domainSpaceOf(host){
  const labels=String(host).toLowerCase().replace(/\.$/,'').split('.');
  if(labels.length<2)return null;
  const self=labels.join('.');
  if(PUBLIC_SUFFIXES.has(self)||SHARED_HOSTS.has(self))return null;
  const parent=labels.slice(1).join('.');
  if(SHARED_HOSTS.has(parent)||SHARED_HOSTS.has(parent.split('.').slice(-2).join('.')))return null;
  const target=labels.length===2||PUBLIC_SUFFIXES.has(parent)?self:parent;
  try{return domainGrant(target);}catch{return null;}
}
/** 解析一份人类消息里的显式目标：URL → 精确 origin + 父域（只剥一层）；裸域 → 该 host 默认 http/https + 整域（含父域）。
 *  用户写下「example.com」或「*.example.com」= 整域；“api.example.com”额外给它的父域 example.com。
 *  解析不了/非法/凭据 token 只丢该 token（不整条作废）；凭据本身不落库（origin 不带它）。 */
function declaredTargets(text){
  const origins=new Set(),domains=new Set();
  const addOrigin=host=>{origins.add('http://'+host);origins.add('https://'+host);};
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
        remainder=remainder.replace(match[0],' ');
        let url;try{url=new URL(match[0]);}catch{continue;}
        // URL.origin 天然不含凭据（user:pass@ 被剥掉），范围账本不会存凭据。
        origins.add(url.origin);
        const domain=domainSpaceOf(url.hostname);
        if(domain)domains.add(domain);
      }
      for(const match of remainder.matchAll(WILDCARD_TOKEN)){remainder=remainder.replace(match[0],' ');try{domains.add(domainGrant(match[0]));}catch{/* 非法域不是目标 */}}
      for(const match of remainder.matchAll(BARE_TOKEN)){
        const host=match[1].toLowerCase();
        let domain;try{domain=domainGrant(host);}catch{continue;}
        addOrigin(host);domains.add(domain);
        const wider=domainSpaceOf(host);
        if(wider&&wider!==domain){domains.add(wider);addOrigin(wider);}
      }
    }
  }
  // 上限与 setUserScope 一致；超出按排序截断，不留“无解死路”。
  return {origins:[...origins].sort().slice(0,256),domains:[...domains].sort().slice(0,256)};
}
export function explicitUserScope(session) {
  const empty={origins:[],domains:[]};
  if(session?.header?.parentSession)return empty;
  for(const event of [...sessionLogEvents(session)].reverse()) {
    if(event.type!=='agent/inbox/spliced')continue;
    for(const message of [...(event.data?.inserted??[])].reverse()) {
      if(message.role!=='user'||message.source?.kind!=='user'||!message.source.rpcId)continue;
      const text=(message.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
      // 不把引用、日志、示例、疑问或待确认的地址当作人类明确指定目标。
      if(/```|^\s*>|示例|例如|引用|日志|不确定|是否|do not|for example|example\s*:|\bexclude\b/im.test(text))continue;
      const {origins,domains}=declaredTargets(text);
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
