// Global user-only SRC domain data control plane.
// It deliberately registers commands, not model tools, so it is available for
// cold/history sessions even when the src-hunter preset is not currently mounted.
import { promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { srcDomainSpec, sharedDomainOpens, appendSessionToolEvent } from "./src.js";
import { registerDomainDataCommands } from "./src/domain-data.js";
import { artifactsRoot } from "./src/artifacts.js";
import { dshHomeDir, srcTelemetryDir } from "./src/telemetry/events.js";
import { lessonsDataDir } from "./src/lessons.js";

const name = "src-domain-admin";
const inject = ["commands", "storageDomain"];
const domainPromiseOf = new WeakMap();
function domainOf(ctx) {
  const cached = sharedDomainOpens.get(srcDomainSpec.name);
  if (cached !== void 0) return cached;
  let promise = domainPromiseOf.get(ctx);
  if (promise === void 0) {
    promise = ctx.storageDomain.open(srcDomainSpec);
    sharedDomainOpens.set(srcDomainSpec.name, promise);
    domainPromiseOf.set(ctx, promise);
  }
  return promise;
}
function createAdminStore(ctx) {
  return {
    async domain() { return domainOf(ctx); },
    async listDomainCatalog() {
      const domain = await domainOf(ctx), byTarget = new Map(), sessions = new Map();
      const ensure = (target) => { const key = String(target ?? "").trim(); if (!key) return; if (!byTarget.has(key)) byTarget.set(key, { target: key, sessions: new Set(), notes: 0, assets: 0, findings: 0, research: 0, observations: 0, approvals: 0, todos: 0, infra: 0, surveySeeds: 0, lastUpdated: 0 }); return byTarget.get(key); };
      for (const [, row] of domain.table("goals").entries()) { const item = ensure(row.target); if (item) { item.sessions.add(row.sessionId); sessions.set(row.sessionId, row.target); item.lastUpdated = Math.max(item.lastUpdated, row.createdAt ?? 0); } }
      const notesBySession = new Map();
      for (const [, row] of domain.table("domain_notes").entries()) { const item = ensure(row.target); if (item) { item.notes++; item.sessions.add(row.sessionId); item.lastUpdated = Math.max(item.lastUpdated, row.updatedAt ?? row.createdAt ?? 0); } if (!notesBySession.has(row.sessionId)) notesBySession.set(row.sessionId, new Set()); notesBySession.get(row.sessionId).add(row.target); }
      for (const [sid, targets] of notesBySession) if (!sessions.has(sid) && targets.size === 1) sessions.set(sid, [...targets][0]);
      for (const [table, field] of [["assets","assets"],["findings","findings"],["research","research"],["observations","observations"],["pending_approvals","approvals"],["user_todos","todos"],["infra","infra"],["survey_seeds","surveySeeds"]]) for (const [, row] of domain.table(table).entries()) { const item = ensure(sessions.get(row.sessionId)); if (item) { item[field]++; item.sessions.add(row.sessionId); item.lastUpdated = Math.max(item.lastUpdated, row.updatedAt ?? row.createdAt ?? 0); } }
      return [...byTarget.values()].map((r) => ({ ...r, sessions: r.sessions.size })).sort((a,b) => b.lastUpdated-a.lastUpdated || a.target.localeCompare(b.target));
    },
    async planTargetDeletion(target) {
      const domain = await domainOf(ctx), goals = [...domain.table("goals").entries()].map(([,r])=>r), sessionIds = new Set(goals.filter(r=>r.target===target).map(r=>r.sessionId));
      const notes = [...domain.table("domain_notes").entries()];
      for (const [, row] of notes) if (row.target === target && !notes.some(([,n])=>n.sessionId===row.sessionId && n.target!==target) && !goals.some(g=>g.sessionId===row.sessionId && g.target!==target)) sessionIds.add(row.sessionId);
      const entries=[], credentialRefs=new Set(), approvals=[];
      for (const table of Object.keys(srcDomainSpec.tables)) for (const [key,row] of domain.table(table).entries()) { if (table === "domain_notes" ? row.target!==target : !sessionIds.has(row.sessionId)) continue; entries.push({table,key}); for (const m of JSON.stringify(row).matchAll(/credential:\/\/[a-f0-9]{64}/g)) credentialRefs.add(m[0]); if(table==="pending_approvals") approvals.push({id:row.id,url:row.url,method:row.method}); }
      return { target, tableNames: Object.keys(srcDomainSpec.tables), sessionIds:[...sessionIds], entries, credentialRefs:[...credentialRefs], approvals };
    },
    async deleteTargetData(target, plan) { const domain=await domainOf(ctx), deleted={}; for(const {table,key} of plan.entries){const t=domain.table(table); if(t.get(key)===void 0)continue; await t.delete(key); deleted[table]=(deleted[table]??0)+1;} return deleted; }
  };
}
function safePath(base, file) { const root=path.resolve(base), target=path.resolve(file); return target===root || target.startsWith(root+path.sep); }
async function cleanupFiles(home, plan, store) {
  const counts={artifacts:0,lessons:0,credentials:0,telemetry:0,approvalLocks:0}; const warnings=[];
  for(const sid of plan.sessionIds){const dir=artifactsRoot(sid,{target:plan.target}); if(!safePath(path.join(home,"artifacts"),dir))continue; const readme=await fs.readFile(path.join(dir,"README.md"),"utf8").catch(()=>""); if(readme.includes(`- 会话：${sid}`)){await fs.rm(dir,{recursive:true,force:true});counts.artifacts++;} else if(readme)warnings.push(`产物目录未通过归属校验：${dir}`);}
  const lessons=lessonsDataDir(); for(const file of await fs.readdir(lessons).catch(()=>[])){if(!file.endsWith('.md'))continue;const p=path.join(lessons,file), text=await fs.readFile(p,'utf8').catch(()=>"");const m=/<!-- lesson-meta: (.+?) -->/.exec(text);try{if(m&&plan.sessionIds.includes(JSON.parse(m[1]).sessionId)){await fs.rm(p,{force:true});counts.lessons++;}}catch{}}
  const refs=new Set(), domain=await store.domain(); for(const table of plan.tableNames)for(const[,row]of domain.table(table).entries())for(const m of JSON.stringify(row).matchAll(/credential:\/\/[a-f0-9]{64}/g))refs.add(m[0]); const vault=path.join(home,'storages','src-credentials'); for(const file of await fs.readdir(vault).catch(()=>[])){if(!/^[a-f0-9]{64}\.json$/.test(file))continue;const p=path.join(vault,file),row=JSON.parse(await fs.readFile(p,'utf8'));if(!refs.has(row.ref)&&(plan.credentialRefs.includes(row.ref)||plan.sessionIds.includes(row.sessionId))){await fs.rm(p,{force:true});counts.credentials++;}}
  const lf=path.join(home,'storages','src-approval-locks.json');try{const locks=JSON.parse(await fs.readFile(lf,'utf8'));const keep=locks.filter(l=>!plan.approvals.some(a=>a.id===l.id&&a.url===l.url&&a.method===l.method));counts.approvalLocks=locks.length-keep.length;if(counts.approvalLocks)await fs.writeFile(lf,JSON.stringify(keep,null,2));}catch{}
  const td=srcTelemetryDir();for(const file of await fs.readdir(td).catch(()=>[])){if(!file.endsWith('.jsonl'))continue;const p=path.join(td,file),keep=[];for(const line of (await fs.readFile(p,'utf8')).split('\n')){try{const r=JSON.parse(line);if(plan.sessionIds.includes(r.sessionId)||plan.sessionIds.includes(r.engagementId)){counts.telemetry++;continue;}}catch{}keep.push(line)}await fs.writeFile(p,keep.join('\n'));}
  return {counts,warnings};
}
function apply(ctx) {
  const store=createAdminStore(ctx);
  registerDomainDataCommands(ctx,store,{homeOf:dshHomeDir,closeProofServers:async()=>{},resetProjection:async(sid,target)=>{const s=ctx.get('sessions')?.get(sid);if(s)appendSessionToolEvent(s,'src_domain_data_deleted',{target})}});
}
export default {name,inject,apply};
export {name,inject,apply};
