// Replay successful store changes. IDs and field values come from the store, never counters.
import {isDeepStrictEqual} from 'node:util';
import {readableCoverage} from './coverage-projection.js';
import {findingFingerprint} from './verification.js';
const arrays = {assets:'assets',coverage:'coverage',research:'research',checkpoints:'checkpoints',observations:'observations',pending_approvals:'pendingApprovals',user_todos:'userTodos',endpoint_manifests:'endpointManifests',edges:'edges',knowledge_revisions:'knowledgeRevisions'};
const kinds = {intents:'intent',facts:'fact',findings:'finding'};
const json = value => JSON.parse(JSON.stringify(value));
export function applyStoreChanges(state, batch) {
  if (batch.eventSeq && batch.eventSeq <= (state.lastAppliedEventSeq ?? 0)) return state;
  if (batch.baseline) state={...state,nodes:[],counters:{intent:0,fact:0,finding:0,asset:0,edge:0},...Object.fromEntries(Object.values(arrays).map(k=>[k,[]]))};
  let next = {...state, nodes:[...(state.nodes ?? [])], counters:{...state.counters}};
  for (const key of Object.values(arrays)) next[key] = [...(state[key] ?? [])];
  for (const item of batch.deletes ?? []) {
    if (item.table === 'goals') next.goal = null;
    else if (kinds[item.table]) next.nodes = next.nodes.filter(row => !(row.kind === kinds[item.table] && row.id === item.id));
    else if (arrays[item.table]) next[arrays[item.table]] = next[arrays[item.table]].filter(row => row.id !== item.id);
  }
  for (const item of batch.puts ?? []) {
    const row = json(item.row);
    if (item.table === 'goals') { next.goal = row; continue; }
    const kind = kinds[item.table];
    if (kind) {
      const node = {...row,kind,createdAt:row.createdAt ?? batch.createdAt ?? 0};
      if (kind === 'fact') node.factKind = row.kind;
      if (kind === 'finding') {node.steps = row.reproducibleSteps ?? row.steps ?? [];node.fingerprint=findingFingerprint(row);}
      next.nodes = [...next.nodes.filter(r => !(r.kind === kind && r.id === row.id)),node];
    } else if (arrays[item.table]) next[arrays[item.table]] = [...next[arrays[item.table]].filter(r=>r.id!==row.id),row];
  }
  for (const kind of ['intent','fact','finding','asset','edge']) {
    const rows = kind==='asset'?next.assets:kind==='edge'?next.edges:next.nodes.filter(n=>n.kind===kind);
    next.counters[kind] = Math.max(0,...rows.map(r=>Number(/-(\d+)$/.exec(r.id)?.[1] ?? 0)));
  }
  next.lastAppliedEventSeq = batch.eventSeq ?? next.lastAppliedEventSeq ?? 0;
  next.projectionVersion = 17;
  return next;
}
export function compareCommittedRows(events, domain, sessionId) {
  const rows = new Map();
  for (const event of events.filter(e=>e.sessionId===sessionId).sort((a,b)=>a.eventSeq-b.eventSeq)) {
    if(event.payload.baseline) rows.clear();
    for(const item of event.payload.deletes??[]) rows.delete(`${item.table}:${item.key}`);
    for(const item of event.payload.puts??[]) rows.set(`${item.table}:${item.key}`,item);
  }
  const problems=[];
  for(const {table,key,row} of rows.values()) {
    const stored=domain.table(table).get(key),project=value=>table==='coverage'&&value?readableCoverage(value):value;
    if(!isDeepStrictEqual(project(stored),project(row)))problems.push({rule:'commit-store-row',detail:`${table}/${row.id} 与提交日志不一致`});
  }
  return problems;
}

export function stateFromStore(view, initial, eventSeq = 0) {
  const puts = [];
  if (view.goal) puts.push({table:'goals',row:view.goal});
  for (const [table,key] of Object.entries({...arrays,intents:'intents',facts:'facts',findings:'findings'})) {
    for (const row of view[key] ?? []) puts.push({table,row});
  }
  return {...applyStoreChanges(json(initial),{puts,eventSeq}),infra:view.infra ?? {},domainNotes:(view.domainNotes ?? []).map(r=>({...r,content:r.content??'',createdAt:r.createdAt??0})),authBudget:view.authBudget ?? initial.authBudget,testAccounts:view.testAccounts ?? []};
}
