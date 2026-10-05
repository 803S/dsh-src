import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {currentEgressExecution,withEgressExecution} from './runtime.js';
import {createConfinedMcpClient} from './mcp-client.js';
import {gateError} from './plan.js';
import {readFile} from 'node:fs/promises';
const entry=fileURLToPath(new URL('./browser-worker.cjs',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
// Host-only primitive. Tool registration and per-session reuse live above it.
export async function startConfinedBrowser({packagePath,executablePath,outputDir,signal}){
 const context=currentEgressExecution();if(!context?.ctx?.shell||!context.exec?.agent?.session)throw gateError('MISSING_EXECUTION_CONTEXT');
 if([packagePath,executablePath,outputDir].some(p=>typeof p!=='string'||!path.isAbsolute(p)||/[\x00-\x1f]/.test(p)))throw gateError('INVALID_BROWSER_PATH');
 const cwd=context.exec.agent.session.header?.cwd??process.cwd();
 const proxy=context.proxy??await context.manager.sessionProxy(context.sessionId);
 // Native DSH also protects its deployment directory. Feed this fixed trusted
 // entry via argv rather than granting children access to that directory.
 // The placeholder entry keeps worker argv positions stable under node -e.
 const source=await readFile(entry,'utf8');
 const worker=withEgressExecution({...context,proxy},()=>context.ctx.shell.startGuardedTransport({command:[process.execPath,'-e',source,entry,packagePath,executablePath,outputDir].map(quote).join(' '),workdir:cwd,signal}));
 try{return createConfinedMcpClient(worker,{rootUri:pathToFileURL(cwd+path.sep).href});}
 catch(error){await worker.terminate();await worker.done.catch(()=>{});throw error;}
}
