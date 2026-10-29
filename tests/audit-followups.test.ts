import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { tmpDir, sampleVideo } from './helpers.js';
import { cmdRun } from '../src/cli/run.js';
import { cmdRepeat } from '../src/cli/repeat.js';
import { buildUsageReport } from '../src/core/usage.js';
import { rubricVersionId } from '../src/core/ids.js';
import { sha256File } from '../src/core/storage.js';
import { validateTranscriptOutput } from '../src/core/reference-validation.js';
import type { AttemptRecord } from '../src/core/retry.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');
const RUBRIC = path.join(ROOT, 'rubrics/hackathon-2026-v3.yaml');

function runCli(args: string[]) {
  return spawnSync('node', [CLI, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

beforeAll(() => {
  execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
}, 300_000);

describe('#4 usage.json prices each attempt with its own model', () => {
  const usage = {
    input_tokens: 1_000_000, output_tokens: 1_000_000, thinking_tokens: 0,
    total_tokens: null, input_modality_tokens: null,
  };
  const attempt = (i: number, operation: string, model: string): AttemptRecord => ({
    attempt_index: i, operation, sample_index: null, model,
    started_at: new Date(0).toISOString(), latency_ms: 1, status: 'ok',
    error: null, validation_errors: [], raw_output_path: null, usage,
  });

  it('mixed-model stages -> per-model cost, model recorded, totals = sum', () => {
    const report = buildUsageReport(
      {
        mode: 'live',
        pricing: null,
        attempts: [attempt(0, 'transcript', 'cheap'), attempt(0, 'evidence', 'mid'), attempt(0, 'judge', 'pricey')],
        model: 'pricey',
      },
      {
        currency: 'USD',
        models: {
          cheap: { valid_until: 'x', input_per_1m_tokens: 1, output_per_1m_tokens: 2 },
          mid: { valid_until: 'x', input_per_1m_tokens: 3, output_per_1m_tokens: 4 },
          pricey: { valid_until: 'x', input_per_1m_tokens: 10, output_per_1m_tokens: 20 },
        },
      },
    );
    expect(report.attempts.map((a) => [a.operation, a.model, a.estimated_usd])).toStrictEqual([
      ['transcript', 'cheap', '3'],
      ['evidence', 'mid', '7'],
      ['judge', 'pricey', '30'],
    ]);
    expect(report.totals.estimated_usd).toBe('40');
    expect(report.totals.known_estimated_usd).toBe('40');
    expect(report.totals.unknown_attempts).toBe(0);
  });

  it('attempt without a model falls back to the report model', () => {
    const legacy = attempt(0, 'judge', 'x');
    delete legacy.model;
    const report = buildUsageReport(
      { mode: 'live', pricing: null, attempts: [legacy], model: 'm' },
      { currency: 'USD', models: { m: { valid_until: 'x', input_per_1m_tokens: 1, output_per_1m_tokens: 1 } } },
    );
    expect(report.attempts[0]!.model).toBe('m');
    expect(report.totals.estimated_usd).toBe('2');
  });

  it('run records each stage model on usage entries; #5 rubric_version_id is id:sha16 in every artifact', async () => {
    const dir = tmpDir('judgathon-usage-model-');
    const cfg = parseYaml(await fs.readFile(path.join(ROOT, 'configs/judge-google-v4.yaml'), 'utf8')) as {
      transcriber: { model: string };
      evidence_extractor: { model: string };
      judges: Array<{ model: string }>;
    };
    cfg.transcriber.model = 'model-transcriber';
    cfg.evidence_extractor.model = 'model-extractor';
    cfg.judges[0]!.model = 'model-judge';
    const configPath = path.join(dir, 'config.yaml');
    await fs.writeFile(configPath, stringifyYaml(cfg));
    const out = path.join(dir, 'run');
    await cmdRun({
      video: sampleVideo(), rubricPath: RUBRIC, configPath, outDir: out,
      providerMode: 'fixture', fixtureDir: path.join(ROOT, 'fixtures/default'),
      videoSource: 'screen', promptsDir: path.join(ROOT, 'prompts'),
      pricingPath: path.join(ROOT, 'configs/pricing.json'), log: () => {},
    });
    const report = await readJson<{ attempts: Array<{ operation: string; model: string }> }>(
      path.join(out, 'usage.json'),
    );
    const byOp = new Map(report.attempts.map((a) => [a.operation, a.model]));
    expect(Object.fromEntries(byOp)).toStrictEqual({
      transcript: 'model-transcriber',
      evidence: 'model-extractor',
      judge: 'model-judge',
    });

    // #5: the same run carries one id:sha16 rubric_version_id everywhere.
    const expected = rubricVersionId('hackathon-2026-v3', await sha256File(RUBRIC));
    expect(expected).toMatch(/^hackathon-2026-v3:[0-9a-f]{16}$/);
    for (const file of ['scorecard.json', 'evidence-set.json', 'rubric.snapshot.json']) {
      const doc = await readJson<{ rubric_version_id: string }>(path.join(out, file));
      expect(doc.rubric_version_id, file).toBe(expected);
    }
    const rep = path.join(dir, 'repeat');
    await cmdRepeat({
      fromDir: out, times: 5, providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'), outDir: rep,
      pricingPath: path.join(ROOT, 'configs/pricing.json'), log: () => {},
    });
    const child = await readJson<{ rubric_version_id: string }>(path.join(rep, 'runs', '01', 'scorecard.json'));
    expect(child.rubric_version_id).toBe(expected);
  }, 240_000);
});

describe('#8 whitespace-only transcript -> NO_TRANSCRIPT', () => {
  it('validator accepts all-blank output but still rejects a blank segment among real ones', () => {
    const blank = { start_ms: 0, end_ms: 1000, text: '  \n\t', confidence: null };
    expect(validateTranscriptOutput({ language: null, segments: [blank, { ...blank, start_ms: 1000, end_ms: 2000, text: '' }] }, 60_000).ok).toBe(true);
    const mixed = validateTranscriptOutput(
      { language: null, segments: [blank, { ...blank, start_ms: 1000, end_ms: 2000, text: 'hello' }] },
      60_000,
    );
    expect(mixed.ok).toBe(false);
  });

  it('CLI exits 5 NO_TRANSCRIPT and the failure JSON carries the issued run_id (#9)', async () => {
    const dir = tmpDir('judgathon-blank-');
    const fx = path.join(dir, 'fx');
    await fs.mkdir(fx, { recursive: true });
    await fs.writeFile(
      path.join(fx, 'transcript.json'),
      JSON.stringify({
        language: null,
        segments: [
          { start_ms: 0, end_ms: 1000, text: '   ', confidence: null },
          { start_ms: 1000, end_ms: 2000, text: '\n', confidence: null },
        ],
      }),
    );
    await fs.writeFile(path.join(fx, 'evidence.json'), JSON.stringify({ evidence: [], injection_suspected: false }));
    const out = path.join(dir, 'out');
    const res = runCli([
      'run', '--video', sampleVideo(), '--rubric', RUBRIC,
      '--config', 'configs/judge-google-v2.yaml',
      '--provider-mode', 'fixture', '--fixture-dir', fx, '--out', out,
    ]);
    expect(res.status, res.stderr).toBe(5);
    const summary = JSON.parse(res.stdout.trim());
    expect(summary.error.code).toBe('NO_TRANSCRIPT');
    expect(summary.stage).toBe('transcript');
    const manifest = await readJson<{ run_id: string; status: string }>(path.join(out, 'manifest.json'));
    expect(manifest.status).toBe('failed');
    expect(summary.run_id).toMatch(/^run_/);
    expect(summary.run_id).toBe(manifest.run_id);
  }, 240_000);
});

describe('#9 failure JSON run_id before issuance', () => {
  it('failure before the run manifest exists keeps run_id: null', async () => {
    const dir = tmpDir('judgathon-noissue-');
    const out = path.join(dir, 'out');
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, 'keep.txt'), 'x');
    const res = runCli([
      'run', '--video', sampleVideo(), '--rubric', RUBRIC,
      '--config', 'configs/judge-google-v2.yaml', '--provider-mode', 'fixture', '--out', out,
    ]);
    expect(res.status).toBe(2);
    const summary = JSON.parse(res.stdout.trim());
    expect(summary.error.code).toBe('OUTPUT_DIR_NOT_EMPTY');
    expect(summary.run_id).toBeNull();
  }, 240_000);
});

describe('#10 repeat rejects --fixture-dir with --provider-mode live', () => {
  it('exits 2 INVALID_ARGS like run', async () => {
    const dir = tmpDir('judgathon-repeat-args-');
    const res = runCli([
      'repeat', '--from', path.join(dir, 'src'), '--times', '5',
      '--provider-mode', 'live', '--fixture-dir', path.join(dir, 'fx'),
      '--out', path.join(dir, 'out'),
    ]);
    expect(res.status).toBe(2);
    const summary = JSON.parse(res.stdout.trim());
    expect(summary.error.code).toBe('INVALID_ARGS');
    expect(summary.error.message).toBe('--fixture-dir is only valid with --provider-mode fixture');
    expect(summary.stage).toBe('validate_input');
  });
});
