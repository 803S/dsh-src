// Real installed MCP clients and bridge; backend fixtures are local only.
import {createServer} from 'node:http';
import {readFile,writeFile,symlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
export async function webMcpLayers({home,pkg,origin}){
 const realBurp=process.env.DSH_EVAL_REAL_BURP_HISTORY==='1';
 const methods=[],calls=[],streams=new Set();
 const burp=createServer(async(req,res)=>{
  if(req.method==='GET'){
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});streams.add(res);
   res.write('event: endpoint\ndata: /messages\n\n');res.on('close',()=>streams.delete(res));return;
  }
  let body='';for await(const part of req){body+=part;if(body.length>65536){res.writeHead(413).end();return;}}
  try{
   const message=JSON.parse(body);methods.push(message.method);if(message.method==='tools/call')calls.push({name:message.params?.name,arguments:message.params?.arguments});
   if(message.id!==undefined){
    const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'burp-fixture',version:'1'}}:
      message.method==='tools/list'?{tools:[{name:'get_proxy_http_history',description:'Read fixture-only proxy history',inputSchema:{type:'object',properties:{count:{type:'integer'},offset:{type:'integer'}},additionalProperties:false}},{name:'send_http1_request',description:'Active request must be blocked',inputSchema:{type:'object',properties:{targetHostname:{type:'string'},targetPort:{type:'integer'},usesHttps:{type:'boolean'},content:{type:'string'}},required:['targetHostname','targetPort','usesHttps','content'],additionalProperties:false}}]}:
      message.method==='tools/call'&&message.params?.name==='get_proxy_http_history'?{content:[{type:'text',text:'fixture-recorded-history-no-replay'}]}:null;
    const reply=result?{jsonrpc:'2.0',id:message.id,result}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Fixture method unavailable'}};
    for(const stream of streams)stream.write('event: message\ndata: '+JSON.stringify(reply)+'\n\n');
   }
   res.writeHead(202).end();
  }catch{res.writeHead(400).end();}
 });
 await new Promise(resolve=>burp.listen(0,'127.0.0.1',resolve));
 const installed=homedir()+'/.dsh/capabilities',meta=JSON.parse(await readFile(installed+'/playwright/node_modules/@playwright/mcp/package.json','utf8'));
 assert.equal(meta.version,'0.0.80');
 const original=JSON.parse(await readFile(installed+'/index.json','utf8'));
 const capabilities=original.capabilities.filter(item=>['playwright','fofa'].includes(item.id));assert.equal(capabilities.length,2);
 for(const item of capabilities)await symlink(installed+'/'+item.id,home+'/capabilities/'+item.id);
 await writeFile(home+'/capabilities/index.json',JSON.stringify({capabilities}));
 await writeFile(home+'/capabilities.yaml','settings:\n  fofaEmail: fixture@example.invalid\n  fofaKey: fixture-fofa-key\n');
 const trace=home+'/mcp-wire.jsonl',observer=pkg+'/scripts/egress-feasibility/mcp-registration-observer.cjs';
 const row=(id,args,env={})=>({id:'mcp-'+id,name:'@deepseek-ai/dsh-mcp-client',config:{serverName:id,transport:'stdio',command:process.execPath,args,env,failOnStartupError:true,toolCallTimeoutMs:30000}});
 return {
  rows:[{insert:[row('playwright',[observer,installed+'/playwright/node_modules/@playwright/mcp/cli.js',trace]),row('fofa',[observer,pkg+'/mcp-servers/fofa_MCP/fofa.py',trace,installed+'/fofa/.venv/bin/python']),row('burp',realBurp?[observer,pkg+'/tools/burp-mcp-bridge.mjs',home+'/burp-wire.jsonl']:[pkg+'/tools/burp-mcp-bridge.mjs'],{DSH_EVAL_REAL_BURP_HISTORY:realBurp?'1':'0',BURP_SSE_URL:realBurp?'http://127.0.0.1:9876/':'http://127.0.0.1:'+burp.address().port+'/'})]}],
  env:{DSH_EVAL_FOFA:'1',DSH_EVAL_FOFA_ORIGIN:origin},methods,calls,realBurp,
  async close(){for(const stream of streams)stream.destroy();burp.closeAllConnections();await new Promise(resolve=>burp.close(resolve));},
 };
}
