// A committed coverage row is authoritative for both identity and computed fields.
export function applyCommittedCoverage(rows, record) {
  const sameKey = row => (row.assetId ?? '') === (record.assetId ?? '') && row.phase === record.phase && row.category === record.category;
  const next = rows.filter(row => row.id !== record.id && !sameKey(row));
  return [...next, record];
}
