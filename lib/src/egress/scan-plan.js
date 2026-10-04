import { currentEgressExecution } from './runtime.js';
export const SCAN_AGENT = 'dsh-src-recon/1';
export const SCAN_BYPASS_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv/127.0) Gecko/20100101 Firefox/127.0',
  'curl/8.4.0',
];
export async function prepareSurfacePlan(base,paths,intervalMs,exec) {
  const context=currentEgressExecution();
  if(!context)return undefined;
  const entries=new Map();
  function add(url,headers) {
    const request={url:new URL(url,base).href,method:'GET',headers:Object.entries(headers),bodyBase64:''};
    const key=JSON.stringify(request),entry=entries.get(key);
    if(entry)entry.maxRequests++;else entries.set(key,{request,maxRequests:1});
  }
  add('/',{'user-agent':SCAN_AGENT});
  for(const pathname of paths)add(pathname,{'user-agent':SCAN_AGENT});
  for(const agent of SCAN_BYPASS_AGENTS)add('/',{'user-agent':agent,accept:'text/html,application/xhtml+xml'});
  return context.manager.propose(context.sessionId,{entries:[...entries.values()],maxRequests:[...entries.values()].reduce((n,e)=>n+e.maxRequests,0),minIntervalMs:Math.max(250,Math.ceil(intervalMs)),lifetimeMs:900000,purpose:'有限路径扫描，包含预检与最多三次指定UA重试；禁止自动跟随跳转和计划外请求'},exec);
}
