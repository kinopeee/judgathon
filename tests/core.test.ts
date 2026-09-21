import { describe, it, expect, vi } from 'vitest';
import { Decimal } from 'decimal.js';
import { levelToScore, normalizedTotal } from '../src/core/scoring.js';
import { aggregateScores, medianLevel } from '../src/core/aggregation.js';
import {
  validateScoreOutput,
  validateTranscriptOutput,
  validateEvidenceOutput,
} from '../src/core/reference-validation.js';
import { callWithAttempts, type AttemptRecord } from '../src/core/retry.js';
import { CliError, ProviderError } from '../src/core/errors.js';
import { dedupeCandidates, capCandidates, selectJudgeFrames } from '../src/core/frame-selection.js';
import { phashFromGray32, hammingDistance } from '../src/media/phash.js';
import { computeRepeatStats, buildRepeatReport } from '../src/core/repeat-report.js';
import { selectAuditSample } from '../src/core/evidence-audit.js';
import { computeInputHash, normalizeReviewFlags } from '../src/core/input-hash.js';
import { TEST_RUBRIC, scoreOutput } from './helpers.js';
import type { ProviderCallResult, Usage } from '../src/providers/types.js';

const CTX = {
  rubric: TEST_RUBRIC,
  evidenceIds: new Set(['ev_x']),
  transcriptIds: new Set(['tr_0']),
  selectedFrameIds: new Set(['frame_sel']),
  evidenceKinds: new Map<string, 'claim' | 'observation' | 'limitation' | 'uncertainty'>([
    ['ev_x', 'observation'],
  ]),
};

describe('scoring (§12.2)', () => {
  it('P0-01 25-point criterion at level 4 -> 18.75', () => {
    expect(levelToScore(4, 25).toString()).toBe('18.75');
  });
  it('P0-02 max_score=25, level=1 -> 0', () => {
    expect(levelToScore(1, 25).toString()).toBe('0');
  });
  it('P0-03 max_score=25, level=5 -> 25', () => {
    expect(levelToScore(5, 25).toString()).toBe('25');
  });
  it('normalized_total = 100*total/sum(max)', () => {
    expect(normalizedTotal(new Decimal(50), new Decimal(200)).toString()).toBe('25');
  });
});

describe('score output validation (§41.5)', () => {
  it('P0-04 level=0 -> INVALID_LEVEL', () => {
    const out = scoreOutput([0 as unknown as number, 4]);
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_LEVEL')).toBe(true);
  });
  it('P0-05 level=6 -> INVALID_LEVEL', () => {
    const out = scoreOutput([6 as unknown as number, 4]);
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_LEVEL')).toBe(true);
  });
  it('P0-06 level=3.5 -> INVALID_LEVEL', () => {
    const out = scoreOutput([3.5 as unknown as number, 4]);
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_LEVEL')).toBe(true);
  });
  it('P0-04b level="4" (string) -> INVALID_LEVEL', () => {
    const out = scoreOutput(['4' as unknown as number, 4]);
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_LEVEL')).toBe(true);
  });
  it('P0-07 missing criterion -> CRITERIA_MISMATCH', () => {
    const out = scoreOutput([4, 4]);
    out.criteria = out.criteria.slice(1);
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'CRITERIA_MISMATCH')).toBe(true);
  });
  it('P0-08 duplicate criterion -> CRITERIA_MISMATCH', () => {
    const out = scoreOutput([4, 4]);
    out.criteria.push({ ...out.criteria[0]! });
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'CRITERIA_MISMATCH')).toBe(true);
  });
  it('P0-09 other-pitch ev_* reference -> INVALID_REFERENCE', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.evidence_ids = ['ev_otherpitch'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_REFERENCE')).toBe(true);
  });
  it('P0-10 unselected frame reference -> INVALID_REFERENCE', () => {
    const out = scoreOutput([4, 4]);
    // frame exists in input_frame_ids but is NOT in selected_frame_ids
    out.criteria[0]!.evidence_ids = ['frame_unselected'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), {
      ...CTX,
      selectedFrameIds: new Set(['frame_sel']),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_REFERENCE')).toBe(true);
  });
  it('P0-11 level=null with strength=strong -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([null, 4]);
    (out.criteria[0] as { evidence_strength: string }).evidence_strength = 'strong';
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_EVIDENCE_STATE')).toBe(true);
  });
  it('non-null level with empty reason -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.reason = '   ';
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_EVIDENCE_STATE')).toBe(true);
  });
  it('strong with an observation ev_* cited -> ok', () => {
    const res = validateScoreOutput(JSON.parse(JSON.stringify(scoreOutput([4, 4]))), CTX);
    expect(res.ok).toBe(true);
  });
  it('strong citing only claim ev_* -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.evidence_ids = ['ev_claim'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), {
      ...CTX,
      evidenceIds: new Set(['ev_x', 'ev_claim']),
      evidenceKinds: new Map([
        ['ev_x', 'observation' as const],
        ['ev_claim', 'claim' as const],
      ]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_EVIDENCE_STATE')).toBe(true);
  });
  it('strong citing only tr_* (no ev_*, no frame cite) -> INVALID_EVIDENCE_STATE', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.evidence_ids = ['tr_0'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.code === 'INVALID_EVIDENCE_STATE')).toBe(true);
  });
  it('strong citing a selected frame_* directly (extractor gap) -> ok', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.evidence_ids = ['tr_0', 'frame_sel'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), CTX);
    expect(res.ok).toBe(true);
  });
  it('partial citing only claim ev_* -> ok (rule applies to strong only)', () => {
    const out = scoreOutput([4, 4]);
    out.criteria[0]!.evidence_strength = 'partial';
    out.criteria[0]!.evidence_ids = ['ev_claim'];
    const res = validateScoreOutput(JSON.parse(JSON.stringify(out)), {
      ...CTX,
      evidenceIds: new Set(['ev_x', 'ev_claim']),
      evidenceKinds: new Map([
        ['ev_x', 'observation' as const],
        ['ev_claim', 'claim' as const],
      ]),
    });
    expect(res.ok).toBe(true);
  });
  it('boundary: undefined/null/empty-string required fields are rejected', () => {
    for (const mut of [
      (o: Record<string, unknown>) => delete o['summary'],
      (o: Record<string, unknown>) => (o['summary'] = null),
      (o: Record<string, unknown>) => (o['injection_suspected'] = 'yes'),
      (o: Record<string, unknown>) => delete o['uncertainties'],
    ]) {
      const out = JSON.parse(JSON.stringify(scoreOutput([4, 4])));
      mut(out);
      expect(validateScoreOutput(out, CTX).ok).toBe(false);
    }
    const blank = scoreOutput([4, 4]);
    blank.criteria[0]!.reason = '';
    expect(validateScoreOutput(JSON.parse(JSON.stringify(blank)), CTX).ok).toBe(false);
  });
});

describe('aggregation (§13)', () => {
  it('P0-12 levels=[4,4,null] -> aggregated 4, sample_insufficient', () => {
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([4, 4]),
      scoreOutput([4, 4]),
      scoreOutput([null, 4]),
    ]);
    const c = res.criteria[0]!;
    expect(c.aggregated_level).toBe('4');
    expect(c.flags.sample_insufficient).toBe(true);
    expect(c.flags.needs_review).toBe(true);
    expect(c.score).toBe('18.75');
  });
  it('P0-13 levels=[2,5,null] -> 3.5 unstable', () => {
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([2, 4]),
      scoreOutput([5, 4]),
      scoreOutput([null, 4]),
    ]);
    const c = res.criteria[0]!;
    expect(c.aggregated_level).toBe('3.5');
    expect(c.flags.unstable).toBe(true);
  });
  it('P0-14 levels=[4,null,null] -> null, needs_review, insufficient_for_all', () => {
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([4, 4]),
      scoreOutput([null, 4]),
      scoreOutput([null, 4]),
    ]);
    const c = res.criteria[0]!;
    expect(c.aggregated_level).toBeNull();
    expect(c.flags.needs_review).toBe(true);
    expect(c.flags.insufficient_for_all).toBe(true);
    expect(c.score).toBe('0');
  });
  it('P0-15 all samples all-null -> total 0 + insufficient', () => {
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([null, null]),
      scoreOutput([null, null]),
      scoreOutput([null, null]),
    ]);
    expect(res.total_score).toBe('0');
    expect(res.insufficient_criteria).toEqual(['alpha', 'beta']);
    expect(res.review_flags).toContain('insufficient_for_all');
  });
  it('extractor injection_suspected ORs into scorecard even when judges are clean', () => {
    const res = aggregateScores(
      TEST_RUBRIC,
      [scoreOutput([4, 4]), scoreOutput([4, 4]), scoreOutput([4, 4])],
      { extraInjectionSuspected: true },
    );
    expect(res.injection_suspected).toBe(true);
    expect(res.review_flags).toContain('injection_suspected');
    expect(res.review_flags).toContain('needs_review');
  });
  it('V02 adds needs_review when one judge sample suspects injection', () => {
    const suspected = scoreOutput([4, 4]);
    suspected.injection_suspected = true;
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([4, 4]),
      suspected,
      scoreOutput([4, 4]),
    ]);
    expect(res.review_flags).toEqual(expect.arrayContaining(['injection_suspected', 'needs_review']));
  });
  it('V03 promotes frame reference overflow to needs_review', () => {
    const res = aggregateScores(
      TEST_RUBRIC,
      [scoreOutput([4, 4]), scoreOutput([4, 4]), scoreOutput([4, 4])],
      { extraReviewFlags: ['frame_reference_overflow'] },
    );
    expect(res.review_flags).toEqual(
      expect.arrayContaining(['frame_reference_overflow', 'needs_review']),
    );
  });
  it('V04 does not promote stable scores without review causes', () => {
    const res = aggregateScores(
      TEST_RUBRIC,
      [scoreOutput([4, 4]), scoreOutput([4, 4]), scoreOutput([4, 4])],
    );
    expect(res.review_flags).not.toContain('needs_review');
  });
  it('unstable via 3 distinct valid values [1,2,3]', () => {
    const res = aggregateScores(TEST_RUBRIC, [
      scoreOutput([1, 4]),
      scoreOutput([2, 4]),
      scoreOutput([3, 4]),
    ]);
    expect(res.criteria[0]!.flags.unstable).toBe(true);
  });
  it('medianLevel boundary cases', () => {
    expect(medianLevel([4, 4])!.toString()).toBe('4');
    expect(medianLevel([2, 5])!.toString()).toBe('3.5');
    expect(medianLevel([2, 2, 4])!.toString()).toBe('2');
    expect(medianLevel([4])).toBeNull();
    expect(medianLevel([])).toBeNull();
  });
});

describe('transcript validation', () => {
  const dur = 60_000;
  it('A01 rejects numeric and string confidence values', () => {
    for (const confidence of [0.9, '0.9']) {
      const res = validateTranscriptOutput(
        { language: 'en', segments: [{ start_ms: 0, end_ms: 1000, text: 'hi', confidence }] },
        dur,
      );
      expect(res.ok).toBe(false);
    }
  });
  it('A02 accepts null and omitted confidence', () => {
    for (const segment of [
      { start_ms: 0, end_ms: 1000, text: 'hi', confidence: null },
      { start_ms: 0, end_ms: 1000, text: 'hi' },
    ]) {
      const res = validateTranscriptOutput({ language: 'en', segments: [segment] }, dur);
      expect(res.ok).toBe(true);
    }
  });
  it('P0-19 missing confidence -> accepted, stays null', () => {
    const res = validateTranscriptOutput(
      { language: 'en', segments: [{ start_ms: 0, end_ms: 1000, text: 'hi', confidence: null }] },
      dur,
    );
    expect(res.ok).toBe(true);
  });
  it('P0-20-adjacent: out-of-range timestamp -> PROVIDER_OUTPUT_INVALID', () => {
    const res = validateTranscriptOutput(
      { language: 'en', segments: [{ start_ms: 0, end_ms: 99999, text: 'x', confidence: null }] },
      dur,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.code).toBe('PROVIDER_OUTPUT_INVALID');
  });
  it('overlapping segments rejected', () => {
    const res = validateTranscriptOutput(
      {
        language: 'en',
        segments: [
          { start_ms: 0, end_ms: 5000, text: 'a', confidence: null },
          { start_ms: 4000, end_ms: 9000, text: 'b', confidence: null },
        ],
      },
      dur,
    );
    expect(res.ok).toBe(false);
  });
});

describe('evidence validation', () => {
  const ctx = {
    transcriptIds: new Set(['tr_0']),
    inputFrameIds: new Set(['frame_0']),
    criterionIds: new Set(['alpha']),
  };
  it('P0-22 visual-only observation is valid with a frame source', () => {
    const res = validateEvidenceOutput(
      {
        evidence: [
          {
            kind: 'observation',
            description: 'A UI is visible',
            sources: [{ type: 'frame', id: 'frame_0' }],
            criterion_hints: ['alpha'],
          },
        ],
        injection_suspected: false,
      },
      ctx,
    );
    expect(res.ok).toBe(true);
  });
  it('observation without frame source is rejected', () => {
    const res = validateEvidenceOutput(
      {
        evidence: [
          {
            kind: 'observation',
            description: 'x',
            sources: [{ type: 'transcript', id: 'tr_0' }],
            criterion_hints: [],
          },
        ],
        injection_suspected: false,
      },
      ctx,
    );
    expect(res.ok).toBe(false);
  });
});

describe('retry (§41.5)', () => {
  const okResult = (v: unknown): ProviderCallResult<unknown> => ({
    output: v,
    rawText: JSON.stringify(v),
    usage: null,
    latencyMs: 1,
    modelVersion: 'fixture',
    responseId: null,
    effectiveSettings: {},
  });
  const saveRaw = async () => 'attempts/x.json';
  const baseCtx = {
    operation: 'judge',
    sampleIndex: 0,
    maxAttempts: 3,
    now: () => Date.now(),
    saveRaw,
    stage: 'judge',
  };

  it('P0-16 three timeouts -> attempts 3, exit-3 error', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      callWithAttempts(
        { ...baseCtx, sleep },
        async () => {
          throw new ProviderError('timeout', 'timed out');
        },
        () => ({ ok: true, value: 1 }),
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });
  it('P0-17 auth 401 -> single attempt, immediate failure', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    await expect(
      callWithAttempts(
        { ...baseCtx, sleep },
        async () => {
          calls += 1;
          throw new ProviderError('auth', 'unauthorized', { httpStatus: 401 });
        },
        () => ({ ok: true, value: 1 }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('P0-18 two schema violations then success -> 3 attempts recorded', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const res = await callWithAttempts(
      { ...baseCtx, sleep },
      async (repair) => {
        calls += 1;
        if (calls === 1) {
          expect(repair).toBeUndefined();
          return okResult({ bad: true });
        }
        if (calls === 2) {
          expect(repair).toContain('failed validation');
          return okResult({ bad: true });
        }
        expect(repair).toContain('failed validation');
        return okResult({ good: true });
      },
      (p) =>
        (p as { good?: boolean }).good
          ? { ok: true, value: 'ok' }
          : { ok: false, errors: [{ code: 'SCHEMA_VIOLATION', message: 'bad shape' }] },
    );
    expect(calls).toBe(3);
    expect(res.attempts.map((a) => a.status)).toEqual([
      'validation_failed',
      'validation_failed',
      'ok',
    ]);
  });
  it('Retry-After is honored up to 30s', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(
      callWithAttempts(
        { ...baseCtx, sleep, maxAttempts: 2 },
        async () => {
          throw new ProviderError('rate_limited', 'slow', { retryAfterMs: 60_000 });
        },
        () => ({ ok: true, value: 1 }),
      ),
    ).rejects.toBeTruthy();
    expect(sleep.mock.calls[0]![0]).toBe(30_000);
  });

  const capture = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    );
  const USAGE: Usage = {
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    total_tokens: 17,
    input_modality_tokens: null,
  };

  it('IO-S1 saveRaw failure on a successful response -> INTERNAL_ERROR, usage kept in attempts', async () => {
    // Given a provider that returns a successful response with usage, and a
    // saveRaw that always fails
    const injected = new Error('attempt save failed');
    const saveRaw = vi.fn(async () => {
      throw injected;
    });
    let calls = 0;
    // When callWithAttempts runs
    const err = await capture(
      callWithAttempts(
        { ...baseCtx, sleep: vi.fn(async () => {}), saveRaw },
        async () => {
          calls += 1;
          return { ...okResult({ good: true }), usage: USAGE };
        },
        () => ({ ok: true, value: 'ok' }),
      ),
    );
    // Then the rejection is an INTERNAL_ERROR CliError carrying the attempts;
    // the billed attempt keeps status 'ok' and its usage
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('INTERNAL_ERROR');
    expect(cliErr.exitCode).toBe(3);
    expect(cliErr.stage).toBe('judge');
    expect(cliErr.message).toBe('attempt save failed');
    expect(cliErr.cause).toBe(injected);
    expect(calls).toBe(1);
    const attempts = (cliErr as unknown as { attempts: AttemptRecord[] }).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('ok');
    expect(attempts[0]!.usage).toEqual(USAGE);
    expect(attempts[0]!.raw_output_path).toBeNull();
  });

  it('IO-S2 saveRaw failure on the error record -> INTERNAL_ERROR, provider error kept, no provider retry', async () => {
    // Given a provider that fails with a retryable error and saveRaw that fails
    const injected = new Error('attempt save failed');
    const saveRaw = vi.fn(async () => {
      throw injected;
    });
    let calls = 0;
    // When callWithAttempts runs
    const err = await capture(
      callWithAttempts(
        { ...baseCtx, sleep: vi.fn(async () => {}), saveRaw },
        async () => {
          calls += 1;
          throw new ProviderError('rate_limited', 'slow');
        },
        () => ({ ok: true, value: 1 }),
      ),
    );
    // Then INTERNAL_ERROR propagates with the provider attempt recorded, and
    // the provider call is not retried (save failure aborts immediately)
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('INTERNAL_ERROR');
    expect(cliErr.exitCode).toBe(3);
    expect(cliErr.cause).toBe(injected);
    expect(calls).toBe(1);
    const attempts = (cliErr as unknown as { attempts: AttemptRecord[] }).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('retryable_error');
    expect(attempts[0]!.error?.code).toBe('PROVIDER_RATE_LIMITED');
    expect(attempts[0]!.usage).toBeNull();
  });

  it('IO-S3 persistent saveRaw failure -> INTERNAL_ERROR, saveRaw called once (no save retry)', async () => {
    // Given saveRaw that fails on every invocation
    const saveRaw = vi.fn(async (): Promise<string> => {
      throw new Error('attempt save failed');
    });
    // When callWithAttempts runs with a healthy provider
    const err = await capture(
      callWithAttempts(
        { ...baseCtx, sleep: vi.fn(async () => {}), saveRaw },
        async () => okResult({ good: true }),
        () => ({ ok: true, value: 1 }),
      ),
    );
    // Then the first save failure aborts immediately without retrying the save
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('INTERNAL_ERROR');
    expect(saveRaw).toHaveBeenCalledTimes(1);
  });

  it('IO-S4 saveRaw failure on a validation_failed response -> INTERNAL_ERROR, record kept', async () => {
    // Given a provider whose output fails schema validation, and saveRaw fails
    const injected = new Error('attempt save failed');
    const saveRaw = vi.fn(async () => {
      throw injected;
    });
    // When callWithAttempts runs
    const err = await capture(
      callWithAttempts(
        { ...baseCtx, sleep: vi.fn(async () => {}), saveRaw },
        async () => ({ ...okResult({ bad: true }), usage: USAGE }),
        () => ({ ok: false, errors: [{ code: 'SCHEMA_VIOLATION', message: 'bad shape' }] }),
      ),
    );
    // Then INTERNAL_ERROR propagates and the attempt keeps status, error code,
    // and usage for usage aggregation
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('INTERNAL_ERROR');
    expect(cliErr.exitCode).toBe(3);
    expect(cliErr.cause).toBe(injected);
    const attempts = (cliErr as unknown as { attempts: AttemptRecord[] }).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('validation_failed');
    expect(attempts[0]!.error?.code).toBe('PROVIDER_OUTPUT_INVALID');
    expect(attempts[0]!.usage).toEqual(USAGE);
  });
});

describe('frame selection (§41.4)', () => {
  const mkFrames = (n: number, phashes?: bigint[]) =>
    Array.from({ length: n }, (_, i) => ({
      frame_id: `frame_${String(i).padStart(3, '0')}`,
      timestamp_ms: i * 1000,
      phash: phashes?.[i] ?? (BigInt(i) * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn,
      source: 'screen',
    }));

  it('dedupes frames with Hamming <= 8 vs last kept', () => {
    const frames = mkFrames(4);
    frames[1]!.phash = frames[0]!.phash; // identical
    frames[2]!.phash = frames[0]!.phash ^ 1n; // distance 1 <= 8
    const kept = dedupeCandidates(frames);
    expect(kept.map((f) => f.frame_id)).toEqual(['frame_000', 'frame_003']);
  });
  it('cap 120: 121 -> 120 evenly spaced', () => {
    const frames = mkFrames(121);
    const capped = capCandidates(frames, 120);
    expect(capped.length).toBe(120);
    expect(capped[0]!.frame_id).toBe('frame_000');
    expect(capped[119]!.frame_id).toBe('frame_120');
  });
  it('P0-29: >24 evidence-referenced frames -> 24 selected, overflow, sources kept', () => {
    const frames = mkFrames(30);
    const evidence = [{ id: 'ev_1', sourceIds: frames.slice(0, 25).map((f) => f.frame_id) }];
    const res = selectJudgeFrames(frames, evidence, 24);
    expect(res.selected_frame_ids.length).toBe(24);
    expect(res.frame_reference_overflow).toBe(true);
    expect(res.unshown_source_ids['ev_1']!.length).toBe(1);
  });
  it('0 frames -> empty selection', () => {
    const res = selectJudgeFrames([], [], 24);
    expect(res.selected_frame_ids).toEqual([]);
    expect(res.input_frame_ids).toEqual([]);
  });
  it('fewer than cap -> all selected', () => {
    const frames = mkFrames(10);
    const res = selectJudgeFrames(frames, [{ id: 'e', sourceIds: ['frame_000'] }], 24);
    expect(res.selected_frame_ids.length).toBe(10);
  });
  it('phash: identical images -> distance 0; different images -> large distance', () => {
    const a = new Uint8Array(1024).fill(128);
    const b = new Uint8Array(1024).map((_, i) => (i % 7) * 30);
    expect(hammingDistance(phashFromGray32(a), phashFromGray32(a))).toBe(0);
    expect(hammingDistance(phashFromGray32(a), phashFromGray32(b))).toBeGreaterThan(8);
  });
});

describe('repeat evaluation (§41.6)', () => {
  it('P0-23 values [3,3,3,3,3] -> mean 3 sigma 0 pass', () => {
    const r = computeRepeatStats(['3', '3', '3', '3', '3']);
    expect(r.mean!.toString()).toBe('3');
    expect(r.sigma!.toString()).toBe('0');
    expect(r.status).toBe('pass');
  });
  it('P0-24 a null value -> na', () => {
    const r = computeRepeatStats(['3', null, '3', '3', '3']);
    expect(r.status).toBe('na');
    expect(r.missing).toBe(1);
  });
  it('P0-30 [1,2,3,4,5] -> mean 3 sigma sqrt(2) fail', () => {
    const r = computeRepeatStats(['1', '2', '3', '4', '5']);
    expect(r.mean!.toString()).toBe('3');
    expect(r.sigma!.toFixed(6)).toBe(new Decimal(2).sqrt().toFixed(6));
    expect(r.status).toBe('fail');
  });
  it('report: not_evaluated when a run fails', () => {
    const report = buildRepeatReport({
      sourceRunId: 'run_x',
      inputHash: 'h',
      mode: 'fixture',
      runs: [],
      criterionIds: ['a'],
      perRunLevels: [new Map([['a', '3']]), null, new Map([['a', '3']]), new Map([['a', '3']]), new Map([['a', '3']])],
    });
    expect(report['status']).toBe('not_evaluated');
    expect(report['note']).toContain('fixture');
  });
});

describe('evidence audit (§41.6)', () => {
  it('deterministic 30-item selection, order-independent', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `ev_${i}`);
    const a = selectAuditSample([...ids].reverse());
    const b = selectAuditSample(ids);
    expect(a).toEqual(b);
    expect(a.length).toBe(30);
  });
});

describe('frozen input hash v2', () => {
  const base = {
    hash_version: 2 as const,
    transcript_sha256: 'a'.repeat(64),
    evidence_set_sha256: 'b'.repeat(64),
    config_snapshot_sha256: 'c'.repeat(64),
    rubric_snapshot_sha256: 'd'.repeat(64),
    selected_frames: [{ frame_id: 'f1', timestamp_ms: 1, sha256: 'e'.repeat(64) }],
    prompt_hashes: {
      transcriber: '1'.repeat(64),
      evidence_extractor: '2'.repeat(64),
      judge: '3'.repeat(64),
    },
    judge_schema_sha256: '4'.repeat(64),
    review_flags_extra: ['z', 'a', 'z'],
  };

  it('is sensitive to selected frame order', () => {
    const swapped = {
      ...base,
      selected_frames: [
        { frame_id: 'f2', timestamp_ms: 2, sha256: 'f'.repeat(64) },
        ...base.selected_frames,
      ],
    };
    expect(computeInputHash(base)).not.toBe(computeInputHash(swapped));
  });

  it('deduplicates and sorts review flags', () => {
    expect(normalizeReviewFlags(['z', 'a', 'z'])).toEqual(['a', 'z']);
    expect(computeInputHash(base)).toBe(
      computeInputHash({ ...base, review_flags_extra: ['a', 'z'] }),
    );
  });

  it('does not include input_hash in the digest', () => {
    expect(computeInputHash(base)).toBe(
      computeInputHash({ ...base, input_hash: 'f'.repeat(64) } as typeof base),
    );
  });
});
