// Capability health checks never install packages or execute target-facing MCP
// tools. Startup and discovery run under the same native file policy, with all
// network denied (including direct sockets and inherited proxy configuration).
import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {currentEgressExecution,withEgressExecution} from './runtime.js';
import {createConfinedMcpClient} from './mcp-client.js';
import {gateError} from './plan.js';
import {readCapsManifest,dshHomeOf,capabilityCommand} from '../capability-loader.js';
import {readConfinedCapability} from './capability-executor.js';
const busy=new Set();
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
async function inside(root,relative){
 if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..')||/[\x00-\x1f]/.test(relative))throw gateError('INVALID_CAPABILITY_ENTRY');
 const file=await realpath(path.join(root,relative));
 if(!file.startsWith(root+path.sep)||!(await stat(file)).isFile())throw gateError('INVALID_CAPABILITY_ENTRY');
 return file;
}
export async function capabilityProbeCommand(cap){
 if(typeof cap.dir!=='string'||!path.isAbsolute(cap.dir))throw gateError('CAPABILITY_NOT_INSTALLED');
 const root=await realpath(cap.dir);
 if(String(cap.from).startsWith('npm:')){
  const name=cap.from.match(/^npm:((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^\s/]+)?$/i)?.[1];
  if(!name)throw gateError('INVALID_CAPABILITY_PACKAGE');
  const metaPath=await inside(root,'node_modules/'+name+'/package.json');
  if((await stat(metaPath)).size>65536)throw gateError('INVALID_CAPABILITY_PACKAGE');
  const meta=JSON.parse(await readFile(metaPath,'utf8'));
  const bins=typeof meta.bin==='string'?[meta.bin]:meta.bin&&typeof meta.bin==='object'?[...new Set(Object.values(meta.bin))]:[];
  if(meta.name!==name||bins.length!==1)throw gateError('AMBIGUOUS_CAPABILITY_ENTRY');
  const entry=await inside(path.dirname(metaPath),bins[0]);
  return {root,command:process.execPath,args:[entry]};
 }
 // The bundled FOFA launcher loads owner credentials and invokes uv. Health
 // discovery needs neither: use its installed offline Python server directly.
 const offlineFofa=cap.id==='fofa'&&(cap.entry==null||cap.entry==='fofa-launcher.mjs');
 const entry=await inside(root,offlineFofa?'fofa.py':cap.entry??'dist/index.js');
 const command=capabilityCommand(root,path.relative(root,entry));
 if(command.error)throw gateError('UNSUPPORTED_CAPABILITY_ENTRY');
 if(path.extname(entry)==='.py'){
  const python=path.join(root,'.venv/bin/python');
  try{if((await stat(python)).isFile())command.command=python;}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return {root,...command};
}
export async function testConfinedCapability(args,exec){
 const context=currentEgressExecution();if(!context)throw gateError('MISSING_EXECUTION_CONTEXT');
 const id=args.id;
 if(typeof id!=='string'||!/^[a-z][a-z0-9-]{1,30}$/.test(id))throw gateError('INVALID_CAPABILITY_ID');
 const cap=(await readCapsManifest(dshHomeOf())).items.find(item=>item.id===id);
 if(!cap||cap.status!=='installed'||cap.enabled===false||typeof cap.dir!=='string')return {id,ok:false,reason:'能力未安装、已禁用或缺少安装目录；请用户检查能力清单。'};
 if(cap.kind==='skill'){
  const root=await realpath(cap.dir),docs=cap.docs?[cap.docs]:['SKILL.md','README.md','README_CN.md'];
  for(const relative of docs){
   try{const filename=await inside(root,relative);await readConfinedCapability(filename);return {id,ok:true,kind:'skill',wired:true,hint:'能力文档可在原生文件权限下读取；未执行脚本、未访问目标。'};}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {id,ok:false,kind:'skill',reason:'能力文档缺失'};
 }
 const session=exec.agent.session.id;
 if(busy.has(session)||busy.size>=4)throw gateError('CAPABILITY_PROBE_BUSY');
 busy.add(session);let client,worker;
 try{
  const {command,args:argv}=await capabilityProbeCommand(cap);
  const cwd=exec.agent.session.header?.cwd??process.cwd();
  const signal=AbortSignal.any([AbortSignal.timeout(15000),...(exec.signal?[exec.signal]:[])]);
  const proxy={denyNetwork:true,alive:()=>true,protectedPaths:[],readOnlyPaths:[]};
  worker=withEgressExecution({...context,proxy},()=>context.ctx.shell.startGuardedTransport({command:[command,...argv].map(quote).join(' '),workdir:cwd,signal,timeoutMs:15000}));
  client=createConfinedMcpClient(worker,{rootUri:pathToFileURL(cwd+path.sep).href,timeoutMs:10000,maxMessageBytes:512*1024});
  await client.initialize({signal});
  const result=await client.request('tools/list',{}, {signal});
  if(!Array.isArray(result?.tools)||result.tools.length>256||result.tools.some(tool=>typeof tool.name!=='string'||!tool.name||tool.name.length>128))throw gateError('INVALID_CAPABILITY_TOOL_LIST');
  const registered=result.tools.filter(tool=>context.ctx.tools.get(`mcp__${id}__${tool.name}`,exec.agent)).length;
  return {id,kind:'mcp',ok:registered>0,protocolReady:true,wired:registered>0,toolCount:result.tools.length,registeredCount:registered,
   ...(registered?{}:{reason:'本地MCP握手成功，但当前会话无对应已注册可见工具。'}),
   hint:'已验证本地 initialize 和 tools/list；未执行 tools/call、未联网或下载。目标操作仍须通过出口审批。'};
 }catch(error){return {id,kind:'mcp',ok:false,protocolReady:false,reason:error?.code?.startsWith('SRC_GATE_')?error.code:'CAPABILITY_PROBE_FAILED',hint:'检查已安装的本地入口及离线初始化支持；未下载依赖，不代表目标服务不可用。'};}
 finally{try{if(client)await client.close();else if(worker){await worker.terminate();await worker.done.catch(()=>{});}}finally{busy.delete(session);}}
}
