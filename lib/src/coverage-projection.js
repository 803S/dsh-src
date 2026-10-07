// A committed coverage row is authoritative for both identity and computed fields.
const endpointStates = new Set(['tested','skipped','blocked','not-applicable']);

// 旧版无manifest写入曾漏校验。只修正读取投影，不改原始数据或把未知状态算成已测。
export function readableCoverage(row) {
  const statuses=row.endpointStatuses;
  if(statuses===undefined)return row;
  const validObject=statuses!==null&&typeof statuses==='object'&&!Array.isArray(statuses);
  const entries=validObject?Object.entries(statuses):[];
  const invalid=entries.filter(([,status])=>!endpointStates.has(status));
  if(validObject&&!invalid.length)return row;
  const tested=entries.filter(([,status])=>status==='tested').length;
  const detail=JSON.stringify(validObject?Object.fromEntries(invalid):statuses).slice(0,500);
  return {...row,status:'blocked',endpointStatuses:Object.fromEntries(entries.map(([key,status])=>[key,endpointStates.has(status)?status:'blocked'])),
    endpointsTested:Math.min(row.endpointsTested??tested,tested),
    endpointsBlocked:entries.filter(([,status])=>status==='blocked'||!endpointStates.has(status)).length,
    limitation:[row.limitation,`历史覆盖状态无效，需重新核对（原值：${detail}）；未计为已测试，原始记录保留。`].filter(Boolean).join('\n')};
}

export function applyCommittedCoverage(rows, record) {
  const sameKey = row => (row.assetId ?? '') === (record.assetId ?? '') && row.phase === record.phase && row.category === record.category;
  const next = rows.filter(row => row.id !== record.id && !sameKey(row));
  return [...next, record];
}
