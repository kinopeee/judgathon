import { sha256Hex } from './storage.js';

/**
 * §41.6 Evidence-audit sampling: sha256('evidence-audit-v1' + id) ascending,
 * ties broken by id, take 30.
 */
export function selectAuditSample(evidenceIds: string[], limit = 30): string[] {
  const keyed = evidenceIds.map((id) => ({ id, key: sha256Hex(`evidence-audit-v1${id}`) }));
  keyed.sort((a, b) => (a.key !== b.key ? (a.key < b.key ? -1 : 1) : a.id < b.id ? -1 : 1));
  return keyed.slice(0, limit).map((k) => k.id);
}
