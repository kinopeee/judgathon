import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, sampleVideo } from './helpers.js';
import {
  sha256Hex,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic,
  readJsonFile,
  fileExists,
  isAbsentOrEmptyDir,
} from '../src/core/storage.js';
import { newId, newRunId, newFrameId } from '../src/core/ids.js';
import { estimateUsd, buildUsageReport, loadPricing, type PricingTable } from '../src/core/usage.js';
import { validateConfig } from '../src/core/schemas/config.js';
import { validateRubric } from '../src/core/schemas/rubric.js';
import { FixtureTranscriber, FixtureExtractor, FixtureJudge } from '../src/providers/fixture/index.js';
import { extractAudio, extractFrames } from '../src/media/ffmpeg.js';
import { probe } from '../src/media/ffprobe.js';
import type { AttemptRecord } from '../src/core/retry.js';

describe('storage', () => {
  it('atomic JSON write + sha256 roundtrip', async () => {
    const dir = tmpDir('judgathon-st-');
    const p = path.join(dir, 'a.json');
    await writeJsonAtomic(p, { hello: 'world' });
    expect(await readJsonFile(p)).toEqual({ hello: 'world' });
    expect(await fileExists(p)).toBe(true);
    expect(await fileExists(path.join(dir, 'nope'))).toBe(false);
    const sha = await sha256File(p);
    expect(sha).toBe(sha256Hex(await fs.readFile(p)));
    await writeTextAtomic(path.join(dir, 't.txt'), 'text');
    expect(await fs.readFile(path.join(dir, 't.txt'), 'utf8')).toBe('text');
  });
  it('isAbsentOrEmptyDir', async () => {
    const dir = tmpDir('judgathon-st-');
    expect(await isAbsentOrEmptyDir(dir)).toBe(true);
    await fs.writeFile(path.join(dir, 'f'), 'x');
    expect(await isAbsentOrEmptyDir(dir)).toBe(false);
    expect(await isAbsentOrEmptyDir(path.join(dir, 'missing'))).toBe(true);
    expect(await isAbsentOrEmptyDir(path.join(dir, 'f'))).toBe(false);
  });
});

describe('ids', () => {
  it('prefixed unique ids', () => {
    expect(newRunId()).toMatch(/^run_[0-9a-f]{24}$/);
    expect(newFrameId()).toMatch(/^frame_/);
    expect(newId('ev_')).not.toBe(newId('ev_'));
  });
});

describe('usage accounting', () => {
  const table: PricingTable = {
    currency: 'USD',
    models: { m: { valid_until: 'x', input_per_1m_tokens: 1, output_per_1m_tokens: 2, output_includes_thinking: true } },
  };
  it('estimateUsd: known usage -> decimal cost', () => {
    const c = estimateUsd(
      { input_tokens: 1_000_000, output_tokens: 500_000, thinking_tokens: 10, total_tokens: null, input_modality_tokens: null },
      table.models['m'],
    );
    expect(c!.toString()).toBe('2');
  });
  it('estimateUsd: null token count -> null', () => {
    expect(
      estimateUsd(
        { input_tokens: null, output_tokens: 5, thinking_tokens: null, total_tokens: null, input_modality_tokens: null },
        table.models['m'],
      ),
    ).toBeNull();
    expect(estimateUsd(null, table.models['m'])).toBeNull();
  });
  it('buildUsageReport: fixture mode totals null when usage unknown', () => {
    const attempt: AttemptRecord = {
      attempt_index: 0, operation: 'judge', sample_index: 0,
      started_at: new Date(0).toISOString(), latency_ms: 5, status: 'ok',
      error: null, validation_errors: [], raw_output_path: 'attempts/x.json', usage: null,
    };
    const rep = buildUsageReport(
      { mode: 'fixture', pricing: null, attempts: [attempt], model: 'm' },
      table,
    ) as { totals: { estimated_usd: null | string; unknown_attempts: number; known_estimated_usd: string } };
    expect(rep.totals.estimated_usd).toBeNull();
    expect(rep.totals.unknown_attempts).toBe(1);
    expect(rep.totals.known_estimated_usd).toBe('0');
  });
  it('loadPricing reads table and sha', async () => {
    const p = await loadPricing(path.resolve('configs/pricing.json'));
    expect(p.table.models['gemini-3.8-flash']).toBeTruthy();
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any -- test mutators operate on deep clones */
describe('config schema (§41.2)', () => {
  const good = {
    schema_version: 1,
    id: 'cfg',
    output_language: 'ja',
    transcriber: { provider: 'google', model: 'm', prompt_version: 'transcribe-v1', temperature: 0 },
    evidence_extractor: { provider: 'google', model: 'm', prompt_version: 'evidence-v1' },
    judges: [{ id: 'g', provider: 'google', model: 'm', prompt_version: 'absolute-score-v1' }],
    samples_per_judge: 3,
    aggregation: { method: 'median' },
    ranking: { mode: 'absolute_only' },
    frame_selection: { dedupe_phash_distance: 8, max_extraction_frames: 120, max_frames_per_pitch: 24 },
  };
  it('valid config passes', () => {
    const r = validateConfig(JSON.parse(JSON.stringify(good)));
    expect(r.ok).toBe(true);
  });
  it('openai provider -> CONFIG_INVALID (not implemented)', () => {
    const c = JSON.parse(JSON.stringify(good));
    c.judges[0].provider = 'openai';
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('not implemented in Phase 0');
  });
  it.each([
    ['judges=2', (c: any) => c.judges.push({ ...c.judges[0] })],
    ['samples_per_judge=4', (c: any) => (c.samples_per_judge = 4)],
    ['aggregation mean', (c: any) => (c.aggregation.method = 'mean')],
    ['frame_selection 12', (c: any) => (c.frame_selection.max_extraction_frames = 12)],
    ['thinking minimal', (c: any) => (c.judges[0].thinking = 'minimal')],
    ['unknown key', (c: any) => (c.extra = 1)],
    ['temperature 3', (c: any) => (c.transcriber.temperature = 3)],
  ])('rejects %s', (_name, mut) => {
    const c = JSON.parse(JSON.stringify(good));
    mut(c);
    expect(validateConfig(c).ok).toBe(false);
  });
});

describe('rubric schema', () => {
  const crit = (id: string) => ({
    id, name: 'n', max_score: 10, description: 'd', include_qa: false,
    anchors: { '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e' },
  });
  const good = { rubric: { id: 'r', language: 'ja', levels: 5, criteria: [crit('x')] } };
  it('valid rubric passes', () => {
    expect(validateRubric(JSON.parse(JSON.stringify(good))).ok).toBe(true);
  });
  it.each([
    ['duplicate ids', (r: any) => r.rubric.criteria.push(crit('x'))],
    ['blank anchor', (r: any) => (r.rubric.criteria[0].anchors['3'] = '  ')],
    ['max_score 0', (r: any) => (r.rubric.criteria[0].max_score = 0)],
    ['max_score NaN', (r: any) => (r.rubric.criteria[0].max_score = NaN)],
    ['0 criteria', (r: any) => (r.rubric.criteria = [])],
    ['missing include_qa', (r: any) => delete r.rubric.criteria[0].include_qa],
  ])('rejects %s', (_n, mut) => {
    const r = JSON.parse(JSON.stringify(good));
    mut(r);
    expect(validateRubric(r).ok).toBe(false);
  });
});

describe('fixture providers', () => {
  it('substitutes tr#/frame#/ev# placeholders and passes through out-of-range', async () => {
    const dir = tmpDir('judgathon-fx-');
    await fs.writeFile(path.join(dir, 'transcript.json'), JSON.stringify({ language: 'en', segments: [] }));
    const tr = new FixtureTranscriber(dir);
    const tres = await tr.transcribe({ audioPath: 'x', durationMs: 1, promptText: '', schema: {} });
    expect((tres.output as { language: string }).language).toBe('en');
    expect(tres.usage).toBeNull();

    await fs.writeFile(
      path.join(dir, 'evidence.json'),
      JSON.stringify({
        evidence: [
          {
            kind: 'observation',
            description: 'd',
            sources: [
              { type: 'frame', id: 'frame#0' },
              { type: 'frame', id: 'frame#99' },
            ],
            criterion_hints: [],
          },
        ],
        injection_suspected: false,
      }),
    );
    const ex = new FixtureExtractor(dir, () => ['tr_A']);
    const eres = await ex.extract({
      promptText: '', transcriptSegments: [], rubricCriteria: [],
      frames: [{ frameId: 'frame_REAL', timestampMs: 0, path: 'x' }],
      schema: {},
    });
    const item = (eres.output as { evidence: Array<{ sources: Array<{ id: string }> }> }).evidence[0]!;
    expect(item.sources[0]!.id).toBe('frame_REAL');
    expect(item.sources[1]!.id).toBe('frame#99'); // out of range -> unchanged

    await fs.writeFile(path.join(dir, 'judge-sample-0.json'), JSON.stringify({ criteria: [] }));
    const j = new FixtureJudge(dir, () => ['ev_A'], () => ['tr_A'], () => ['frame_A']);
    const jres = await j.score({
      promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [],
      sampleIndex: 0, schema: {},
    });
    expect((jres.output as { criteria: unknown[] }).criteria).toEqual([]);
  });
  it('missing fixture file -> CliError FIXTURE_NOT_FOUND exit 2', async () => {
    const dir = tmpDir('judgathon-fx-');
    const tr = new FixtureTranscriber(dir);
    await expect(
      tr.transcribe({ audioPath: 'x', durationMs: 1, promptText: '', schema: {} }),
    ).rejects.toMatchObject({ code: 'FIXTURE_NOT_FOUND', exitCode: 2 });
  });
  it('invalid JSON fixture -> FIXTURE_INVALID', async () => {
    const dir = tmpDir('judgathon-fx-');
    await fs.writeFile(path.join(dir, 'transcript.json'), '{not json');
    const tr = new FixtureTranscriber(dir);
    await expect(
      tr.transcribe({ audioPath: 'x', durationMs: 1, promptText: '', schema: {} }),
    ).rejects.toMatchObject({ code: 'FIXTURE_INVALID' });
  });
});

describe('ffmpeg integration', () => {
  it('extractAudio + extractFrames on synthetic video', async () => {
    const dir = tmpDir('judgathon-ff-');
    const audio = path.join(dir, 'a.wav');
    await extractAudio(sampleVideo(), audio);
    const st = await fs.stat(audio);
    expect(st.size).toBeGreaterThan(100_000);
    const framesDir = path.join(dir, 'frames');
    await fs.mkdir(framesDir);
    const gray = path.join(dir, 'g.raw');
    const { jpegArgs } = await extractFrames(sampleVideo(), framesDir, gray);
    expect(jpegArgs.join(' ')).toContain('fps=1');
    const jpgs = (await fs.readdir(framesDir)).filter((f) => f.endsWith('.jpg'));
    expect(jpgs.length).toBeGreaterThan(50);
    const grayBuf = await fs.readFile(gray);
    expect(grayBuf.length % 1024).toBe(0);
    // scale sanity: a small input must not be upscaled beyond its size
    const small = path.join(dir, 'small.mp4');
    const { execFileSync } = await import('node:child_process');
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', small,
    ]);
    const fdir2 = path.join(dir, 'f2');
    await fs.mkdir(fdir2);
    await extractFrames(small, fdir2, path.join(dir, 'g2.raw'));
    const jpg2 = (await fs.readdir(fdir2)).filter((f) => f.endsWith('.jpg'))[0]!;
    const dim = await probe(path.join(fdir2, jpg2));
    const v = dim.streams.find((s) => s.codec_type === 'video')!;
    expect(v.width).toBe(640);
    expect(v.height).toBe(360);
  }, 180_000);
});
