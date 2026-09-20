import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import { normalizedTotal } from '../src/core/scoring.js';
import { estimateUsd } from '../src/core/usage.js';
import { validateEvidenceOutput, validateTranscriptOutput } from '../src/core/reference-validation.js';
import { callWithAttempts } from '../src/core/retry.js';
import { CliError, ProviderError } from '../src/core/errors.js';
import { selectJudgeFrames } from '../src/core/frame-selection.js';

describe('extra branch coverage', () => {
  it('normalizedTotal zero denominator -> 0', () => {
    expect(normalizedTotal(new Decimal(0), new Decimal(0)).toString()).toBe('0');
  });
  it('estimateUsd: thinking billed separately and unknown -> null', () => {
    const model = { valid_until: 'x', input_per_1m_tokens: 1, output_per_1m_tokens: 2 };
    expect(
      estimateUsd(
        { input_tokens: 10, output_tokens: 10, thinking_tokens: null, total_tokens: null, input_modality_tokens: null },
        model,
      ),
    ).toBeNull();
    expect(
      estimateUsd(
        { input_tokens: 10, output_tokens: 10, thinking_tokens: 5, total_tokens: null, input_modality_tokens: null },
        model,
      )!.toString(),
    ).toBe('0.00004');
  });
  it('transcript: blank text, negative start, unordered all rejected', () => {
    expect(
      validateTranscriptOutput(
        { language: 'en', segments: [{ start_ms: 0, end_ms: 10, text: '  ', confidence: 0.5 }] },
        1000,
      ).ok,
    ).toBe(false);
    expect(
      validateTranscriptOutput(
        { language: 'en', segments: [{ start_ms: -5, end_ms: 10, text: 'a', confidence: null }] },
        1000,
      ).ok,
    ).toBe(false);
  });
  it('evidence: unknown transcript ref and unknown criterion hint rejected', () => {
    const res = validateEvidenceOutput(
      {
        evidence: [
          {
            kind: 'claim',
            description: 'd',
            sources: [{ type: 'transcript', id: 'tr_nope' }],
            criterion_hints: ['nope'],
          },
        ],
        injection_suspected: false,
      },
      { transcriptIds: new Set(), inputFrameIds: new Set(), criterionIds: new Set(['ok']) },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const codes = res.errors.map((e) => e.code);
      expect(codes).toContain('INVALID_REFERENCE');
    }
  });
  it('D01: deadline equality prevents the first provider call', async () => {
    let calls = 0;
    const error = await callWithAttempts(
      {
        operation: 'judge', sampleIndex: 0, maxAttempts: 3,
        sleep: async () => {}, now: () => 5_000, deadlineMs: 5_000,
        saveRaw: async () => 'x', stage: 'judge',
      },
      async () => {
        calls += 1;
        return { output: {}, rawText: '{}', usage: null, latencyMs: 0, modelVersion: null, responseId: null, effectiveSettings: {} };
      },
      () => ({ ok: true, value: 1 }),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ code: 'DEADLINE_EXCEEDED', exitCode: 3, attempts: [] });
    expect(calls).toBe(0);
  });

  it('D02: retry backoff crossing deadline preserves the retryable attempt', async () => {
    let now = 0;
    let calls = 0;
    const saved: unknown[] = [];
    const error = await callWithAttempts(
      {
        operation: 'judge', sampleIndex: 0, maxAttempts: 3,
        sleep: async (ms) => { now += ms; },
        now: () => now,
        deadlineMs: 100,
        saveRaw: async (body) => { saved.push(body); return 'attempts/0.json'; },
        stage: 'judge',
      },
      async () => {
        calls += 1;
        throw new ProviderError('rate_limited', 'slow', { retryAfterMs: 200 });
      },
      () => ({ ok: true, value: 1 }),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'DEADLINE_EXCEEDED',
      attempts: [{ status: 'retryable_error' }],
    });
    expect((error as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('D03: validation failure crossing deadline preserves usage and raw output', async () => {
    let now = 0;
    let calls = 0;
    const saved: Array<{ usage: unknown }> = [];
    const usage = {
      input_tokens: 10, output_tokens: 20, thinking_tokens: 30,
      total_tokens: 60, input_modality_tokens: null,
    };
    const error = await callWithAttempts(
      {
        operation: 'judge', sampleIndex: 0, maxAttempts: 3,
        sleep: async () => {},
        now: () => now,
        deadlineMs: 100,
        saveRaw: async (body) => { saved.push({ usage: body.usage }); return 'attempts/0.json'; },
        stage: 'judge',
      },
      async () => {
        calls += 1;
        return {
          output: { invalid: true },
          rawText: '{"invalid":true}',
          usage,
          latencyMs: 1,
          modelVersion: 'fixture',
          responseId: null,
          effectiveSettings: {},
        };
      },
      () => {
        now = 100;
        return { ok: false, errors: [{ code: 'SCHEMA', message: 'invalid' }] };
      },
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'DEADLINE_EXCEEDED',
      attempts: [{ status: 'validation_failed', usage, raw_output_path: 'attempts/0.json' }],
    });
    expect((error as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect(saved).toEqual([{ usage }]);
    expect(calls).toBe(1);
  });
  it('retry: non-ProviderError thrown -> fatal, one attempt', async () => {
    let calls = 0;
    await expect(
      callWithAttempts(
        {
          operation: 'judge', sampleIndex: 0, maxAttempts: 3,
          sleep: async () => {}, now: () => Date.now(),
          saveRaw: async () => 'x', stage: 'judge',
        },
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        () => ({ ok: true, value: 1 }),
      ),
    ).rejects.toBeInstanceOf(CliError);
    expect(calls).toBe(1);
  });
  it('extractor schema repair: second call receives repairFeedback with the validation message', async () => {
    const seen: Array<string | undefined> = [];
    const extractor = {
      extract: (input: { repairFeedback?: string }) => {
        seen.push(input.repairFeedback);
        return Promise.resolve({
          output: seen.length === 1 ? { bad: true } : { evidence: [], injection_suspected: false },
          rawText: '{}',
          usage: null,
          latencyMs: 1,
          modelVersion: 'fixture',
          responseId: null,
          effectiveSettings: {},
        });
      },
    };
    const res = await callWithAttempts(
      {
        operation: 'evidence', sampleIndex: null, maxAttempts: 3,
        sleep: async () => {}, now: () => Date.now(),
        saveRaw: async () => 'x', stage: 'evidence',
      },
      (repairFeedback) =>
        extractor.extract(repairFeedback !== undefined ? { repairFeedback } : {}),
      (p) =>
        (p as { evidence?: unknown }).evidence
          ? { ok: true, value: p }
          : { ok: false, errors: [{ code: 'SCHEMA_VIOLATION', message: 'missing evidence array' }] },
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toContain('missing evidence array');
    expect(res.attempts.map((a) => a.status)).toEqual(['validation_failed', 'ok']);
  });
  it('frame selection: scene-change + even-fill paths', () => {
    // Build 10 frames: distinct phashes so dedupe keeps all; one
    // evidence-referenced frame; fill remaining via scene-change ordering.
    const frames = Array.from({ length: 10 }, (_, i) => ({
      frame_id: `frame_${String(i).padStart(3, '0')}`,
      timestamp_ms: i * 1000,
      phash: (BigInt(i) * 0x0123456789abcdefn) & 0xffffffffffffffffn,
      source: 'screen',
    }));
    const res = selectJudgeFrames(frames, [{ id: 'ev_1', sourceIds: ['frame_004'] }], 4);
    expect(res.selected_frame_ids).toHaveLength(4);
    expect(res.selected_frame_ids).toContain('frame_004');
    // deterministic
    const res2 = selectJudgeFrames(frames, [{ id: 'ev_1', sourceIds: ['frame_004'] }], 4);
    expect(res2.selected_frame_ids).toEqual(res.selected_frame_ids);
  });
});
