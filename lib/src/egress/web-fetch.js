// SRC adapter for the installed native web_fetch URL-only contract. It never
// invokes ctx.web (which may select an unconfined provider) or loads subresources.
import {promisify} from 'node:util';
import {gunzip,inflate,brotliDecompress} from 'node:zlib';
import {currentEgressExecution} from './runtime.js';
import {gateError} from './plan.js';
const decoders={gzip:promisify(gunzip),deflate:promisify(inflate),br:promisify(brotliDecompress)};
const MAX_BYTES=8*1024*1024,MAX_CHARS=16000,MAX_REDIRECTS=5;
const REDIRECTS=new Set([301,302,303,307,308]);
export async function executeGuardedWebFetch(exec){
 const context=currentEgressExecution();if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
 const args=exec.arguments;
 if(!args||Object.keys(args).some(key=>key!=='url')||typeof args.url!=='string'||!args.url.trim()||args.url.length>8192)throw gateError('INVALID_WEB_FETCH_ARGUMENTS');
 let url=new URL(args.url);url.hash='';const visited=new Set();let received=0;
 try{
  for(let hop=0;hop<=MAX_REDIRECTS;hop++){
   exec.signal?.throwIfAborted();
   if(visited.has(url.href))throw gateError('REDIRECT_LOOP');visited.add(url.href);
   const response=await context.manager.fetch(context.sessionId,url.href,{method:'GET',headers:{'user-agent':'dsh-src-web-fetch/1',accept:'text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.1'}},exec);
   received++;
   const location=response.headers.get('location');
   if(REDIRECTS.has(response.status)&&location){
    if(hop===MAX_REDIRECTS)throw gateError('REDIRECT_LIMIT');
    url=new URL(location,url);url.hash='';continue;
   }
   const type=response.headers.get('content-type')??'';
   if(type&&!/^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)|application\/(?:x-)?javascript)/i.test(type))throw gateError('WEB_FETCH_BINARY_CONTENT');
   let bytes=Buffer.from(await response.arrayBuffer());
   if(bytes.length>MAX_BYTES)throw gateError('RESPONSE_LIMIT');
   const encoding=(response.headers.get('content-encoding')??'identity').trim().toLowerCase();
   if(encoding!=='identity'){
    if(!Object.hasOwn(decoders,encoding))throw gateError('UNSUPPORTED_CONTENT_ENCODING');
    bytes=await decoders[encoding](bytes,{maxOutputLength:MAX_BYTES});
   }
   exec.signal?.throwIfAborted();
   const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]??'utf-8';
   const decoded=new TextDecoder(charset).decode(bytes),truncated=decoded.length>MAX_CHARS;
   const value={url:url.href,statusCode:response.status,body:{kind:/^(text\/html|application\/xhtml\+xml)/i.test(type)?'html':'text',content:decoded.slice(0,MAX_CHARS)},truncated};
   return {value,content:[{type:'text',text:`URL: ${value.url}\nHTTP ${value.statusCode}\n${truncated?'[内容已截断]\n':''}${value.body.content}`}]};
  }
 }catch(error){
  // A later-hop refusal or decode error must not claim the whole tool sent
  // nothing. Each actual response already has independent gateway evidence.
  if(received)error.safeNotSent=false;
  if(error.approvalId&&!error.message.includes(error.approvalId))error.message+=`: 审批 ${error.approvalId}；${error.nextAction??'结束当前回合等待用户处理；不要重发或换通道。'}`;
  throw error;
 }
}
