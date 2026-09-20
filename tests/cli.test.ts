import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, sampleVideo } from './helpers.js';
import { FixtureJudge, FixtureTranscriber } from '../src/providers/fixture/index.js';
import type { ScoreInput, Usage } from '../src/providers/types.js';
import { cmdRepeat } from '../src/cli/repeat.js';
import { cmdRun } from '../src/cli/run.js';
import * as storage from '../src/core/storage.js';
import { sha256File } from '../src/core/storage.js';
import { CliError, ProviderError } from '../src/core/errors.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli', 'index.js');

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync('node', [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180_000,
  });
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );

let built = false;
beforeAll(() => {
  if (!built) {
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
    built = true;
  }
}, 300_000);

describe('CLI run/repeat (fixture, no network)', () => {
  it('P0-01 run -> completed, manifest.status completed, level4 -> 18.75; repeat -> pass', async () => {
    const dir = await tmpDir('judgathon-e2e-');
    const out = path.join(dir, 'run');
    const video = sampleVideo();
    const res = runCli([
      'run', '--video', video,
      '--rubric', 'rubrics/hackathon-2026-v3.yaml',
      '--config', 'configs/judge-google-v2.yaml',
      '--output-language', 'ja',
      '--provider-mode', 'fixture',
      '--out', out,
    ]);
    expect(res.status, res.stderr).toBe(0);
    const summary = JSON.parse(res.stdout.trim());
    expect(summary.status).toBe('completed');
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('completed');
    const scorecard = JSON.parse(await fs.readFile(path.join(out, 'scorecard.json'), 'utf8'));
    const te = scorecard.criteria.find((c: { criterion_id: string }) => c.criterion_id === 'technical_execution');
    expect(te.score).toBe('18.75');
    expect(te.display_score).toBe('18.75');

    const repOut = path.join(dir, 'repeat');
    const rep = runCli([
      'repeat', '--from', out, '--times', '5', '--provider-mode', 'fixture', '--out', repOut,
    ]);
    expect(rep.status, rep.stderr).toBe(0);
    const report = JSON.parse(await fs.readFile(path.join(repOut, 'repeat-report.json'), 'utf8'));
    expect(report.status).toBe('pass');
    expect(report.criteria.every((c: { sigma: string }) => c.sigma === '0')).toBe(true);
    expect(report.note).toContain('fixture');
    expect(report.runs).toHaveLength(5);
    for (const c of report.criteria) {
      expect(c.values).toHaveLength(5);
      expect(c.missing_count).toBe(0);
    }
  }, 240_000);

  it('P0-20 empty transcript fixture -> NO_TRANSCRIPT exit 5', async () => {
    const dir = await tmpDir('judgathon-e2e-');
    const fx = path.join(dir, 'fx');
    await fs.mkdir(fx, { recursive: true });
    await fs.writeFile(path.join(fx, 'transcript.json'), JSON.stringify({ language: null, segments: [] }));
    await fs.writeFile(path.join(fx, 'evidence.json'), JSON.stringify({ evidence: [], injection_suspected: false }));
    const res = runCli([
      'run', '--video', sampleVideo(),
      '--rubric', 'rubrics/hackathon-2026-v3.yaml',
      '--config', 'configs/judge-google-v2.yaml',
      '--provider-mode', 'fixture', '--fixture-dir', fx,
      '--out', path.join(dir, 'out'),
    ]);
    expect(res.status).toBe(5);
    const summary = JSON.parse(res.stdout.trim());
    expect(summary.error.code).toBe('NO_TRANSCRIPT');
    expect(summary.stage).toBe('transcript');
  }, 240_000);

  it('P0-21 non-empty out dir -> exit 2, files unchanged', async () => {
    const dir = await tmpDir('judgathon-e2e-');
    const out = path.join(dir, 'run');
    await fs.mkdir(out, { recursive: true });
    const marker = path.join(out, 'keep.txt');
    await fs.writeFile(marker, 'do-not-touch');
    const res = runCli([
      'run', '--video', sampleVideo(),
      '--rubric', 'rubrics/hackathon-2026-v3.yaml',
      '--config', 'configs/judge-google-v2.yaml',
      '--provider-mode', 'fixture', '--out', out,
    ]);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout.trim()).error.code).toBe('OUTPUT_DIR_NOT_EMPTY');
    expect(await fs.readFile(marker, 'utf8')).toBe('do-not-touch');
  }, 240_000);

  it('P0-25 language conflict -> CONFIG_LANGUAGE_CONFLICT exit 2', async () => {
    const dir = await tmpDir('judgathon-e2e-');
    const res = runCli([
      'run', '--video', sampleVideo(),
      '--rubric', 'rubrics/hackathon-2026-v3.yaml',
      '--config', 'configs/judge-google-v2.yaml',
      '--output-language', 'en',
      '--provider-mode', 'fixture', '--out', path.join(dir, 'out'),
    ]);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout.trim()).error.code).toBe('CONFIG_LANGUAGE_CONFLICT');
  }, 120_000);

  it('live mode without GOOGLE_API_KEY -> MISSING_CREDENTIALS exit 3, no network', async () => {
    // In-process check: buildProviders throws before any provider/network use.
    const { cmdRun } = await import('../src/cli/run.js');
    const dir = tmpDir('judgathon-e2e-');
    const saved = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    try {
      await expect(
        cmdRun({
          // Any existing file works — the credential check precedes media probing.
          video: path.resolve('package.json'),
          rubricPath: path.resolve('rubrics/hackathon-2026-v3.yaml'),
          configPath: path.resolve('configs/judge-google-v2.yaml'),
          outDir: path.join(dir, 'out'),
          providerMode: 'live',
          fixtureDir: path.resolve('fixtures/default'),
          videoSource: 'screen',
          promptsDir: path.resolve('prompts'),
          pricingPath: path.resolve('configs/pricing.json'),
          log: () => {},
        }),
      ).rejects.toMatchObject({ code: 'MISSING_CREDENTIALS', exitCode: 3 });
    } finally {
      if (saved !== undefined) process.env['GOOGLE_API_KEY'] = saved;
    }
  }, 120_000);

  it('repeat --times != 5 -> exit 2', async () => {
    const res = runCli(['repeat', '--from', 'x', '--times', '3', '--provider-mode', 'fixture', '--out', 'y']);
    expect(res.status).toBe(2);
  });

  it('unknown option -> exit 2 INVALID_ARGS', async () => {
    const res = runCli(['run', '--bogus-option']);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.stdout.trim()).error.code).toBe('INVALID_ARGS');
  });

  it('tampered transcript.json -> repeat exits 2 INPUT_HASH_MISMATCH before writing out dir', async () => {
    const dir = await tmpDir('judgathon-e2e-');
    const out = path.join(dir, 'run');
    const res = runCli([
      'run', '--video', sampleVideo(),
      '--rubric', 'rubrics/hackathon-2026-v3.yaml',
      '--config', 'configs/judge-google-v2.yaml',
      '--provider-mode', 'fixture',
      '--out', out,
    ]);
    expect(res.status, res.stderr).toBe(0);
    // Modify the frozen artifact without touching the manifest.
    const tPath = path.join(out, 'transcript.json');
    const t = JSON.parse(await fs.readFile(tPath, 'utf8'));
    t.segments[0].text = `${t.segments[0].text} tampered`;
    await fs.writeFile(tPath, JSON.stringify(t, null, 2) + '\n');

    const repOut = path.join(dir, 'repeat');
    const rep = runCli([
      'repeat', '--from', out, '--times', '5', '--provider-mode', 'fixture', '--out', repOut,
    ]);
    expect(rep.status).toBe(2);
    expect(JSON.parse(rep.stdout.trim()).error.code).toBe('INPUT_HASH_MISMATCH');
    expect(await fs.stat(repOut).then(() => true).catch(() => false)).toBe(false);
  }, 240_000);
});

describe('CLI launcher', () => {
  it('L01 reports BUILD_REQUIRED when dist is absent', async () => {
    const dir = await tmpDir('judgathon-launcher-missing-');
    const scriptsDir = path.join(dir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    const launcher = path.join(scriptsDir, 'judgathon.mjs');
    await fs.copyFile(path.join(ROOT, 'scripts/judgathon.mjs'), launcher);
    const res = spawnSync('node', [launcher], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr.trim()).toBe(
      'BUILD_REQUIRED: dist/cli/index.js not found. Run `pnpm build` first.',
    );
  });

  it('L02 behaves like the dist entry when invoked directly', () => {
    const launcher = path.join(ROOT, 'scripts/judgathon.mjs');
    const direct = spawnSync('node', [CLI], { cwd: ROOT, encoding: 'utf8' });
    const wrapped = spawnSync('node', [launcher], { cwd: ROOT, encoding: 'utf8' });
    expect(wrapped.status).toBe(direct.status);
    expect(wrapped.stdout).toBe(direct.stdout);
    expect(wrapped.stderr).toBe(direct.stderr);
  });

  it('L03 runs a fixture job through the package bin', async () => {
    const dir = await tmpDir('judgathon-launcher-bin-');
    const res = spawnSync(
      'pnpm',
      [
        'exec',
        'judgathon',
        'run',
        '--video',
        sampleVideo(),
        '--rubric',
        './rubrics/hackathon-2026-v3.yaml',
        '--config',
        './configs/judge-google-v2.yaml',
        '--output-language',
        'ja',
        '--provider-mode',
        'fixture',
        '--out',
        path.join(dir, 'run'),
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 180_000 },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout.trim()).status).toBe('completed');
  }, 240_000);
});

describe('frozen inputs v2', () => {
  let sourceDir: string;
  beforeAll(async () => {
    const dir = tmpDir('judgathon-frozen-');
    sourceDir = path.join(dir, 'run');
    await cmdRun({
      video: sampleVideo(),
      rubricPath: path.join(ROOT, 'rubrics/hackathon-2026-v3.yaml'),
      configPath: path.join(ROOT, 'configs/judge-google-v2.yaml'),
      outDir: sourceDir,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      videoSource: 'screen',
      promptsDir: path.join(ROOT, 'prompts'),
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
  }, 240_000);

  it('A03 persists null ASR confidence for every fixture segment', async () => {
    const transcript = JSON.parse(
      await fs.readFile(path.join(sourceDir, 'transcript.json'), 'utf8'),
    ) as { segments: Array<{ asr_confidence: null }> };
    expect(transcript.segments.length).toBeGreaterThan(0);
    expect(transcript.segments.every((segment) => segment.asr_confidence === null)).toBe(true);
  });

  it('A04 uses the v2 transcription prompt', async () => {
    const prompt = await fs.readFile(
      path.join(sourceDir, 'prompts', 'transcriber', 'transcribe-v2.md'),
      'utf8',
    );
    expect(prompt.toLowerCase()).toContain('null');
    expect(prompt.toLowerCase()).not.toContain('your confidence');
  });

  it('keeps role-specific prompt snapshots when versions are shared', async () => {
    const dir = await tmpDir('judgathon-shared-prompt-');
    const configPath = path.join(dir, 'config.yaml');
    const configText = await fs.readFile(path.join(ROOT, 'configs/judge-google-v2.yaml'), 'utf8');
    await fs.writeFile(
      configPath,
      configText
        .replace('id: judge-google-v2', 'id: judge-google-shared-prompt')
        .replace('prompt_version: absolute-score-v1', 'prompt_version: transcribe-v2'),
    );
    const runDir = path.join(dir, 'run');
    await cmdRun({
      video: sampleVideo(),
      rubricPath: path.join(ROOT, 'rubrics/hackathon-2026-v3.yaml'),
      configPath,
      outDir: runDir,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      videoSource: 'screen',
      promptsDir: path.join(ROOT, 'prompts'),
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
    const snapshot = JSON.parse(
      await fs.readFile(path.join(runDir, 'config.snapshot.json'), 'utf8'),
    ) as {
      effective: {
        prompts: {
          transcriber: { path: string };
          evidence_extractor: { path: string };
          judge: { path: string };
        };
      };
    };
    expect(snapshot.effective.prompts.transcriber.path).toBe('prompts/transcriber/transcribe-v2.md');
    expect(snapshot.effective.prompts.judge.path).toBe('prompts/judge/transcribe-v2.md');
    const transcriberPrompt = await fs.readFile(
      path.join(runDir, snapshot.effective.prompts.transcriber.path),
      'utf8',
    );
    const judgePrompt = await fs.readFile(
      path.join(runDir, snapshot.effective.prompts.judge.path),
      'utf8',
    );
    expect(transcriberPrompt).not.toBe(judgePrompt);

    const repeatDir = path.join(dir, 'repeat');
    const repeat = await cmdRepeat({
      fromDir: runDir,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: repeatDir,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
    expect(repeat.status).toBe('pass');
  });

  it('propagates a usage-write failure after a successful repeat', async () => {
    const out = path.join(tmpDir('judgathon-usage-write-'), 'repeat');
    const writeJsonAtomic = storage.writeJsonAtomic;
    const writeSpy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (filePath.endsWith(path.join('', 'usage.json'))) {
        throw new Error('usage write failed');
      }
      await writeJsonAtomic(filePath, value);
    });
    await expect(cmdRepeat({
      fromDir: sourceDir,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toThrow('usage write failed');
    expect(writeSpy).toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('F01 preserves every judge input across run and repeat', async () => {
    const calls: ScoreInput[] = [];
    const originalScore = FixtureJudge.prototype.score;
    const scoreSpy = vi.spyOn(FixtureJudge.prototype, 'score').mockImplementation(async function (
      this: FixtureJudge,
      input,
    ) {
      calls.push(input);
      return originalScore.call(this, input);
    });
    const runDir = path.join(tmpDir('judgathon-frozen-run-'), 'run');
    await cmdRun({
      video: sampleVideo(),
      rubricPath: path.join(ROOT, 'rubrics/hackathon-2026-v3.yaml'),
      configPath: path.join(ROOT, 'configs/judge-google-v2.yaml'),
      outDir: runDir,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      videoSource: 'screen',
      promptsDir: path.join(ROOT, 'prompts'),
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
    const runCalls = calls.splice(0, calls.length);
    const repeatDir = path.join(tmpDir('judgathon-frozen-repeat-'), 'repeat');
    await cmdRepeat({
      fromDir: runDir,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: repeatDir,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
    const sourceScorecard = JSON.parse(
      await fs.readFile(path.join(runDir, 'scorecard.json'), 'utf8'),
    ) as { review_flags: string[] };
    for (let i = 1; i <= 5; i++) {
      const repeatScorecard = JSON.parse(
        await fs.readFile(path.join(repeatDir, 'runs', String(i).padStart(2, '0'), 'scorecard.json'), 'utf8'),
      ) as { review_flags: string[] };
      expect(repeatScorecard.review_flags).toEqual(sourceScorecard.review_flags);
    }
    expect(runCalls).toHaveLength(3);
    expect(calls).toHaveLength(15);
    for (let i = 0; i < calls.length; i++) {
      const expected = runCalls[i % 3]!;
      const actual = calls[i]!;
      expect(actual.promptText).toBe(expected.promptText);
      expect(actual.rubric).toEqual(expected.rubric);
      expect(actual.evidenceSet).toEqual(expected.evidenceSet);
      expect(actual.transcriptSegments).toEqual(expected.transcriptSegments);
      expect(actual.schema).toEqual(expected.schema);
      expect(actual.frames.map(({ frameId, timestampMs }) => ({ frameId, timestampMs }))).toEqual(
        expected.frames.map(({ frameId, timestampMs }) => ({ frameId, timestampMs })),
      );
      for (let j = 0; j < actual.frames.length; j++) {
        expect(await fs.readFile(actual.frames[j]!.path)).toEqual(await fs.readFile(expected.frames[j]!.path));
      }
    }
    scoreSpy.mockRestore();
  });

  it('F02 rejects evidence missing description before provider calls', async () => {
    const dir = tmpDir('judgathon-frozen-invalid-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const evidencePath = path.join(copy, 'evidence-set.json');
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    delete evidence.evidence[0].description;
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    const out = path.join(dir, 'repeat');
    const spy = vi.spyOn(FixtureJudge.prototype, 'score');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'INPUT_INVALID', exitCode: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it('F03 preserves unshown_source_ids for every repeat judge call', async () => {
    const evidenceSet = JSON.parse(
      await fs.readFile(path.join(sourceDir, 'evidence-set.json'), 'utf8'),
    ) as {
      evidence: Array<{ id: string; sources: Array<{ type: string; id: string }> }>;
      selected_frame_ids: string[];
    };
    const selected = new Set(evidenceSet.selected_frame_ids);
    const expected = evidenceSet.evidence.map((item) => ({
      ...item,
      unshown_source_ids: item.sources
        .filter((source) => source.type === 'frame' && !selected.has(source.id))
        .map((source) => source.id),
    }));
    const calls: ScoreInput[] = [];
    const originalScore = FixtureJudge.prototype.score;
    const spy = vi.spyOn(FixtureJudge.prototype, 'score').mockImplementation(async function (
      this: FixtureJudge,
      input,
    ) {
      calls.push(input);
      return originalScore.call(this, input);
    });
    await cmdRepeat({
      fromDir: sourceDir,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: path.join(tmpDir('judgathon-frozen-unshown-'), 'repeat'),
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    });
    expect(calls).toHaveLength(15);
    for (const call of calls) {
      expect((call.evidenceSet as { evidence: unknown[] }).evidence).toEqual(expected);
    }
    spy.mockRestore();
  });

  it('D04 saves usage before aborting on repeat auth failure', async () => {
    const dir = tmpDir('judgathon-repeat-auth-');
    const out = path.join(dir, 'repeat');
    const originalScore = FixtureJudge.prototype.score;
    let scoreCalls = 0;
    const spy = vi.spyOn(FixtureJudge.prototype, 'score').mockImplementation(async function (
      this: FixtureJudge,
      input,
    ) {
      scoreCalls += 1;
      if (scoreCalls === 4) {
        throw new ProviderError('auth', 'denied', { httpStatus: 401 });
      }
      return originalScore.call(this, input);
    });

    await expect(cmdRepeat({
      fromDir: sourceDir,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'PROVIDER_AUTH', exitCode: 3 });

    const usage = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
      attempts: unknown[];
    };
    expect(usage.attempts).toHaveLength(4);
    expect(scoreCalls).toBe(4);
    expect(await fs.stat(path.join(out, 'runs', '03')).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it.each([1, 3, 5])(
    'IO-P child run %s completion-manifest write failure counts it failed exactly once',
    async (failingIndex) => {
      const idx = String(failingIndex).padStart(2, '0');
      const out = path.join(tmpDir('judgathon-io-p-'), 'repeat');
      const writeJsonAtomic = storage.writeJsonAtomic;
      const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
        if (
          filePath.endsWith(path.join('runs', idx, 'manifest.json')) &&
          (value as { status?: string }).status === 'completed'
        ) {
          throw new Error('child manifest write failed');
        }
        await writeJsonAtomic(filePath, value);
      });
      try {
        const repeat = await cmdRepeat({
          fromDir: sourceDir,
          times: 5,
          providerMode: 'fixture',
          fixtureDir: path.join(ROOT, 'fixtures/default'),
          outDir: out,
          pricingPath: path.join(ROOT, 'configs/pricing.json'),
          log: () => {},
        });
        expect(repeat.status).toBe('not_evaluated');
      } finally {
        spy.mockRestore();
      }
      const report = JSON.parse(await fs.readFile(path.join(out, 'repeat-report.json'), 'utf8')) as {
        runs: Array<{ index: number; status: string }>;
        criteria: Array<{ values: Array<string | null>; missing_count: number; status: string }>;
      };
      expect(report.runs).toHaveLength(5);
      expect(report.runs[failingIndex - 1]!.status).toBe('failed');
      for (const criterion of report.criteria) {
        expect(criterion.values).toHaveLength(5);
        expect(criterion.missing_count).toBe(1);
        expect(criterion.status).toBe('na');
        criterion.values.forEach((value, i) => {
          if (i === failingIndex - 1) expect(value).toBeNull();
          else expect(value).not.toBeNull();
        });
      }
      // The failed child still completed all 3 judge samples before its
      // manifest write failed: usage holds 15 attempts, no re-scoring.
      const usage = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
        attempts: Array<{ operation: string }>;
      };
      expect(usage.attempts).toHaveLength(15);
      expect(usage.attempts.every((a) => a.operation === 'judge')).toBe(true);
      const childManifest = JSON.parse(
        await fs.readFile(path.join(out, 'runs', idx, 'manifest.json'), 'utf8'),
      );
      expect(childManifest.status).toBe('failed');
      expect(childManifest.stage).toBe('judge');
      expect(childManifest.error.code).toBe('INTERNAL_ERROR');
      expect(childManifest.error.message).toBe('child manifest write failed');
    },
  );

  it.each([1, 3, 5])(
    'IO-P7 child run %s completed+failed manifest writes both fail -> failed once, measurement continues',
    async (failingIndex) => {
      // Given a completed-manifest write failure for child run N, AND the
      // failed-manifest write also failing (secondary failure)
      const idx = String(failingIndex).padStart(2, '0');
      const out = path.join(tmpDir('judgathon-io-p7-'), 'repeat');
      const writeJsonAtomic = storage.writeJsonAtomic;
      const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
        const status = (value as { status?: string }).status;
        if (
          filePath.endsWith(path.join('runs', idx, 'manifest.json')) &&
          (status === 'completed' || status === 'failed')
        ) {
          throw new Error(`manifest write failed (${status})`);
        }
        await writeJsonAtomic(filePath, value);
      });
      // When cmdRepeat runs
      try {
        const repeat = await cmdRepeat({
          fromDir: sourceDir,
          times: 5,
          providerMode: 'fixture',
          fixtureDir: path.join(ROOT, 'fixtures/default'),
          outDir: out,
          pricingPath: path.join(ROOT, 'configs/pricing.json'),
          log: () => {},
        });
        // Then the secondary failure does not mask the primary error: the run
        // is recorded failed exactly once and the remaining runs still execute
        expect(repeat.status).toBe('not_evaluated');
      } finally {
        spy.mockRestore();
      }
      const report = JSON.parse(await fs.readFile(path.join(out, 'repeat-report.json'), 'utf8')) as {
        runs: Array<{ index: number; status: string }>;
        criteria: Array<{ values: Array<string | null>; missing_count: number }>;
      };
      expect(report.runs).toHaveLength(5);
      expect(report.runs[failingIndex - 1]!.status).toBe('failed');
      for (const criterion of report.criteria) {
        expect(criterion.values).toHaveLength(5);
        expect(criterion.missing_count).toBe(1);
        expect(criterion.values[failingIndex - 1]).toBeNull();
      }
      // All 5 runs completed their 3 judge samples: usage holds 15 attempts.
      const usage = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
        attempts: Array<{ operation: string }>;
      };
      expect(usage.attempts).toHaveLength(15);
    },
  );

  it('IO-P8 auth failure + failed-manifest write failure keeps PROVIDER_AUTH as the primary error', async () => {
    // Given run 02's first judge call fails with auth, AND the failed-manifest
    // write also fails (secondary failure)
    const dir = tmpDir('judgathon-io-p8-');
    const out = path.join(dir, 'repeat');
    const originalScore = FixtureJudge.prototype.score;
    let scoreCalls = 0;
    const scoreSpy = vi.spyOn(FixtureJudge.prototype, 'score').mockImplementation(async function (
      this: FixtureJudge,
      input,
    ) {
      scoreCalls += 1;
      if (scoreCalls === 4) {
        throw new ProviderError('auth', 'denied', { httpStatus: 401 });
      }
      return originalScore.call(this, input);
    });
    const writeJsonAtomic = storage.writeJsonAtomic;
    const writeSpy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (
        filePath.endsWith(path.join('runs', '02', 'manifest.json')) &&
        (value as { status?: string }).status === 'failed'
      ) {
        throw new Error('failed-manifest write failed');
      }
      await writeJsonAtomic(filePath, value);
    });
    // When cmdRepeat runs
    try {
      // Then the primary auth error propagates, not masked by the save failure
      await expect(
        cmdRepeat({
          fromDir: sourceDir,
          times: 5,
          providerMode: 'fixture',
          fixtureDir: path.join(ROOT, 'fixtures/default'),
          outDir: out,
          pricingPath: path.join(ROOT, 'configs/pricing.json'),
          log: () => {},
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_AUTH', exitCode: 3 });
    } finally {
      scoreSpy.mockRestore();
      writeSpy.mockRestore();
    }
    const usage = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
      attempts: unknown[];
    };
    expect(usage.attempts).toHaveLength(4);
    expect(await fs.stat(path.join(out, 'runs', '03')).then(() => true).catch(() => false)).toBe(false);
  });

  it('IO-P9 initial running-manifest write failure -> INTERNAL_ERROR at judge, aborts before runs/02', async () => {
    // Given the child run 01 initial (status 'running') manifest write fails
    const out = path.join(tmpDir('judgathon-io-p9-'), 'repeat');
    const injected = new Error('initial manifest write failed');
    const writeJsonAtomic = storage.writeJsonAtomic;
    const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (
        filePath.endsWith(path.join('runs', '01', 'manifest.json')) &&
        (value as { status?: string }).status === 'running'
      ) {
        throw injected;
      }
      await writeJsonAtomic(filePath, value);
    });
    // When cmdRepeat runs
    try {
      // Then the raw fs failure is normalized to INTERNAL_ERROR at stage judge
      const err = await rejection(
        cmdRepeat({
          fromDir: sourceDir,
          times: 5,
          providerMode: 'fixture',
          fixtureDir: path.join(ROOT, 'fixtures/default'),
          outDir: out,
          pricingPath: path.join(ROOT, 'configs/pricing.json'),
          log: () => {},
        }),
      );
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.exitCode).toBe(3);
      expect(cliErr.stage).toBe('judge');
      expect(cliErr.cause).toBe(injected);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.stat(path.join(out, 'runs', '02')).then(() => true).catch(() => false)).toBe(false);
  });

  it.each([
    ['H01 rubric max_score', 'rubric.snapshot.json', (value: Record<string, unknown>) => {
      const rubric = value.rubric as { criteria: Array<{ max_score: number }> };
      rubric.criteria[0]!.max_score += 1;
    }, 'INPUT_HASH_MISMATCH'],
    ['H02 rubric anchor', 'rubric.snapshot.json', (value: Record<string, unknown>) => {
      const rubric = value.rubric as { criteria: Array<{ anchors: Record<string, string> }> };
      rubric.criteria[0]!.anchors['1'] += ' changed';
    }, 'INPUT_HASH_MISMATCH'],
    ['H03 config temperature', 'config.snapshot.json', (value: Record<string, unknown>) => {
      const effective = value.effective as { judges: Array<{ temperature: number }> };
      effective.judges[0]!.temperature = 1;
    }, 'INPUT_HASH_MISMATCH'],
    ['H04 config judge model', 'config.snapshot.json', (value: Record<string, unknown>) => {
      const effective = value.effective as { judges: Array<{ model: string }> };
      effective.judges[0]!.model += '-changed';
    }, 'INPUT_HASH_MISMATCH'],
    ['H07 selected frame order', 'evidence-set.json', (value: Record<string, unknown>) => {
      (value.selected_frame_ids as string[]).reverse();
    }, 'INPUT_INVALID'],
    ['H09 judge schema hash', 'manifest.json', (value: Record<string, unknown>) => {
      const frozen = value.frozen_inputs as { judge_schema_sha256: string };
      frozen.judge_schema_sha256 = '0'.repeat(64);
    }, 'INPUT_HASH_MISMATCH'],
  ])('%s rejects tampered bundle before creating output', async (_name, file, mutate, code) => {
    const dir = tmpDir('judgathon-frozen-tamper-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const filePath = path.join(copy, file);
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    mutate(value as Record<string, unknown>);
    await fs.writeFile(filePath, `${JSON.stringify(value)}\n`);
    const out = path.join(dir, 'repeat');
    const spy = vi.spyOn(FixtureJudge.prototype, 'score');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code, exitCode: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it('H05 rejects modified frame bytes', async () => {
    const dir = tmpDir('judgathon-frozen-frame-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(copy, 'manifest.json'), 'utf8'));
    const selectedId = manifest.frozen_inputs.selected_frames[0].frame_id;
    const frame = manifest.media.frames.find((item: { frame_id: string }) => item.frame_id === selectedId);
    await fs.appendFile(path.join(copy, frame.path), Buffer.from([0]));
    const out = path.join(dir, 'repeat');
    const spy = vi.spyOn(FixtureJudge.prototype, 'score');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH', exitCode: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it('H06 rejects modified frame timestamp', async () => {
    const dir = tmpDir('judgathon-frozen-timestamp-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const manifestPath = path.join(copy, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const selectedId = manifest.frozen_inputs.selected_frames[0].frame_id;
    const frame = manifest.media.frames.find((item: { frame_id: string }) => item.frame_id === selectedId);
    frame.timestamp_ms += 1;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const out = path.join(dir, 'repeat');
    const spy = vi.spyOn(FixtureJudge.prototype, 'score');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH', exitCode: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it('H08 rejects modified judge prompt text', async () => {
    const dir = tmpDir('judgathon-frozen-prompt-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const config = JSON.parse(await fs.readFile(path.join(copy, 'config.snapshot.json'), 'utf8'));
    const promptPath = path.join(copy, config.effective.prompts.judge.path);
    await fs.appendFile(promptPath, '\nchanged');
    const out = path.join(dir, 'repeat');
    const spy = vi.spyOn(FixtureJudge.prototype, 'score');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'INPUT_HASH_MISMATCH', exitCode: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    spy.mockRestore();
  });

  it.each([
    ['hash_version=1', (value: Record<string, unknown>) => {
      (value.frozen_inputs as { hash_version: number }).hash_version = 1;
    }],
    ['hash_version absent', (value: Record<string, unknown>) => {
      delete (value.frozen_inputs as Record<string, unknown>).hash_version;
    }],
    ['old frozen format', (value: Record<string, unknown>) => {
      const frozen = value.frozen_inputs as { input_hash: string };
      value.frozen_inputs = { input_hash: frozen.input_hash };
    }],
  ])('H10 %s is unsupported', async (_name, mutate) => {
    const dir = tmpDir('judgathon-frozen-version-');
    const copy = path.join(dir, 'run');
    await fs.cp(sourceDir, copy, { recursive: true });
    const manifestPath = path.join(copy, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    mutate(manifest as Record<string, unknown>);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const sourceBundleFiles = [
      'manifest.json',
      'transcript.json',
      'evidence-set.json',
      'config.snapshot.json',
      'rubric.snapshot.json',
    ];
    const before = await Promise.all(
      sourceBundleFiles.map(async (file) => [file, await sha256File(path.join(copy, file))] as const),
    );
    const out = path.join(dir, 'repeat');
    await expect(cmdRepeat({
      fromDir: copy,
      times: 5,
      providerMode: 'fixture',
      fixtureDir: path.join(ROOT, 'fixtures/default'),
      outDir: out,
      pricingPath: path.join(ROOT, 'configs/pricing.json'),
      log: () => {},
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_FROZEN_INPUT_VERSION', exitCode: 2 });
    expect(await fs.stat(out).then(() => true).catch(() => false)).toBe(false);
    for (const [file, hash] of before) {
      expect(await sha256File(path.join(copy, file))).toBe(hash);
    }
  });
});

describe('run save-failure regression', () => {
  const runOpts = (
    outDir: string,
    fixtureDir = path.join(ROOT, 'fixtures/default'),
  ): Parameters<typeof cmdRun>[0] => ({
    video: sampleVideo(),
    rubricPath: path.join(ROOT, 'rubrics/hackathon-2026-v3.yaml'),
    configPath: path.join(ROOT, 'configs/judge-google-v2.yaml'),
    outDir,
    providerMode: 'fixture',
    fixtureDir,
    videoSource: 'screen',
    promptsDir: path.join(ROOT, 'prompts'),
    pricingPath: path.join(ROOT, 'configs/pricing.json'),
    log: () => {},
  });

  it('IO-R1 usage write failure normalizes to INTERNAL_ERROR and records a failed manifest', async () => {
    const out = path.join(tmpDir('judgathon-io-r1-'), 'run');
    const injected = new Error('usage write failed');
    const writeJsonAtomic = storage.writeJsonAtomic;
    const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (filePath.endsWith('usage.json')) throw injected;
      await writeJsonAtomic(filePath, value);
    });
    try {
      const err = await rejection(cmdRun(runOpts(out)));
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.exitCode).toBe(3);
      expect(cliErr.stage).toBe('internal');
      expect(cliErr.message).toBe('usage write failed');
      expect(cliErr.cause).toBe(injected);
    } finally {
      spy.mockRestore();
    }
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.error.code).toBe('INTERNAL_ERROR');
    expect(manifest.error.message).toBe('usage write failed');
  }, 240_000);

  it('IO-R2 completed-manifest write failure records a failed manifest without completed_at', async () => {
    const out = path.join(tmpDir('judgathon-io-r2-'), 'run');
    const injected = new Error('manifest write failed');
    let injectedDone = false;
    const writeJsonAtomic = storage.writeJsonAtomic;
    const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (
        !injectedDone &&
        filePath.endsWith('manifest.json') &&
        (value as { status?: string }).status === 'completed'
      ) {
        injectedDone = true;
        throw injected;
      }
      await writeJsonAtomic(filePath, value);
    });
    try {
      const err = await rejection(cmdRun(runOpts(out)));
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.exitCode).toBe(3);
      expect(cliErr.cause).toBe(injected);
    } finally {
      spy.mockRestore();
    }
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.error.code).toBe('INTERNAL_ERROR');
    expect(manifest).not.toHaveProperty('completed_at');
  }, 240_000);

  it('IO-R3 existing CliError propagates unchanged and records a failed manifest', async () => {
    const dir = await tmpDir('judgathon-io-r3-');
    const fx = path.join(dir, 'fx');
    await fs.mkdir(fx, { recursive: true });
    await fs.writeFile(path.join(fx, 'transcript.json'), JSON.stringify({ language: null, segments: [] }));
    await fs.writeFile(path.join(fx, 'evidence.json'), JSON.stringify({ evidence: [], injection_suspected: false }));
    const out = path.join(dir, 'run');
    const err = await rejection(cmdRun(runOpts(out, fx)));
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe('NO_TRANSCRIPT');
    expect(cliErr.exitCode).toBe(5);
    expect(cliErr.stage).toBe('transcript');
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.stage).toBe('transcript');
    expect(manifest.error.code).toBe('NO_TRANSCRIPT');
  }, 240_000);

  it('IO-R4 keeps the primary error when the failed-manifest write also fails', async () => {
    const out = path.join(tmpDir('judgathon-io-r4-'), 'run');
    let manifestWrites = 0;
    const writeJsonAtomic = storage.writeJsonAtomic;
    const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (filePath.endsWith('manifest.json')) {
        manifestWrites += 1;
        throw new Error(`manifest write failed #${manifestWrites}`);
      }
      await writeJsonAtomic(filePath, value);
    });
    try {
      const err = await rejection(cmdRun(runOpts(out)));
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.message).toBe('manifest write failed #1');
      expect((cliErr.cause as Error).message).toBe('manifest write failed #1');
    } finally {
      spy.mockRestore();
    }
    expect(manifestWrites).toBe(2);
  }, 240_000);

  it('IO-R6 transcript attempt save failure -> INTERNAL_ERROR, failed manifest at transcript, usage keeps the billed attempt', async () => {
    // Given a transcript response carrying usage, but saving
    // attempts/transcript-a0.json fails
    const out = path.join(tmpDir('judgathon-io-r6-'), 'run');
    const usage: Usage = {
      input_tokens: 100,
      output_tokens: 40,
      thinking_tokens: 10,
      total_tokens: 150,
      input_modality_tokens: null,
    };
    const originalTranscribe = FixtureTranscriber.prototype.transcribe;
    const tSpy = vi.spyOn(FixtureTranscriber.prototype, 'transcribe').mockImplementation(async function (
      this: FixtureTranscriber,
      input,
    ) {
      const res = await originalTranscribe.call(this, input);
      return { ...res, usage };
    });
    const injected = new Error('attempt save failed');
    const writeJsonAtomic = storage.writeJsonAtomic;
    const wSpy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (filePath.endsWith(path.join('attempts', 'transcript-a0.json'))) throw injected;
      await writeJsonAtomic(filePath, value);
    });
    // When cmdRun runs
    try {
      const err = await rejection(cmdRun(runOpts(out)));
      // Then INTERNAL_ERROR carries the save's stage, and the billed attempt is
      // still persisted to usage.json (status 'ok', usage kept)
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.exitCode).toBe(3);
      expect(cliErr.cause).toBe(injected);
    } finally {
      tSpy.mockRestore();
      wSpy.mockRestore();
    }
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.stage).toBe('transcript');
    const usageDoc = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
      attempts: Array<{ operation: string; status: string; usage: unknown }>;
    };
    expect(usageDoc.attempts).toHaveLength(1);
    expect(usageDoc.attempts[0]!.operation).toBe('transcript');
    expect(usageDoc.attempts[0]!.status).toBe('ok');
    expect(usageDoc.attempts[0]!.usage).toEqual(usage);
  }, 240_000);

  it('IO-R5 judge-run write failure records a failed manifest and keeps all attempts in usage', async () => {
    const out = path.join(tmpDir('judgathon-io-r5-'), 'run');
    const injected = new Error('judge-run write failed');
    const writeJsonAtomic = storage.writeJsonAtomic;
    const spy = vi.spyOn(storage, 'writeJsonAtomic').mockImplementation(async (filePath, value) => {
      if (filePath.endsWith('judge-run.json')) throw injected;
      await writeJsonAtomic(filePath, value);
    });
    try {
      const err = await rejection(cmdRun(runOpts(out)));
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INTERNAL_ERROR');
      expect(cliErr.cause).toBe(injected);
    } finally {
      spy.mockRestore();
    }
    const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    const usage = JSON.parse(await fs.readFile(path.join(out, 'usage.json'), 'utf8')) as {
      attempts: Array<{ operation: string }>;
    };
    expect(usage.attempts.map((a) => a.operation)).toEqual([
      'transcript',
      'evidence',
      'judge',
      'judge',
      'judge',
    ]);
  }, 240_000);
});
