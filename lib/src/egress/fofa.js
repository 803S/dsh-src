// Fixed passive-index adapter. Never invoke the original MCP executor, follow
// result URLs, accept a caller endpoint/key, or reuse this lane for target traffic.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import yaml from 'js-yaml';
import {dispatchHttp} from './http-dispatch.js';
import {pinOrigin,pinnedLookup} from './scope.js';
import {reserveRequestStart} from '../request-rate.js';
import {gateError} from './plan.js';
export const isFofaTool=name=>name==='mcp__fofa__get_alerts';
const ENDPOINT='https://fofa.info/api/v1/search/all';
const FIELDS=['domain','ip','port','host','body','icon_hash','icp'];
export function fofaQuery(args){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>![...FIELDS,'status_code'].includes(key)))throw gateError('INVALID_FOFA_ARGUMENTS');
 const parts=[];
 for(const key of FIELDS){const value=args[key]??'';if(typeof value!=='string'||value.length>2048||/[\x00-\x1f]/.test(value))throw gateError('INVALID_FOFA_ARGUMENTS');if(value)parts.push(`${key}=${JSON.stringify(value)}`);}
 const status=args.status_code??'200';if(typeof status!=='string'||status!==''&&!/^\d{3}$/.test(status))throw gateError('INVALID_FOFA_ARGUMENTS');
 if(status)parts.push(`status_code=${status}`);
 const query=parts.join('&&');if(!query||query.length>8192)throw gateError('INVALID_FOFA_ARGUMENTS');return query;
}
export async function readFofaAccounts(home){
 let source;try{source=await readFile(path.join(home,'capabilities.yaml'),'utf8');}catch(error){if(error.code==='ENOENT')return [];throw gateError('FOFA_CONFIG_UNREADABLE');}
 if(Buffer.byteLength(source)>262144)throw gateError('FOFA_CONFIG_LIMIT');
 let settings;try{settings=yaml.load(source)?.settings??{};}catch{throw gateError('FOFA_CONFIG_INVALID');}
 const accounts=[];
 for(const [label,suffix] of [['primary',''],['backup','Backup'],['backup2','Backup2']]){
  const key=settings['fofaKey'+suffix],email=settings['fofaEmail'+suffix]??'';
  if(key===undefined||key==='')continue;
  if(typeof key!=='string'||typeof email!=='string'||key.length>4096||email.length>320||/[\x00-\x1f]/.test(key+email))throw gateError('FOFA_CONFIG_INVALID');
  if(!accounts.some(account=>account.key===key))accounts.push({label,key,email});
 }
 return accounts;
}
const output=result=>({value:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:{result}},content:[{type:'text',text:JSON.stringify(result)}]});
async function abortable(operation,signal){
 signal.throwIfAborted();
 let onAbort;
 try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});})]);}
 finally{signal.removeEventListener('abort',onAbort);}
}
export function createFofaLookup({home,send=dispatchHttp,pin=pinOrigin,wait=reserveRequestStart,now=Date.now}={}){
 const budgets=new Map();
 return async function execute(exec,session){
  let sent=false;
  try{
  if(!isFofaTool(exec?.name)||typeof session!=='string'||!session)throw gateError('INVALID_FOFA_CONTEXT');
  const query=fofaQuery(exec.arguments),accounts=await readFofaAccounts(home);
  exec.signal?.throwIfAborted();
  if(!accounts.length)return output({error:'未配置 FOFA key，请在 capabilities.yaml 的 settings 中配置。'});
  const time=now();for(const [id,row] of budgets)if(row.expiresAt<=time)budgets.delete(id);
  if(!budgets.has(session)&&budgets.size>=512)throw gateError('FOFA_CAPACITY');
  const budget=budgets.get(session)??{used:0,expiresAt:time+900000};budgets.set(session,budget);
  const attempted=[],signal=exec.signal?AbortSignal.any([exec.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
  const secrets=accounts.flatMap(account=>[account.key,account.email].filter(Boolean).flatMap(secret=>[secret,encodeURIComponent(secret)]));
  const scrub=text=>{for(const secret of secrets)text=text.split(secret).join('[redacted]');return text;};
  const redact=value=>{
   if(typeof value==='string')return scrub(value);
   if(Array.isArray(value))return value.map(redact);
   if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).map(([key,item])=>[scrub(key),redact(item)]));
   return value;
  };
  for(const account of accounts){
   signal.throwIfAborted();if(budget.used>=12)throw gateError('FOFA_BUDGET');budget.used++;
   attempted.push(account.label);
   await wait('src-public:fofa',500,signal);
   const pins=await abortable(()=>pin('https://fofa.info'),signal);signal.throwIfAborted();
   const url=new URL(ENDPOINT);url.search=new URLSearchParams({key:account.key,qbase64:Buffer.from(query).toString('base64'),size:'100',fields:'host,ip,port',...(account.email?{email:account.email}:{})}).toString();
   let response;
   try{sent=true;response=await send(url.href,{method:'GET',headers:{accept:'application/json','user-agent':'fofa-mcp/1.0'},lookup:pinnedLookup(pins),redirect:'manual',signal});}
   catch{signal.throwIfAborted();return output({error:'FOFA 查询传输失败（未重试，不返回可能含凭证的底层错误）',account_tried:attempted});}
   // A redirect is never a new target request, even to another public host.
   if(response.status>=300&&response.status<400)return output({error:'FOFA redirect refused',account_tried:attempted});
   const text=await response.text();if(Buffer.byteLength(text)>8*1024*1024)throw gateError('FOFA_RESPONSE_LIMIT');
   let data;try{data=JSON.parse(text);}catch{return output({error:'FOFA returned invalid JSON',account_tried:attempted});}
   if(!data||typeof data!=='object'||Array.isArray(data))return output({error:'FOFA returned invalid response',account_tried:attempted});
   const message=String(data.message??data.errmsg??'');
   if([401,403,429].includes(response.status)||data.error&&/820041|too many|rate|频繁|上限|无效|unauthorized/i.test(message))continue;
   if(response.status!==200||data.error||!Array.isArray(data.results))return output({error:'FOFA search failed',http_status:response.status,account_tried:attempted});
   if(data.results.length>100||data.results.some(row=>!Array.isArray(row)||row.length!==3||row.some(value=>!['string','number'].includes(typeof value)||String(value).length>2048)))throw gateError('FOFA_INVALID_RESULTS');
   const result={query,size:data.size,page:data.page,mode:data.mode,query_consumed:data.consumed_fpoint??data.required_fpoints,count:data.results.length,data:data.results.map(([host,ip,port])=>`主机名: ${host}\nIP地址: ${ip}\n端口: ${port}\n`).join('\n'),raw_results:data.results,account_used:account.label,...(attempted.length>1?{account_tried:attempted}:{})};
   if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw gateError('FOFA_OUTPUT_LIMIT');
   return output(redact(result));
  }
  return output({error:'FOFA authentication or quota unavailable',account_tried:attempted});
  }catch(error){if(sent)error.safeNotSent=false;throw error;}
 };
}
