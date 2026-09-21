import type {
  EvidenceOutput,
  RawScoreOutput,
  TranscriptOutput,
} from './schemas/provider-outputs.js';
import {
  evidenceOutputSchema,
  rawScoreOutputSchema,
  transcriptOutputSchema,
} from './schemas/provider-outputs.js';
import type { Rubric } from './schemas/rubric.js';

export interface ValidationIssue {
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationIssue[] };

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ValidationIssue[] {
  return error.issues.map((i) => ({
    code: 'SCHEMA_VIOLATION',
    message: `${i.path.map(String).join('.')}: ${i.message}`,
  }));
}

/**
 * Transcript provider output. 0 <= start < end <= duration_ms, ascending,
 * non-overlapping, non-blank text. Timestamps are never guessed (§41.3).
 */
export function validateTranscriptOutput(
  raw: unknown,
  durationMs: number,
): ValidationResult<TranscriptOutput> {
  const res = transcriptOutputSchema.safeParse(raw);
  if (!res.success) return { ok: false, errors: zodIssues(res.error) };
  const errors: ValidationIssue[] = [];
  let prevEnd = -1;
  res.data.segments.forEach((seg, i) => {
    if (seg.start_ms < 0) {
      errors.push({ code: 'PROVIDER_OUTPUT_INVALID', message: `segments[${i}].start_ms < 0` });
    }
    if (!(seg.start_ms < seg.end_ms)) {
      errors.push({
        code: 'PROVIDER_OUTPUT_INVALID',
        message: `segments[${i}]: start_ms (${seg.start_ms}) must be < end_ms (${seg.end_ms})`,
      });
    }
    if (seg.end_ms > durationMs) {
      errors.push({
        code: 'PROVIDER_OUTPUT_INVALID',
        message: `segments[${i}].end_ms (${seg.end_ms}) exceeds duration_ms (${durationMs})`,
      });
    }
    if (seg.start_ms < prevEnd) {
      errors.push({
        code: 'PROVIDER_OUTPUT_INVALID',
        message: `segments[${i}] overlaps or is out of order`,
      });
    }
    if (seg.text.trim().length === 0) {
      errors.push({ code: 'PROVIDER_OUTPUT_INVALID', message: `segments[${i}].text is blank` });
    }
    prevEnd = Math.max(prevEnd, seg.end_ms);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: res.data };
}

export interface ValidatedEvidence {
  kind: 'claim' | 'observation' | 'limitation' | 'uncertainty';
  description: string;
  sources: Array<{ type: 'transcript' | 'frame'; id: string }>;
  criterion_hints: string[];
}

/**
 * Evidence provider output. Sources: >=1, ids must be in the run's transcript
 * segment ids or input_frame_ids; observation needs >=1 frame source;
 * criterion_hints must be a subset of rubric criterion ids.
 */
export function validateEvidenceOutput(
  raw: unknown,
  ctx: { transcriptIds: ReadonlySet<string>; inputFrameIds: ReadonlySet<string>; criterionIds: ReadonlySet<string> },
): ValidationResult<EvidenceOutput> {
  const res = evidenceOutputSchema.safeParse(raw);
  if (!res.success) return { ok: false, errors: zodIssues(res.error) };
  const errors: ValidationIssue[] = [];
  res.data.evidence.forEach((item, i) => {
    let frameSources = 0;
    for (const src of item.sources) {
      if (src.type === 'transcript') {
        if (!ctx.transcriptIds.has(src.id)) {
          errors.push({
            code: 'INVALID_REFERENCE',
            message: `evidence[${i}] references unknown transcript id '${src.id}'`,
          });
        }
      } else {
        frameSources += 1;
        if (!ctx.inputFrameIds.has(src.id)) {
          errors.push({
            code: 'INVALID_REFERENCE',
            message: `evidence[${i}] references unknown frame id '${src.id}'`,
          });
        }
      }
    }
    if (item.kind === 'observation' && frameSources === 0) {
      errors.push({
        code: 'PROVIDER_OUTPUT_INVALID',
        message: `evidence[${i}] is an observation but has no frame source`,
      });
    }
    for (const hint of item.criterion_hints) {
      if (!ctx.criterionIds.has(hint)) {
        errors.push({
          code: 'INVALID_REFERENCE',
          message: `evidence[${i}] criterion_hint '${hint}' is not a rubric criterion`,
        });
      }
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: res.data };
}

/**
 * Judge RawScoreOutput (§41.5). Criteria must cover the rubric exactly once;
 * level is int 1..5 or null; evidence state consistent; references limited to
 * this run's ev_* ids, tr_* ids and selected_frame_ids (an unselected frame is
 * invalid even if it exists in input_frame_ids). `evidence_strength: strong`
 * additionally requires observation-grade support: at least one cited ev_* of
 * kind 'observation', or a directly cited selected frame_*.
 */
export function validateScoreOutput(
  raw: unknown,
  ctx: {
    rubric: Rubric;
    evidenceIds: ReadonlySet<string>;
    transcriptIds: ReadonlySet<string>;
    selectedFrameIds: ReadonlySet<string>;
    /** evidence id -> kind, for the strong-requires-observation rule (a directly cited selected frame also counts) */
    evidenceKinds: ReadonlyMap<string, ValidatedEvidence['kind']>;
  },
): ValidationResult<RawScoreOutput> {
  const res = rawScoreOutputSchema.safeParse(raw);
  const schemaIssues = res.success ? [] : zodIssues(res.error);
  // Distinguish INVALID_LEVEL from generic schema violations: check each raw
  // criterion entry individually when the overall shape is at least an object
  // with a criteria array.
  const levelErrors: ValidationIssue[] = [];
  const rawObj = raw as Record<string, unknown> | null;
  const rawCriteria = rawObj && Array.isArray(rawObj['criteria']) ? (rawObj['criteria'] as unknown[]) : [];
  rawCriteria.forEach((c, i) => {
    if (c && typeof c === 'object') {
      const lvl = (c as Record<string, unknown>)['level'];
      if (lvl !== null && lvl !== undefined) {
        const bad =
          typeof lvl !== 'number' || !Number.isInteger(lvl) || lvl < 1 || lvl > 5;
        if (bad) {
          levelErrors.push({
            code: 'INVALID_LEVEL',
            message: `criteria[${i}].level must be an integer 1..5 or null (got ${JSON.stringify(lvl)})`,
          });
        }
      }
    }
  });
  if (!res.success) {
    // Report INVALID_LEVEL entries with their dedicated code; everything else
    // is a schema violation.
    const levelIdx = new Set(levelErrors.map((e) => e.message));
    const merged: ValidationIssue[] = [...levelErrors];
    for (const issue of schemaIssues) {
      if (issue.message.includes('level') && levelIdx.size > 0) continue;
      merged.push(issue);
    }
    if (merged.length === 0) merged.push(...schemaIssues);
    return { ok: false, errors: merged };
  }
  const output = res.data;
  const errors: ValidationIssue[] = [];

  const rubricIds = ctx.rubric.criteria.map((c) => c.id);
  const seen = new Set<string>();
  for (const c of output.criteria) {
    if (!rubricIds.includes(c.criterion_id)) {
      errors.push({ code: 'CRITERIA_MISMATCH', message: `extra criterion '${c.criterion_id}'` });
    }
    if (seen.has(c.criterion_id)) {
      errors.push({ code: 'CRITERIA_MISMATCH', message: `duplicate criterion '${c.criterion_id}'` });
    }
    seen.add(c.criterion_id);
  }
  for (const id of rubricIds) {
    if (!seen.has(id)) {
      errors.push({ code: 'CRITERIA_MISMATCH', message: `missing criterion '${id}'` });
    }
  }

  const allowedRefs = new Set<string>([
    ...ctx.evidenceIds,
    ...ctx.transcriptIds,
    ...ctx.selectedFrameIds,
  ]);

  for (const c of output.criteria) {
    const dedup = new Set(c.evidence_ids);
    if (c.level === null) {
      if (c.evidence_strength !== 'none' || dedup.size > 0) {
        errors.push({
          code: 'INVALID_EVIDENCE_STATE',
          message: `criterion '${c.criterion_id}': level null requires evidence_strength 'none' and empty evidence_ids`,
        });
      }
    } else {
      if (c.evidence_strength === 'none') {
        errors.push({
          code: 'INVALID_EVIDENCE_STATE',
          message: `criterion '${c.criterion_id}': non-null level requires evidence_strength strong|partial`,
        });
      }
      if (c.reason.trim().length === 0) {
        errors.push({
          code: 'INVALID_EVIDENCE_STATE',
          message: `criterion '${c.criterion_id}': non-null level requires a non-empty reason`,
        });
      }
      if (dedup.size === 0) {
        errors.push({
          code: 'INVALID_EVIDENCE_STATE',
          message: `criterion '${c.criterion_id}': non-null level requires >=1 distinct evidence_ids`,
        });
      }
      if (
        c.evidence_strength === 'strong' &&
        ![...dedup].some(
          (id) => ctx.evidenceKinds.get(id) === 'observation' || ctx.selectedFrameIds.has(id),
        )
      ) {
        errors.push({
          code: 'INVALID_EVIDENCE_STATE',
          message: `criterion '${c.criterion_id}': evidence_strength 'strong' requires at least one cited ev_* with kind 'observation' or a directly cited selected frame_*`,
        });
      }
    }
    for (const id of dedup) {
      if (!allowedRefs.has(id)) {
        errors.push({
          code: 'INVALID_REFERENCE',
          message: `criterion '${c.criterion_id}' references id '${id}' not in this run's evidence/transcript/selected-frame sets`,
        });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: output };
}
