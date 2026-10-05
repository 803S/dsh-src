import {gateError} from './plan.js';

// Host-owned JSON-RPC client for an already OS-confined stdio worker. It never
// spawns, retries, samples a model, prompts a user, or follows a server URL.
export function createConfinedMcpClient(handle,{rootUri,timeoutMs=30000,maxMessageBytes=8*1024*1024}={}){
  if(!handle.stdin||!handle.stdout||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(maxMessageBytes)||maxMessageBytes<1024||maxMessageBytes>8*1024*1024)throw gateError('INVALID_MCP_TRANSPORT');
  if(typeof rootUri!=='string'||new URL(rootUri).protocol!=='file:')throw gateError('INVALID_MCP_ROOT');
  let sequence=0,pending,buffer=Buffer.alloc(0),closed=false,closing,notifications=0;
  const error=code=>Object.assign(gateError(code),{safeNotSent:false});
  function settle(failure,value){const waiter=pending;if(!waiter)return;pending=undefined;clearTimeout(waiter.timer);waiter.signal?.removeEventListener('abort',waiter.abort);failure?waiter.reject(failure):waiter.resolve(value);}
  function close(reason=error('MCP_CLOSED')){
    if(closing)return closing;
    closed=true;buffer=Buffer.alloc(0);settle(reason);
    closing=(async()=>{try{await handle.terminate();}finally{await handle.done.catch(()=>{});handle.stdout.off('data',onData);handle.stdout.off('error',onError);handle.stdin.off('error',onError);}})();
    return closing;
  }
  function fail(code){void close(error(code)).catch(()=>{});}
  function send(message){
    const bytes=Buffer.from(JSON.stringify(message)+'\n');
    if(bytes.length>256*1024)throw error('MCP_REQUEST_LIMIT');
    handle.stdin.write(bytes,err=>{if(err)fail('MCP_WRITE_FAILED');});
  }
  function receive(message){
    if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0')throw error('MCP_INVALID_RESPONSE');
    if(typeof message.method==='string'){
      if(++notifications>256)throw error('MCP_NOTIFICATION_LIMIT');
      if(message.id!==undefined){
        if(!['string','number'].includes(typeof message.id))throw error('MCP_INVALID_RESPONSE');
        send(message.method==='roots/list'
          ? {jsonrpc:'2.0',id:message.id,result:{roots:[{uri:rootUri,name:'workspace'}]}}
          : {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported client request'}});
      }
      return;
    }
    if(!pending||message.id!==pending.id||Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw error('MCP_INVALID_RESPONSE');
    if(Object.hasOwn(message,'error'))settle(error('MCP_REMOTE_ERROR'));
    else settle(undefined,message.result);
  }
  function onData(chunk){
    if(closed)return;
    try{
      let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),offset=0,messages=0;
      for(;;){
        const end=bytes.indexOf(10,offset),last=end<0?bytes.length:end;
        if(buffer.length+last-offset>maxMessageBytes)throw error('MCP_RESPONSE_LIMIT');
        buffer=Buffer.concat([buffer,bytes.subarray(offset,last)]);
        if(end<0)break;
        if(++messages>256)throw error('MCP_NOTIFICATION_LIMIT');
        const line=buffer;buffer=Buffer.alloc(0);offset=end+1;
        receive(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)));
        if(closed||offset===bytes.length)break;
      }
    }catch(e){void close(e?.code?.startsWith('SRC_GATE_')?e:error('MCP_INVALID_RESPONSE')).catch(()=>{});}
  }
  const onError=()=>fail('MCP_STREAM_FAILED');
  handle.stdout.on('data',onData);handle.stdout.on('error',onError);handle.stdin.on('error',onError);
  handle.done.then(()=>fail('MCP_EXITED'),()=>fail('MCP_SPAWN_FAILED'));
  function request(method,params,{signal}={}){
    if(closed)return Promise.reject(error('MCP_CLOSED'));
    if(pending)return Promise.reject(error('MCP_BUSY'));
    if(signal?.aborted)return Promise.reject(error('MCP_ABORTED'));
    notifications=0;
    return new Promise((resolve,reject)=>{
      const id=++sequence,abort=()=>fail('MCP_ABORTED');
      pending={id,resolve,reject,signal,abort,timer:setTimeout(()=>fail('MCP_TIMEOUT'),timeoutMs)};
      signal?.addEventListener('abort',abort,{once:true});
      try{send({jsonrpc:'2.0',id,method,params});}catch(e){void close(e).catch(()=>{});}
    });
  }
  return {
    async initialize(options){
      const result=await request('initialize',{protocolVersion:'2024-11-05',capabilities:{roots:{}},clientInfo:{name:'dsh-src-confined',version:'1'}},options);
      if(result?.protocolVersion!=='2024-11-05'||!result.capabilities||!result.serverInfo){await close(error('MCP_INVALID_INITIALIZE'));throw error('MCP_INVALID_INITIALIZE');}
      send({jsonrpc:'2.0',method:'notifications/initialized'});return result;
    },
    request,close,get closed(){return closed;},
    // Host diagnostics only; callers must not blindly publish worker stderr.
    diagnostics(){return {closed,stderr:handle.collected?.stderr?.readFrom(0)?.text?.slice(-2000)??''};},
  };
}
