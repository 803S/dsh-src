// Optional test telemetry. Never records argv/environment or unrelated processes.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function summarizeProcessTree(raw,root,excludedPids=[]){
 const rows=raw.split('\n').flatMap(line=>{
  const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
  return m?[{pid:Number(m[1]),parent:Number(m[2]),rssKiB:Number(m[3]),executable:m[4].split('/').at(-1)}]:[];
 });
 const ids=new Set([root]);let previous;
 do{previous=ids.size;for(const row of rows)if(ids.has(row.parent))ids.add(row.pid);}while(ids.size!==previous);
 const processes=rows.filter(row=>ids.has(row.pid)&&!excludedPids.includes(row.pid));
 return {rootPresent:processes.some(row=>row.pid===root),processCount:processes.length,
  rootRssKiB:processes.find(row=>row.pid===root)?.rssKiB??0,
  totalRssKiB:processes.reduce((n,row)=>n+row.rssKiB,0),processes};
}
export function startProcessMetrics(root){
 const started=Date.now(),marks=[];let pending,peak=null,samples=0,failures=0,stopped=false;
 const sample=()=>{
  if(pending)return pending;
  pending=(async()=>{
   try{
    const request=execute('ps',['-axo','pid=,ppid=,rss=,comm='],{maxBuffer:4*1024*1024,timeout:2000});
    const {stdout}=await request;
    const value={elapsedMs:Date.now()-started,...summarizeProcessTree(stdout,root,[request.child?.pid])};samples++;
    if(value.rootPresent&&(!peak||value.totalRssKiB>peak.totalRssKiB))peak=value;
    return value;
   }catch{failures++;return null;}
   finally{pending=undefined;}
  })();return pending;
 };
 const timer=setInterval(()=>{if(!stopped)void sample();},500);timer.unref();
 return {
  async mark(name){if(stopped)return;marks.push({name,snapshot:await sample()});},
  async stop(){stopped=true;clearInterval(timer);if(pending)await pending;return {
   intervalMs:500,samples,failures,marks,peak,
   caveat:'Sum of per-process RSS, not unique physical memory. Shared pages may be double-counted; short-lived/reparented processes may be missed. Includes only this isolated DSH subtree, not the test UI browser. Mark durations include harness/UI waits, not request-only latency.',
  };},
 };
}
