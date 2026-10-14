import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {canonicalRequest,gateError,LIMITS} from './plan.js';
import {browserLifecycle} from './browser-lifecycle.js';
import {currentEgressExecution} from './runtime.js';

const sends=new Set(['mcp__burp__send_http1_request','mcp__burp__send_http2_request']);
export const isBurpSendTool=name=>sends.has(name);
const requireThat=(condition,code='INVALID_BURP_REQUEST')=>{if(!condition)throw gateError(code);};
function record(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function freeze(value){if(record(value)||Array.isArray(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

// Inspect a single native Burp invocation. Keep the original bytes for Burp;
// canonicalization is only for the existing scope/risk/ledger checks.
// Burp 原生通道的 Host 头校验：只要求「主机名与 targetHostname 一致」，端口可省略。
// 【2026-10-14 现场修正】旧写法要求 Host 字面等于 hostname:port（或 `${hostname}:${targetPort}`），
// 而 agent 常写 `Host: host`（不带端口）而 targetPort=80 → 明明可用的请求被 HOST_MISMATCH 拦住
// （现场两次 mcp__burp__send_http1_request 直接报错）。Burp 用 targetHostname/targetPort 连接，
// Host 头只是报文内容，省略默认端口是合法写法。校验目的（防止 Host 走私到别的主机）不受影响：
// 主机名必须精确相等，带了端口就必须等于 targetPort。
export function hostHeaderMatches(value,{hostname,targetPort}) {
  const text=String(value ?? '').trim().toLowerCase();
  const bracket=/^\[([0-9a-fA-F:]+)\](?::(\d+))?$/.exec(text);
  const plain=/^([^:\s]+)(?::(\d+))?$/.exec(text);
  const host=(bracket?.[1]??plain?.[1]??'').replace(/\.$/,''), port=(bracket?.[2]??plain?.[2]??'');
  if(host==='')return false;
  const expected=String(hostname??'').trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(host!==expected)return false;
  return port===void 0||port===''||Number(port)===Number(targetPort);
}
export function inspectBurpRequest(name,input){
  requireThat(isBurpSendTool(name),'UNADAPTED_TOOL');
  requireThat(record(input));
  const serialized=JSON.stringify(input);
  requireThat(Buffer.byteLength(serialized)<=LIMITS.planBytes,'PLAN_LIMIT');
  const args=JSON.parse(serialized),http2=name.endsWith('send_http2_request');
  const keys=['targetHostname','targetPort','usesHttps',...(http2?['headers','pseudoHeaders','requestBody']:['content'])];
  requireThat(Object.keys(args).length===keys.length&&keys.every(key=>Object.hasOwn(args,key)));
  requireThat(typeof args.targetHostname==='string'&&typeof args.usesHttps==='boolean');
  requireThat(Number.isInteger(args.targetPort)&&args.targetPort>0&&args.targetPort<=65535);
  const hostname=isIP(args.targetHostname)===6?`[${args.targetHostname}]`:args.targetHostname;
  requireThat(/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(hostname));
  const origin=new URL(`${args.usesHttps?'https':'http'}://${hostname}:${args.targetPort}`).origin;
  let method,pathname,headers,body;
  if(http2){
    const pseudo=args.pseudoHeaders;
    requireThat(record(pseudo)&&record(args.headers)&&typeof args.requestBody==='string');
    requireThat(Object.keys(pseudo).length===4&&[':method',':scheme',':authority',':path'].every(key=>typeof pseudo[key]==='string'));
    requireThat(pseudo[':scheme']===(args.usesHttps?'https':'http'));
    requireThat(hostHeaderMatches(pseudo[':authority'],{hostname:new URL(origin).hostname.replace(/^\[|\]$/g,''),targetPort:args.targetPort}),'HOST_MISMATCH');
    method=pseudo[':method'];pathname=pseudo[':path'];body=args.requestBody;headers=Object.entries(args.headers);
  }else{
    requireThat(typeof args.content==='string');
    const divider=/\r?\n\r?\n/.exec(args.content);
    requireThat(divider);
    const lines=args.content.slice(0,divider.index).split(/\r?\n/);
    const start=/^([A-Z]+) (\/[^\s]*) HTTP\/1\.[01]$/.exec(lines.shift());
    requireThat(start);[,method,pathname]=start;body=args.content.slice(divider.index+divider[0].length);
    headers=lines.map(line=>{const header=/^([^:\s]+):[ \t]*(.*)$/.exec(line);requireThat(header);return [header[1],header[2]];});
  }
  requireThat(http2||body.length===0||headers.some(([key])=>key.toLowerCase()==='content-length'),'LENGTH_MISMATCH');
  requireThat(pathname.startsWith('/')&&!pathname.startsWith('//'));
  requireThat(headers.length<=64&&headers.reduce((n,[key,value])=>n+Buffer.byteLength(key)+Buffer.byteLength(String(value)),0)<=16384,'HEADER_LIMIT');
  const seen=new Set(),semantic=[];
  for(const [key,value] of headers){
    requireThat(typeof value==='string');const lower=key.toLowerCase();
    requireThat(!seen.has(lower),'UNSUPPORTED_HEADERS');seen.add(lower);
    if(lower==='connection'){
      requireThat(!http2&&/^(?:close|keep-alive)$/i.test(value),'UNSUPPORTED_HEADERS');
    }else if(lower==='host'){
      requireThat(hostHeaderMatches(value,{hostname:new URL(origin).hostname.replace(/^\[|\]$/g,''),targetPort:args.targetPort}),'HOST_MISMATCH');
    }else semantic.push([key,value]);
  }
  const request=canonicalRequest({url:origin+pathname,method,headers:semantic,bodyBase64:Buffer.from(body).toString('base64')});
  return freeze({name,args,request,digest:createHash('sha256').update(JSON.stringify([name,args])).digest('hex')});
}

// 只绑定Burp插件本身的有效配置与工具契约，不把模型/供应商配置混入审批。
function sourceBinding(ctx, native) {
  const loader=ctx.get?.('loader');
  if(typeof loader?.entries!=='function')return null;
  const entries=[...loader.entries()].filter(entry=>!entry.options?.disabled&&entry.options?.config?.serverName==='burp');
  if(entries.length!==1)return null;
  const {name,config}=entries[0].options;
  return createHash('sha256').update(JSON.stringify([name,config,native.name,native.parameters,native.execute.toString()])).digest('hex');
}
function senderFactory(ctx,store){
  const disposed=new WeakSet();let closed=false;
  ctx.on('session/disposed',session=>disposed.add(session));
  ctx.effect(()=>()=>{closed=true;});
  return async function bind(sessionId,captured,exec,restore=false){
    requireThat(exec?.agent?.session,'BURP_USER_CONTEXT_REQUIRED');
    const native=ctx.tools.get(captured.name,exec.agent);
    requireThat(typeof native?.execute==='function','UNAVAILABLE_TOOL');
    const source=sourceBinding(ctx,native);
    if(restore&&(!source||source!==captured.source))throw gateError('BURP_TOOL_CHANGED');
    const lifecycle=browserLifecycle(await store.domain());
    const tickets=[...new Set([sessionId,exec.agent.session.id])].map(id=>lifecycle.ticket(id));
    const check=()=>{
      if(closed||disposed.has(exec.agent.session))throw gateError('BURP_SESSION_CLOSED');
      for(const ticket of tickets)ticket();
      if(ctx.tools.get(captured.name,exec.agent)!==native||sourceBinding(ctx,native)!==source)throw gateError('BURP_TOOL_CHANGED');
    };
    check();return {source,check,invoke:async signal=>{
      check();signal.throwIfAborted();
      const args=structuredClone(captured.args);
      return native.execute(args,{...exec,name:captured.name,arguments:args,signal});
    }};
  };
}
// Native send only: never substitute HTTP or interpret Montoya prose as status.
export function createBurpSender(ctx,store){
  const bind=senderFactory(ctx,store);
  return async function execute(exec){
    const context=currentEgressExecution();
    if(!context||context.exec!==exec)throw gateError('MISSING_EXECUTION_CONTEXT');
    const captured=inspectBurpRequest(exec.name,exec.arguments);
    // [jev-approval-simplification §6/§8] 不在入口另起一次丢弃结果的 JeV 调用：
    // manager.sendBurp→authorize 携完整冻结请求做唯一评估，高危/未知产生唯一审批卡。
    return context.manager.sendBurp(context.sessionId,captured,exec,await bind(context.sessionId,captured,exec));
  };
}
// Called only from a fresh, verified human command, never from model dispatch.
export function createBurpRestorer(ctx,store){
  const bind=senderFactory(ctx,store);
  return async(session,captured,exec)=>{
    if(currentEgressExecution()||exec?.agent?.session?.id!==session)throw gateError('BURP_USER_CONTEXT_REQUIRED');
    const checked=inspectBurpRequest(captured.name,captured.args);
    if(checked.digest!==captured.digest||JSON.stringify(checked.request)!==JSON.stringify(captured.request))throw gateError('BURP_REQUEST_CHANGED');
    return bind(session,captured,exec,true);
  };
}
