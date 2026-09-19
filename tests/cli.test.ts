import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, sampleVideo } from './helpers.js';

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
      '--config', 'configs/judge-google-v1.yaml',
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
      '--config', 'configs/judge-google-v1.yaml',
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
      '--config', 'configs/judge-google-v1.yaml',
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
      '--config', 'configs/judge-google-v1.yaml',
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
          configPath: path.resolve('configs/judge-google-v1.yaml'),
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
      '--config', 'configs/judge-google-v1.yaml',
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
