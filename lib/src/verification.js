import {createHash} from 'node:crypto';
export function findingFingerprint(finding) {
  const fields=['title','severity','description','impact','victimImpact','affectedScope','pocEvidence','rawRequest','rawResponse','attackPrerequisites','concreteLossEvidence'];
  return createHash('sha256').update(JSON.stringify(fields.map(key=>[key,finding[key] ?? null]))).digest('hex');
}
export function verificationOf(data,finding) {
  const rows=(data.research??[]).filter(r=>r.findingId===finding.id&&r.status==='verified');
  const valid=rows.find(r=>r.verifierSessionId && r.verifierSessionId!==finding.sessionId && r.findingFingerprint===findingFingerprint(finding) && (data.checkpoints??[]).some(c=>c.childSessionId===r.verifierSessionId&&c.intentId===r.intentId&&c.stage==='completed'));
  return {independent:!!valid,source:valid?.verifierSessionId ?? '',selfClaim:rows.length>0};
}
