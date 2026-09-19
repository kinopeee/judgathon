import { mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import type { Rubric } from '../src/core/schemas/rubric.js';
import type { RawScoreOutput } from '../src/core/schemas/provider-outputs.js';

export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const TEST_RUBRIC: Rubric = {
  id: 'test-rubric-v1',
  language: 'en',
  levels: 5,
  criteria: [
    {
      id: 'alpha',
      name: 'Alpha',
      max_score: 25,
      description: 'alpha criterion',
      include_qa: false,
      anchors: { '1': 'a1', '2': 'a2', '3': 'a3', '4': 'a4', '5': 'a5' },
    },
    {
      id: 'beta',
      name: 'Beta',
      max_score: 15,
      description: 'beta criterion',
      include_qa: true,
      anchors: { '1': 'b1', '2': 'b2', '3': 'b3', '4': 'b4', '5': 'b5' },
    },
  ],
};

export function scoreOutput(levels: Array<number | null>, over?: Partial<RawScoreOutput>): RawScoreOutput {
  return {
    criteria: TEST_RUBRIC.criteria.map((c, i) => {
      const level = levels[i] ?? null;
      return {
        criterion_id: c.id,
        level,
        evidence_strength: level === null ? ('none' as const) : ('strong' as const),
        evidence_ids: level === null ? [] : ['ev_x'],
        reason: level === null ? '' : 'reason',
      };
    }),
    summary: 'summary',
    uncertainties: [],
    injection_suspected: false,
    ...over,
  };
}

let cachedSample: string | null = null;

/** Generate (once) and cache a 60 s synthetic sample video in a tmp dir. */
export function sampleVideo(): string {
  if (cachedSample) return cachedSample;
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  const out = path.join(dir, 'sample.mp4');
  execFileSync('node', ['scripts/make-sample-video.mjs', out], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
  });
  cachedSample = out;
  return out;
}
