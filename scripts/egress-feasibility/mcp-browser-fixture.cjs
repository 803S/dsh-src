// Runs ONLY inside the real DSH guarded bash fixture. No production registration.
const {createConnection}=require(process.argv[2]);
const origin=process.argv[4];
const trace=value=>require('node:fs').appendFileSync('mcp-browser-trace.jsonl',JSON.stringify(value)+'\n');
async function main(){
 const server=await createConnection({browser:{browserName:'chromium',isolated:true,launchOptions:{executablePath:process.argv[3],headless:true,args:['--single-process','--no-zygote'],proxy:{server:process.env.HTTPS_PROXY,bypass:'<-loopback>'}},contextOptions:{ignoreHTTPSErrors:true,serviceWorkers:'block'}},outputDir:process.cwd()+'/browser-output'});
 let id=0;const pending=new Map();
 const transport={async start(){},async close(){transport.onclose?.();},async send(message){
  if(message.method){if(message.id!==undefined)queueMicrotask(()=>transport.onmessage({jsonrpc:'2.0',id:message.id,result:message.method==='roots/list'?{roots:[{uri:new URL('file://'+process.cwd()+'/').href,name:'fixture'}]}:{}}));return;}
  const wait=pending.get(message.id);if(!wait)return;pending.delete(message.id);clearTimeout(wait.timer);message.error?wait.reject(new Error(JSON.stringify(message.error))):wait.resolve(message.result);
 }};
 function request(method,params){trace({phase:'request',method,name:params?.name});return new Promise((resolve,reject)=>{const callId=++id,timer=setTimeout(()=>{pending.delete(callId);reject(new Error('MCP fixture timeout: '+method));},20000);pending.set(callId,{resolve,reject,timer});transport.onmessage({jsonrpc:'2.0',id:callId,method,params});});}
 async function call(name,args={}){const result=await request('tools/call',{name,arguments:args});trace({phase:'result',tool:name,result});if(result.isError)throw new Error(name+': '+JSON.stringify(result));console.log(JSON.stringify({tool:name,result}));return result;}
 try{
  await server.connect(transport);
  await request('initialize',{protocolVersion:'2024-11-05',capabilities:{roots:{}},clientInfo:{name:'dsh-confined-fixture',version:'1'}});
  transport.onmessage({jsonrpc:'2.0',method:'notifications/initialized'});
  const list=await request('tools/list',{});for(const name of ['browser_navigate','browser_evaluate','browser_snapshot','browser_close'])if(!list.tools.some(t=>t.name===name))throw new Error('Missing installed tool '+name);
  const navigation=await call('browser_navigate',{url:origin+'/browser.html'});
  // This installed MCP returns a snapshot file link, not inline page text.
  const fs=require('node:fs');const snapshots=fs.readdirSync('browser-output').filter(name=>name.endsWith('.yml')).map(name=>fs.readFileSync('browser-output/'+name,'utf8'));
  if(!JSON.stringify(navigation).includes(origin+'/browser.html')||!snapshots.some(text=>text.includes('synthetic-browser')))throw new Error('MCP navigation snapshot missing fixture page');
  const evaluation=await call('browser_evaluate',{function:`async () => {const result=[];for(const [method,path] of [['GET','/mcp-browser-read'],['DELETE','/mcp-browser-delete']]){const r=await fetch(${JSON.stringify(origin)}+path,{method});result.push({method,status:r.status,gate:r.headers.get('x-src-gate'),body:await r.text()});}return result;}`});
  const resultText=evaluation.content.find(c=>c.type==='text'&&c.text.startsWith('### Result\n'))?.text;
  const results=JSON.parse(resultText?.split('### Result\n')[1]?.split('\n### Ran Playwright code')[0]??'null');
  if(!Array.isArray(results)||results.length!==2||results[0].method!=='GET'||results[0].status!==200||results[0].body!=='synthetic'||results[1].method!=='DELETE'||results[1].status!==403||results[1].gate!=='not-sent')throw new Error('MCP action evidence incomplete');
  const snapshot=await call('browser_snapshot');if(!JSON.stringify(snapshot).includes('synthetic-browser'))throw new Error('Snapshot lost original page');
  await call('browser_tabs',{action:'new',url:origin+'/mcp-browser-tab'});
  await call('browser_tabs',{action:'select',index:0});
  const original=await call('browser_snapshot');if(!JSON.stringify(original).includes('synthetic-browser'))throw new Error('Tab switch lost original context');
  await call('browser_tabs',{action:'close',index:1});
  await call('browser_close');
  await call('browser_navigate',{url:origin+'/docs/readme.html'});
  const reopened=await call('browser_evaluate',{function:'() => document.body.innerText'});
  const reopenedText=reopened.content.find(c=>c.type==='text'&&c.text.startsWith('### Result\n'))?.text;
  if(JSON.parse(reopenedText?.split('### Result\n')[1]?.split('\n### Ran Playwright code')[0]??'null')!=='synthetic')throw new Error('Reopened page did not load fixture content');
 }finally{try{await call('browser_close');}finally{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('fixture closed'));}pending.clear();await server.close();}}
 console.log('MCP_BROWSER_FIXTURE_COMPLETE');
}
main().catch(error=>{trace({error:String(error)});console.error(String(error));process.exitCode=1;});
