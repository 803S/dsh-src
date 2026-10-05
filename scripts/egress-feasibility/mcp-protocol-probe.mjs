import {startConfinedBrowser} from '../../lib/src/egress/browser-process.js';
import path from 'node:path';
export async function mcpProtocolProbe(ctx,exec,origin,log){
 const client=await startConfinedBrowser({packagePath:process.env.DSH_EVAL_MCP_PACKAGE,executablePath:process.env.DSH_EVAL_BROWSER_EXECUTABLE,outputDir:path.join(exec.agent.session.header.cwd,'browser-protocol-output'),signal:exec.signal});
 try{
  await client.initialize({signal:exec.signal});const tools=await client.request('tools/list',{}, {signal:exec.signal});
  if(!tools.tools.some(t=>t.name==='browser_navigate'))throw new Error('Installed MCP navigation absent');
  const call=async(name,args={})=>{const result=await client.request('tools/call',{name,arguments:args},{signal:exec.signal});log({type:'native-mcp-protocol-call',name,result});if(result.isError)throw new Error('MCP error '+JSON.stringify(result));return result;};
  await call('browser_navigate',{url:origin+'/browser.html'});
  const snapshot=await call('browser_snapshot');if(!JSON.stringify(snapshot).includes('synthetic-browser'))throw new Error('Missing browser page');
  const result=await call('browser_evaluate',{function:`async()=>{const out=[];for(const method of ['GET','DELETE']){const r=await fetch(${JSON.stringify(origin+'/protocol/read')},{method});out.push({method,status:r.status,gate:r.headers.get('x-src-gate'),body:await r.text()});}return out;}`});
  const text=result.content.find(c=>c.type==='text'&&c.text.startsWith('### Result\n'))?.text;
  const values=JSON.parse(text?.split('### Result\n')[1]?.split('\n### Ran Playwright code')[0]??'null');
  if(values?.length!==2||values[0].status!==200||values[0].body!=='synthetic'||values[1].status!==403||values[1].gate!=='not-sent')throw new Error('MCP protocol action mismatch');
  await call('browser_close');
 }catch(error){log({type:'native-mcp-protocol-error',error:String(error),diagnostics:client.diagnostics()});throw error;}
 finally{await client.close();}
 log({type:'native-mcp-protocol-closed'});
 return {kind:'foreground',exitCode:0,signal:null,timedOut:false,aborted:false,timeoutMs:30000,stdout:{text:'mcp-protocol-passed',truncated:false},stderr:{text:'',truncated:false}};
}
