// Trusted sender, called only after a ledger claim. No redirect or retry logic.
import http from 'node:http';
import https from 'node:https';
import { gateError } from './plan.js';
import { hostRequiresProxy } from './proxy-lane.js';
export function dispatchHttp(url, init = {}) {
  const target = new URL(url);
  if (!['https:','http:'].includes(target.protocol)) throw gateError('UNSUPPORTED_PROTOCOL');
  return new Promise((resolve,reject)=>{
    const send = target.protocol === 'https:' ? https.request : http.request;
    const request=send(target,{method:init.method??'GET',headers:init.headers,signal:init.signal,lookup:init.lookup,agent:false,rejectUnauthorized:true},response=>{
      let size=0;const chunks=[];
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>8*1024*1024){response.destroy(gateError('RESPONSE_LIMIT'));return;}
        chunks.push(chunk);
      });
      response.once('error',reject);
      response.once('end',()=>{
        const headers=new Headers();
        for(let i=0;i<response.rawHeaders.length;i+=2)headers.append(response.rawHeaders[i],response.rawHeaders[i+1]);
        const status=response.statusCode??502;
        resolve(new Response(['HEAD'].includes(init.method)||[204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
      });
    });
    request.setTimeout(15000,()=>request.destroy(new Error('SRC target response timeout')));
    request.once('error',reject);
    request.end(init.body);
  });
}

/* [local.143] 代理车道发送器：给“命中代理清单的境外主机”用，本机不做任何 DNS 解析。
 *
 * 现场根因（实测）：本机 DNS 把 raw.githubusercontent.com 应答成 0.0.0.0/::，
 * 于是 pinOrigin/公网校验先判“本机私网”拒绝，代理从未被调用；即使放行，
 * pinnedLookup 也会把请求钉到 0.0.0.0 上必然失败。代理解析是这条车道唯一正确的解析来源：
 * https 走 CONNECT 隧道（SNI 保留真实主机名、仍校验目标证书），http 用绝对形式直发代理。
 * 与 dispatchHttp 保持同一响应形态（盘 8MiB 上限、不跟重定向、带原始头）。
 */
const laneError = (code, message) => Object.assign(gateError(code), { message });
function connectTunnel(proxy, host, port, signal) {
  return new Promise((resolveSocket,rejectSocket)=>{
    const request=http.request({host:proxy.hostname,port:Number(proxy.port),method:'CONNECT',path:`${host}:${port}`,headers:{host:`${host}:${port}`}});
    request.on('connect',(response,socket)=>{
      if(response.statusCode===200){resolveSocket(socket);return;}
      socket.destroy();
      rejectSocket(laneError('PROXY_TUNNEL_REFUSED',`SRC_GATE_PROXY_TUNNEL_REFUSED：代理 ${proxy.host}:${proxy.port} 拒绝 CONNECT ${host}:${port}（HTTP ${response.statusCode}）；本机解析不参与此车道。`));
    });
    request.once('error',rejectSocket);
    if(signal)signal.addEventListener('abort',()=>{request.destroy();rejectSocket(gateError('ABORTED'));},{once:true});
    request.end();
  });
}
function bufferedResponse(raw) {
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    raw.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024){raw.destroy(laneError('RESPONSE_LIMIT','SRC_GATE_RESPONSE_LIMIT：响应超过 8MiB 上限，已中断读取。'));return;}chunks.push(chunk);});
    raw.once('error',reject);
    raw.once('end',()=>{
      const headers=new Headers();
      for(let i=0;i<raw.rawHeaders.length;i+=2)headers.append(raw.rawHeaders[i],raw.rawHeaders[i+1]);
      const status=raw.statusCode??502;
      resolve(new Response(['HEAD'].includes(String(raw.req?.method??'GET'))||[204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
    });
  });
}
export function dispatchHttpViaProxy(url, init = {}, { proxyUrl, timeoutMs = 15000 } = {}) {
  const target = new URL(url);
  if (!['https:','http:'].includes(target.protocol)) throw gateError('UNSUPPORTED_PROTOCOL');
  let proxy;
  try { proxy = new URL(String(proxyUrl)); } catch { throw gateError('PROXY_URL_REQUIRED'); }
  if (!/^https?:$/.test(proxy.protocol) || !proxy.port) throw gateError('PROXY_URL_REQUIRED');
  if (!hostRequiresProxy(target.hostname)) throw gateError('PROXY_LANE_NOT_APPLICABLE');
  const secure=target.protocol==='https:';
  const port=target.port!==''?Number(target.port):secure?443:80;
  const flatHeaders={};
  for (const [name,value] of Object.entries(init.headers??{})) if (typeof value==='string') flatHeaders[name.toLowerCase()]=value;
  flatHeaders.host??=target.host;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  if(init.signal)init.signal.addEventListener('abort',()=>controller.abort(),{once:true});
  const work=(async()=>{
    let raw;
    if(secure){
      const socket=await connectTunnel(proxy,target.hostname,port,controller.signal);
      raw=await new Promise((resolve,reject)=>{
        const request=https.request({socket,servername:target.hostname,host:target.hostname,port,method:init.method??'GET',path:`${target.pathname}${target.search}`,headers:flatHeaders},resolve);
        request.once('error',reject);
        controller.signal.addEventListener('abort',()=>request.destroy(gateError('ABORTED')),{once:true});
        if(typeof init.body==='string')request.write(init.body);
        request.end();
      });
    }else{
      raw=await new Promise((resolve,reject)=>{
        const request=http.request({host:proxy.hostname,port:Number(proxy.port),method:init.method??'GET',path:target.href,headers:flatHeaders},resolve);
        request.once('error',reject);
        controller.signal.addEventListener('abort',()=>request.destroy(gateError('ABORTED')),{once:true});
        if(typeof init.body==='string')request.write(init.body);
        request.end();
      });
    }
    return await bufferedResponse(raw);
  })();
  return work.finally(()=>clearTimeout(timer));
}
