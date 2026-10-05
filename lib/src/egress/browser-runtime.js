import path from 'node:path';
import {homedir} from 'node:os';
import {access,readFile,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {gateError} from './plan.js';
// Owner-controlled capability inventory only. No model-supplied executable,
// npx install, CDP endpoint or shared desktop browser is accepted.
export async function resolveBrowserRuntime(items,{cacheDir=path.join(homedir(),'Library/Caches/ms-playwright'),arch=process.arch}={}){
 if(!Array.isArray(items))throw gateError('BROWSER_NOT_INSTALLED');
 const matches=items.filter(item=>item.id==='playwright'&&item.kind==='mcp'&&item.status==='installed'&&item.enabled!==false);
 if(matches.length!==1||typeof matches[0].dir!=='string'||!path.isAbsolute(matches[0].dir))throw gateError('BROWSER_NOT_INSTALLED');
 const packagePath=await realpath(path.join(matches[0].dir,'node_modules/@playwright/mcp'));
 const meta=JSON.parse(await readFile(path.join(packagePath,'package.json'),'utf8'));
 if(meta.name!=='@playwright/mcp'||meta.version!=='0.0.80')throw gateError('UNVERIFIED_BROWSER_RUNTIME');
 if(!['arm64','x64'].includes(arch))throw gateError('UNSUPPORTED_BROWSER_PLATFORM');
 const versions=(await readdir(cacheDir)).filter(name=>/^chromium_headless_shell-\d+$/.test(name)).sort((a,b)=>Number(b.split('-').at(-1))-Number(a.split('-').at(-1)));
 for(const version of versions){
  const executable=path.join(cacheDir,version,arch==='arm64'?'chrome-headless-shell-mac-arm64':'chrome-headless-shell-mac-x64','chrome-headless-shell');
  try{await access(executable,constants.X_OK);return {packagePath,executablePath:await realpath(executable)};}catch(error){if(!['ENOENT','EACCES'].includes(error.code))throw error;}
 }
 throw gateError('BROWSER_EXECUTABLE_MISSING');
}
