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

export interface EvidenceAuditArtifact {
  schema_version: 1;
  seed: 'evidence-audit-v1';
  selected_ids: string[];
  total: number;
  status: 'na' | 'pending_human_review';
  /** §41.6: true when 1 <= total <= 29 (results are reference-only). */
  reference_only: boolean;
  reviews: [];
}

/** Builds the evidence-audit.json artifact from the population of evidence IDs. */
export function buildEvidenceAuditArtifact(evidenceIds: string[]): EvidenceAuditArtifact {
  const total = evidenceIds.length;
  return {
    schema_version: 1,
    seed: 'evidence-audit-v1',
    selected_ids: selectAuditSample(evidenceIds),
    total,
    status: total === 0 ? 'na' : 'pending_human_review',
    reference_only: total >= 1 && total < 30,
    reviews: [],
  };
}
