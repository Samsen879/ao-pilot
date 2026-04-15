import { appendJsonLine, readJsonLines } from './state-storage.js';

export function appendControlPlaneAuditEntry({
  auditPath,
  entry,
} = {}) {
  appendJsonLine(auditPath, entry);
}

export function readControlPlaneAuditEntries({
  auditPath,
  limit = null,
} = {}) {
  const entries = readJsonLines(auditPath);
  if (limit == null) return entries;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('Invalid audit limit');
  }

  return entries.slice(-limit);
}
