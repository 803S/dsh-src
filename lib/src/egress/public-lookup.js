// These are fixed public search endpoints, not a general GET exception. Only
// named host tools can use them; shell/proxy requests cannot claim this lane.
import { gateError, canonicalRequest } from './plan.js';
import { pinOrigin, pinnedLookup } from './scope.js';
import { reserveRequestStart } from '../request-rate.js';
const SOURCES=new Map([
 ['https://html.duckduckgo.com/html/','q'],['https://duckduckgo.com/html/','q'],
 ['https://www.google.com/search','q'],['https://www.bing.com/search','q'],['https://www.baidu.com/s','wd'],
]);
const SURVEY=new Set(['https://api.fofa.info/api/v1/domains','https://app.agniops.in/v1/search','https://api.certspotter.com/v1/issuances']);
const TOOLS=new Set(['web_search','src_collect_dorks']);
const counts=new Map();
export function isPublicLookup(exec,url) {
  const target=new URL(url);
  return TOOLS.has(exec?.name)&&SOURCES.has(target.origin+target.pathname)||exec?.name==='src_survey_seed'&&SURVEY.has(target.origin+target.pathname);
}
export async function publicLookup(exec,session,url,init,send) {
  const request=canonicalRequest({url:String(url),method:init.method??'GET',headers:[...new Headers(init.headers??{}).entries()],bodyBase64:''});
  const target=new URL(url),parameter=SOURCES.get(target.origin+target.pathname);
  if(!isPublicLookup(exec,url)||request.method!=='GET'||init.body)throw gateError('INVALID_PUBLIC_LOOKUP');
  const survey=exec.name==='src_survey_seed';
  if(survey){
    const domain=target.searchParams.get('domain');
    if(!domain||domain.length>253||!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain))throw gateError('INVALID_PUBLIC_LOOKUP');
    const keys=target.hostname==='api.fofa.info'?['domain','page']:target.hostname==='api.certspotter.com'?['domain','include_subdomains','expand']:['domain'];
    if(target.searchParams.size!==keys.length||[...target.searchParams.keys()].some(key=>!keys.includes(key)))throw gateError('INVALID_PUBLIC_LOOKUP');
    if(keys.includes('page')&&!/^(?:[1-9]|10)$/.test(target.searchParams.get('page')??''))throw gateError('INVALID_PUBLIC_LOOKUP');
    if(keys.includes('expand')&&(target.searchParams.get('expand')!=='dns_names'||target.searchParams.get('include_subdomains')!=='true'))throw gateError('INVALID_PUBLIC_LOOKUP');
  }else if(target.searchParams.size!==1||!target.searchParams.has(parameter)||target.searchParams.get(parameter).length>2048)throw gateError('INVALID_PUBLIC_LOOKUP');
  const allowedHeaders=['user-agent','accept','accept-language',...(survey&&target.hostname==='api.fofa.info'?['x-fofa-key']:[])];
  if(request.headers.some(([name])=>!allowedHeaders.includes(name)))throw gateError('PUBLIC_LOOKUP_HEADERS');
  const key=session+':'+String(exec.callId??'session-budget');
  const now=Date.now();
  for(const [id,record] of counts)if(record.expiresAt<=now)counts.delete(id);
  if(!counts.has(key)&&counts.size>=512)throw gateError('PUBLIC_LOOKUP_CAPACITY');
  const record=counts.get(key)??{used:0,expiresAt:now+900000};if(record.used>=12)throw gateError('PUBLIC_LOOKUP_BUDGET');record.used++;counts.set(key,record);
  await reserveRequestStart('src-public:'+target.origin,500,exec.signal??init.signal);
  const pins=await pinOrigin(target.origin);
  return send(request.url,{lookup:pinnedLookup(pins),method:'GET',headers:Object.fromEntries(request.headers),redirect:'manual',signal:exec.signal??init.signal});
}
