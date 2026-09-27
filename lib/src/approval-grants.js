// One-time human approval grants shared by the user command plane and SRC tools.
// Tokens are process-local, short-lived, scoped to session+approval+action, and never model-generated.
import { randomUUID } from "node:crypto";

const grants = new Map();
export function issueApprovalGrant(sessionId, approvalId, action) {
  const token = randomUUID();
  grants.set(token, { sessionId, approvalId, action, expiresAt: Date.now() + 10 * 60 * 1000 });
  return token;
}
export function consumeApprovalGrant(token, sessionId, approvalId, action) {
  const row = grants.get(String(token ?? ""));
  if (row === void 0 || row.expiresAt < Date.now() || row.sessionId !== sessionId || row.approvalId !== approvalId || row.action !== action) return false;
  grants.delete(String(token));
  return true;
}
export function clearApprovalGrantsForTests() { grants.clear(); }
