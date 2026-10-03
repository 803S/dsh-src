import {createHash} from 'node:crypto';
const hash = x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function endpointKey(method,url) {
  const m=String(method).toUpperCase();
  if(!['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE','TRACE','UNKNOWN'].includes(m))throw new Error('endpoint方法非法');
  const u=new URL(url);if(!['http:','https:'].includes(u.protocol))throw new Error('endpoint协议非法');
  return `${m} ${u.origin}${u.pathname}`;
}
export function makeManifest(sessionId,source,endpoints) {
  const unique=new Map();
  for(const endpoint of endpoints) {
    const key=endpointKey(endpoint.method,endpoint.path);
    if(!endpoint.sourceRef)throw new Error('endpoint缺来源引用');
    if(!unique.has(key))unique.set(key,{endpointId:`ep-${hash(key).slice(0,24)}`,method:key.split(' ')[0],path:key.slice(key.indexOf(' ')+1),sourceRef:endpoint.sourceRef,status:'discovered'});
  }
  const rows=[...unique.values()].sort((a,b)=>a.endpointId.localeCompare(b.endpointId));
  return {id:`endpointManifest-${hash([sessionId,source,rows]).slice(0,24)}`,sessionId,source,generatedAt:Date.now(),endpoints:rows};
}
export function computeCoverage(manifest,statuses,evidence,observations) {
  const eps=new Map(manifest.endpoints.map(e=>[e.endpointId,e]));
  const refs=new Map(observations.map(o=>[o.id,o]));
  const matched=new Set();
  for(const id of evidence) {
    const o=refs.get(id);if(!o)throw new Error(`coverage evidence不存在或非HTTP观察: ${id}`);
    if(o.httpStatus>0)try{matched.add(endpointKey(o.method,o.path));}catch{}
  }
  for(const [id,status] of Object.entries(statuses)) {
    const ep=eps.get(id);if(!ep)throw new Error(`endpointId 不属于 manifest: ${id}`);
    if(!['tested','skipped','blocked','not-applicable'].includes(status))throw new Error('endpoint status 非法');
    if(status==='tested'&&!matched.has(endpointKey(ep.method,ep.path)))throw new Error(`tested endpoint 缺少相同方法和路径的真实 observation: ${id}`);
  }
  return {endpointsTotal:eps.size,endpointsTested:Object.values(statuses).filter(s=>s==='tested').length,endpointsSkipped:Object.keys(statuses).filter(k=>statuses[k]==='skipped'),endpointsBlocked:Object.values(statuses).filter(s=>s==='blocked').length,endpointsNotApplicable:Object.values(statuses).filter(s=>s==='not-applicable').length};
}
