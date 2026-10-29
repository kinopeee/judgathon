import { describe, it, expect } from 'vitest';
import { buildEvidenceAuditArtifact, selectAuditSample } from '../src/core/evidence-audit.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `ev_${String(i).padStart(3, '0')}`);

describe('buildEvidenceAuditArtifact (§41.6)', () => {
  it('count 0: status na, reference_only false', () => {
    const a = buildEvidenceAuditArtifact([]);
    expect(a).toEqual({
      schema_version: 1,
      seed: 'evidence-audit-v1',
      selected_ids: [],
      total: 0,
      status: 'na',
      reference_only: false,
      reviews: [],
    });
  });

  it.each([1, 29])('count %i: reference_only true, status pending_human_review', (n) => {
    const a = buildEvidenceAuditArtifact(ids(n));
    expect(a.total).toBe(n);
    expect(a.status).toBe('pending_human_review');
    expect(a.reference_only).toBe(true);
    expect(a.selected_ids).toHaveLength(n);
  });

  it.each([30, 45])('count %i: reference_only false, status pending_human_review', (n) => {
    const a = buildEvidenceAuditArtifact(ids(n));
    expect(a.total).toBe(n);
    expect(a.status).toBe('pending_human_review');
    expect(a.reference_only).toBe(false);
    expect(a.selected_ids).toEqual(selectAuditSample(ids(n)));
    expect(a.selected_ids).toHaveLength(30);
  });
});
