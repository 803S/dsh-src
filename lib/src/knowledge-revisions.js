export const KNOWLEDGE_TABLES = {fact:'facts',research:'research',note:'domain_notes'};
export function isSuperseded(revisions,sessionId,id) {
  return revisions.some(row=>row.sourceSessionId===sessionId&&row.recordId===id);
}
