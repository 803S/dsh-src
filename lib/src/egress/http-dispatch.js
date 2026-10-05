// Trusted sender, called only after a ledger claim. No redirect or retry logic.
import http from 'node:http';
import https from 'node:https';
import { gateError } from './plan.js';
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
