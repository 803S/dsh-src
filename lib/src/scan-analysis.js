// Pure response-shape analysis. Dictionary prefixes and error templates are not applications.
export function scanHints(text,status) {
 if(status<200||status>=300)return [];
 return [...new Set([...text.matchAll(/(?:src|href|fetch|axios(?:\.get|\.post)?)[\s=('" ]+([^\s'"<>`)]+)/gi)].map(m=>m[1]).filter(v=>v.startsWith('/')&&!v.startsWith('//')))].slice(0,100);
}
export function surfaceClusters(results) {
 const map=new Map();
 for(const r of results){
  if(!(r.status>=200&&r.status<300)||!/(?:text\/html|application\/json)/i.test(r.contentType??''))continue;
  const prefix='/'+(r.path.split('/').filter(Boolean)[0]??'');
  const row=map.get(prefix)??{prefix,paths:0,hints:0,crossPrefixHints:new Set(),cookieServices:new Set(),types:new Set(),hashes:new Set()};
  row.paths++;row.hints+=r.hints?.length??0;row.types.add(r.contentType.split(';')[0]);if(r.bodySampleSha256)row.hashes.add(r.bodySampleSha256);
  for(const hint of r.hints??[]){const other='/'+hint.split('/').filter(Boolean)[0];if(other!==prefix&&!['/_next','/static','/assets'].includes(other))row.crossPrefixHints.add(other);}
  for(const name of r.cookieNames??[]){const m=/^([a-z][a-z0-9]{1,15})[-_]/i.exec(name);if(m)row.cookieServices.add(m[1].toLowerCase());}
  map.set(prefix,row);
 }
 const rows=[...map.values()],hashes=new Set(rows.flatMap(r=>[...r.hashes]));
 const types=new Set(rows.flatMap(r=>[...r.types])),services=new Set(rows.flatMap(r=>[...r.cookieServices]));
 const supported=rows.filter(r=>r.prefix!=='/').length>=2 && (services.size>=2 || (hashes.size>=2 && (types.size>=2||rows.some(r=>r.crossPrefixHints.size))));
 const clusters=rows.map(r=>({prefix:r.prefix,paths:r.paths,hints:r.hints,...(r.crossPrefixHints.size?{crossPrefixHints:[...r.crossPrefixHints]}:{}),...(r.cookieServices.size?{cookieServices:[...r.cookieServices]}:{})}));
 return {prefixClusters:clusters,...(supported?{multiBackendNote:`同域疑似多后端（待核实）：成功响应具有不同内容/类型及跨前缀或Cookie线索：${clusters.map(r=>`${r.prefix} Cookie=${r.cookieServices?.join(',')||'无'}`).join('；')}。这不是独立应用或新增授权的证明；只核实已授权范围，不自动逐簇扩扫。`}:{})};
}
