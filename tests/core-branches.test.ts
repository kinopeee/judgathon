import { describe, it, expect, vi } from 'vitest';
import {
  validateEvidenceOutput,
  validateScoreOutput,
  validateTranscriptOutput,
} from '../src/core/reference-validation.js';
import { callWithAttempts, FailedAttemptError, type RawAttemptBody } from '../src/core/retry.js';
import { CliError, ProviderError } from '../src/core/errors.js';
import { TEST_RUBRIC, scoreOutput } from './helpers.js';
import type { ProviderCallResult } from '../src/providers/types.js';

// §43: branch coverage for the core reference-validation and retry modules.

const SCORE_CTX = {
  rubric: TEST_RUBRIC,
  evidenceIds: new Set(['ev_x', 'ev_claim']),
  transcriptIds: new Set(['tr_0']),
  selectedFrameIds: new Set(['frame_sel']),
  observationGradeIds: new Set(['ev_x']),
};

const EVIDENCE_CTX = {
  transcriptIds: new Set(['tr_0']),
  inputFrameIds: new Set(['frame_0']),
  criterionIds: new Set(['alpha', 'beta']),
};

function codes(res: { ok: true } | { ok: false; errors: Array<{ code: string }> }): string[] {
  return res.ok ? [] : res.errors.map((e) => e.code);
}

function messages(res: { ok: true } | { ok: false; errors: Array<{ message: string }> }): string[] {
  return res.ok ? [] : res.errors.map((e) => e.message);
}

describe('validateTranscriptOutput branches', () => {
  it('rejects start_ms >= end_ms (zero-length segment)', () => {
    const res = validateTranscriptOutput(
      { language: 'en', segments: [{ start_ms: 10, end_ms: 10, text: 'a' }] },
      1000,
    );
    expect(codes(res)).toEqual(['PROVIDER_OUTPUT_INVALID']);
    expect(messages(res)[0]).toContain('start_ms (10) must be < end_ms (10)');
  });
});

describe('validateEvidenceOutput branches', () => {
  it('schema violation -> SCHEMA_VIOLATION (empty sources)', () => {
    const res = validateEvidenceOutput(
      {
        evidence: [{ kind: 'claim', description: 'd', sources: [], criterion_hints: [] }],
        injection_suspected: false,
      },
      EVIDENCE_CTX,
    );
    expect(res.ok).toBe(false);
    expect(new Set(codes(res))).toEqual(new Set(['SCHEMA_VIOLATION']));
  });

  it('unknown frame id -> INVALID_REFERENCE; known frame id satisfies observation', () => {
    const res = validateEvidenceOutput(
      {
        evidence: [
          {
            kind: 'observation',
            description: 'unknown frame',
            sources: [{ type: 'frame', id: 'frame_nope' }],
            criterion_hints: ['alpha'],
          },
          {
            kind: 'observation',
            description: 'known frame',
            sources: [
              { type: 'transcript', id: 'tr_0' },
              { type: 'frame', id: 'frame_0' },
            ],
            criterion_hints: ['beta'],
          },
        ],
        injection_suspected: false,
      },
      EVIDENCE_CTX,
    );
    expect(codes(res)).toEqual(['INVALID_REFERENCE']);
    expect(messages(res)[0]).toBe("evidence[0] references unknown frame id 'frame_nope'");
  });
});

describe('validateScoreOutput branches', () => {
  it('non-object raw input (null) -> schema violation, no INVALID_LEVEL', () => {
    const res = validateScoreOutput(null, SCORE_CTX);
    expect(res.ok).toBe(false);
    expect(new Set(codes(res))).toEqual(new Set(['SCHEMA_VIOLATION']));
  });

  it('criteria not an array -> schema violation, no INVALID_LEVEL', () => {
    const res = validateScoreOutput({ ...scoreOutput([3, 3]), criteria: 'x' }, SCORE_CTX);
    expect(res.ok).toBe(false);
    expect(new Set(codes(res))).toEqual(new Set(['SCHEMA_VIOLATION']));
  });

  it('non-object criteria entries are skipped by the level check', () => {
    const res = validateScoreOutput({ ...scoreOutput([3, 3]), criteria: [1, null] }, SCORE_CTX);
    expect(res.ok).toBe(false);
    expect(new Set(codes(res))).toEqual(new Set(['SCHEMA_VIOLATION']));
  });

  it('extra criterion -> CRITERIA_MISMATCH', () => {
    const out = scoreOutput([3, 3]);
    out.criteria.push({ ...out.criteria[0]!, criterion_id: 'gamma' });
    const res = validateScoreOutput(out, SCORE_CTX);
    expect(codes(res)).toEqual(['CRITERIA_MISMATCH']);
    expect(messages(res)).toEqual(["extra criterion 'gamma'"]);
  });

  it('valid null-level criterion (strength none, no evidence) is accepted', () => {
    const res = validateScoreOutput(scoreOutput([null, 3]), SCORE_CTX);
    expect(res.ok).toBe(true);
  });

  it('null level with strength none but non-empty evidence_ids -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([null, 3]);
    out.criteria[0]!.evidence_ids = ['ev_x'];
    const res = validateScoreOutput(out, SCORE_CTX);
    expect(codes(res)).toEqual(['INVALID_EVIDENCE_STATE']);
    expect(messages(res)[0]).toContain("criterion 'alpha': level null requires");
  });

  it("non-null level with evidence_strength 'none' -> INVALID_EVIDENCE_STATE", () => {
    const out = scoreOutput([3, 3]);
    out.criteria[0]!.evidence_strength = 'none';
    const res = validateScoreOutput(out, SCORE_CTX);
    expect(codes(res)).toEqual(['INVALID_EVIDENCE_STATE']);
    expect(messages(res)[0]).toContain('non-null level requires evidence_strength strong|partial');
  });

  it('non-null level with empty evidence_ids -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([3, 3]);
    out.criteria[0]!.evidence_strength = 'partial';
    out.criteria[0]!.evidence_ids = [];
    const res = validateScoreOutput(out, SCORE_CTX);
    expect(codes(res)).toEqual(['INVALID_EVIDENCE_STATE']);
    expect(messages(res)[0]).toContain('requires >=1 distinct evidence_ids');
  });

  it('partial strength with a non-observation ev_* is accepted (no strong check)', () => {
    const out = scoreOutput([3, 3]);
    out.criteria[0]!.evidence_strength = 'partial';
    out.criteria[0]!.evidence_ids = ['ev_claim', 'ev_claim'];
    expect(validateScoreOutput(out, SCORE_CTX).ok).toBe(true);
  });
});

describe('callWithAttempts branches', () => {
  const okResult = (v: unknown): ProviderCallResult<unknown> => ({
    output: v,
    rawText: JSON.stringify(v),
    usage: null,
    latencyMs: 1,
    modelVersion: 'fixture',
    responseId: null,
    effectiveSettings: {},
  });
  const baseCtx = {
    operation: 'judge',
    sampleIndex: 0,
    maxAttempts: 3,
    sleep: async () => {},
    now: () => 1_000,
    saveRaw: async () => 'attempts/x.json',
    stage: 'judge',
  };

  it('saveRaw throwing a non-Error -> INTERNAL_ERROR with stringified message', async () => {
    const err = await callWithAttempts(
      {
        ...baseCtx,
        saveRaw: async () => {
          throw 'disk full';
        },
      },
      async () => okResult(1),
      () => ({ ok: true, value: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailedAttemptError);
    expect(err).toMatchObject({ code: 'INTERNAL_ERROR', message: 'disk full', exitCode: 3, stage: 'judge' });
    expect((err as FailedAttemptError).cause).toBe('disk full');
    expect((err as FailedAttemptError).attempts).toHaveLength(1);
  });

  it('every attempt fails validation -> PROVIDER_OUTPUT_INVALID with model on each record, no sleep', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const saved: RawAttemptBody[] = [];
    const err = await callWithAttempts(
      {
        ...baseCtx,
        model: 'gemini-test',
        sleep,
        saveRaw: async (b) => {
          saved.push(b);
          return `attempts/${b.attempt_index}.json`;
        },
      },
      async () => okResult({ bad: true }),
      () => ({ ok: false, errors: [{ code: 'SCHEMA_VIOLATION', message: 'x: bad' }] }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailedAttemptError);
    expect(err).toMatchObject({
      code: 'PROVIDER_OUTPUT_INVALID',
      message: 'judge: SCHEMA_VIOLATION: x: bad',
      exitCode: 3,
    });
    const attempts = (err as FailedAttemptError).attempts;
    expect(attempts.map((a) => a.status)).toEqual([
      'validation_failed',
      'validation_failed',
      'validation_failed',
    ]);
    expect(attempts.every((a) => a.model === 'gemini-test')).toBe(true);
    expect(attempts.map((a) => a.raw_output_path)).toEqual([
      'attempts/0.json',
      'attempts/1.json',
      'attempts/2.json',
    ]);
    expect(saved.map((b) => b.validation_errors)).toEqual([
      ['SCHEMA_VIOLATION: x: bad'],
      ['SCHEMA_VIOLATION: x: bad'],
      ['SCHEMA_VIOLATION: x: bad'],
    ]);
    // Schema repair re-sends immediately; backoff applies only to comms retries.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('plain CliError from the call propagates with prior attempts, no further attempts', async () => {
    let calls = 0;
    const err = await callWithAttempts(
      baseCtx,
      async () => {
        calls += 1;
        if (calls === 1) return okResult({ bad: true });
        throw new CliError('INJECTED', 'boom', 2, 'judge');
      },
      (p) =>
        (p as { good?: boolean }).good
          ? { ok: true, value: 1 }
          : { ok: false, errors: [{ code: 'SCHEMA_VIOLATION', message: 'bad' }] },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailedAttemptError);
    expect(err).toMatchObject({ code: 'INJECTED', message: 'boom', exitCode: 2, stage: 'judge' });
    expect((err as FailedAttemptError).attempts.map((a) => a.status)).toEqual(['validation_failed']);
    expect(calls).toBe(2);
  });

  it('plain CliError from validate propagates as-is', async () => {
    const err = await callWithAttempts(
      baseCtx,
      async () => okResult(1),
      () => {
        throw new CliError('VALIDATE_FAILED', 'v', 3, 'judge');
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VALIDATE_FAILED', attempts: [] });
  });

  it('non-ProviderError Error -> PROVIDER_OTHER fatal, single attempt', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const err = await callWithAttempts(
      { ...baseCtx, sleep },
      async () => {
        calls += 1;
        throw new TypeError('network glitch');
      },
      () => ({ ok: true, value: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_OTHER', message: 'network glitch', exitCode: 3 });
    const attempts = (err as FailedAttemptError).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'fatal_error',
      error: { code: 'PROVIDER_OTHER', message: 'network glitch' },
    });
    expect(attempts[0]!.possible_double_billing).toBeUndefined();
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('non-Error thrown value -> PROVIDER_OTHER with stringified message', async () => {
    const err = await callWithAttempts(
      baseCtx,
      async () => {
        throw 42;
      },
      () => ({ ok: true, value: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_OTHER', message: '42' });
  });

  it('Retry-After is capped at 30s and the last attempt does not sleep', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const err = await callWithAttempts(
      { ...baseCtx, sleep },
      async () => {
        throw new ProviderError('rate_limited', '429', { httpStatus: 429, retryAfterMs: 45_000 });
      },
      () => ({ ok: true, value: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', message: 'judge: 429' });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([30_000, 30_000]);
  });

  it('maxAttempts 0 -> no call, PROVIDER_OTHER fallback code and message', async () => {
    let calls = 0;
    const err = await callWithAttempts(
      { ...baseCtx, maxAttempts: 0 },
      async () => {
        calls += 1;
        return okResult(1);
      },
      () => ({ ok: true, value: 1 }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailedAttemptError);
    expect(err).toMatchObject({
      code: 'PROVIDER_OTHER',
      message: 'judge: provider call failed',
      exitCode: 3,
      attempts: [],
    });
    expect(calls).toBe(0);
  });
});
