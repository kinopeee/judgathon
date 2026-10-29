import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir, sampleVideo } from './helpers.js';
import { cmdRun } from '../src/cli/run.js';
import { sha256File } from '../src/core/storage.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ROLES = ['transcriber', 'evidence_extractor', 'judge'] as const;

interface PromptSnapshot {
  path: string;
  version: string;
  sha256: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/**
 * §41 implementation-contract conformance. Each test pins a MUST-level
 * artifact requirement that the fixture pipeline must satisfy.
 */
describe('spec §41 conformance (fixture, no network)', () => {
  let runDir: string;

  beforeAll(async () => {
    const dir = tmpDir('judgathon-spec41-');
    runDir = path.join(dir, 'run');
    // Non-canonical BCP 47 spelling in the config: §41.2 requires the
    // canonicalized value to be the one persisted in the config snapshot.
    const base = await fs.readFile(path.join(ROOT, 'configs/judge-google-v4.yaml'), 'utf8');
    expect(base).toMatch(/^output_language: ja$/m);
    const configPath = path.join(dir, 'config-upper.yaml');
    await fs.writeFile(configPath, base.replace(/^output_language: ja$/m, 'output_language: JA'));
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
  }, 240_000);

  it('S41-01 §41.2: config snapshot stores the canonicalized output_language', async () => {
    const snap = await readJson<{ effective: { output_language: string } }>(
      path.join(runDir, 'config.snapshot.json'),
    );
    expect(snap.effective.output_language).toBe('ja');
  });

  it('S41-02 §41.3: manifest records the Phase 0 pitch segment covering the whole recording', async () => {
    const manifest = await readJson<{
      status: string;
      input: { duration_ms: number };
      segments: Array<{ segment: string; start_ms: number; end_ms: number }>;
    }>(path.join(runDir, 'manifest.json'));
    expect(manifest.status).toBe('completed');
    expect(manifest.input.duration_ms).toBeGreaterThan(0);
    expect(manifest.segments).toStrictEqual([
      { segment: 'pitch', start_ms: 0, end_ms: manifest.input.duration_ms },
    ]);
  });

  it('S41-03 §41.3: manifest records path / version / sha256 of every copied prompt', async () => {
    const manifest = await readJson<{
      prompts: Record<(typeof ROLES)[number], PromptSnapshot>;
      frozen_inputs: { prompt_hashes: Record<(typeof ROLES)[number], string> };
    }>(path.join(runDir, 'manifest.json'));
    const snap = await readJson<{ effective: { prompts: Record<(typeof ROLES)[number], PromptSnapshot> } }>(
      path.join(runDir, 'config.snapshot.json'),
    );
    expect(Object.keys(manifest.prompts).sort()).toStrictEqual([...ROLES].sort());
    for (const role of ROLES) {
      const entry = manifest.prompts[role];
      expect(entry.path).toBe(`prompts/${role}/${entry.version}.md`);
      expect(entry.sha256).toBe(await sha256File(path.join(runDir, entry.path)));
      expect(entry.sha256).toBe(manifest.frozen_inputs.prompt_hashes[role]);
      expect(entry).toStrictEqual(snap.effective.prompts[role]);
    }
  });
});
