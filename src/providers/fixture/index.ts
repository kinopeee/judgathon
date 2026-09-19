import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CliError } from '../../core/errors.js';
import type {
  EvidenceExtractor,
  ExtractInput,
  Judge,
  ProviderCallResult,
  ScoreInput,
  Transcriber,
  TranscribeInput,
} from '../types.js';

/**
 * Fixture provider: returns fixed provider-shaped responses from
 * <fixtureDir>/{transcript.json,evidence.json,judge-sample-0..2.json}.
 *
 * Placeholder refs in fixture files are expanded to runtime ids:
 *   tr#<i>    -> transcriptSegments[i].id
 *   frame#<i> -> frames[i].frameId (input_frame_ids order)
 *   ev#<i>    -> validated evidence list index
 * Out-of-range placeholders and literal ids (e.g. ev_otherpitch) pass through
 * unchanged so validation rejects them — negative fixtures are never repaired.
 */

async function readFixture(dir: string, name: string, stage: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, name), 'utf8');
  } catch {
    throw new CliError('FIXTURE_NOT_FOUND', `fixture file ${name} not found in ${dir}`, 2, stage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('FIXTURE_INVALID', `fixture file ${name} is not valid JSON`, 2, stage);
  }
}

function substitute(value: unknown, resolve: (token: string) => string | null): unknown {
  if (typeof value === 'string') {
    const m = /^(tr|frame|ev)#(\d+)$/.exec(value);
    if (m) {
      const resolved = resolve(`${m[1]}#${m[2]}`);
      return resolved ?? value;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, resolve));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, resolve);
    return out;
  }
  return value;
}

function fixtureResult<T>(output: T, start: number): ProviderCallResult<T> {
  return {
    output,
    rawText: JSON.stringify(output),
    usage: null,
    latencyMs: Date.now() - start,
    modelVersion: 'fixture',
    responseId: null,
    effectiveSettings: { mode: 'fixture' },
  };
}

export class FixtureTranscriber implements Transcriber {
  constructor(private dir: string) {}
  async transcribe(_input: TranscribeInput): Promise<ProviderCallResult<unknown>> {
    const start = Date.now();
    const raw = await readFixture(this.dir, 'transcript.json', 'transcript');
    return fixtureResult(raw, start);
  }
}

export class FixtureExtractor implements EvidenceExtractor {
  constructor(
    private dir: string,
    private transcriptIds: () => string[],
  ) {}
  async extract(input: ExtractInput): Promise<ProviderCallResult<unknown>> {
    const start = Date.now();
    const raw = await readFixture(this.dir, 'evidence.json', 'evidence');
    const trIds = this.transcriptIds();
    const frameIds = input.frames.map((f) => f.frameId);
    const out = substitute(raw, (token) => {
      const [kind, idx] = token.split('#');
      const i = Number(idx);
      if (kind === 'tr') return trIds[i] ?? null;
      if (kind === 'frame') return frameIds[i] ?? null;
      return null;
    });
    return fixtureResult(out, start);
  }
}

export class FixtureJudge implements Judge {
  constructor(
    private dir: string,
    private evidenceIds: () => string[],
    private transcriptIds: () => string[],
    private inputFrameIds: () => string[],
  ) {}
  async score(input: ScoreInput): Promise<ProviderCallResult<unknown>> {
    const start = Date.now();
    const raw = await readFixture(this.dir, `judge-sample-${input.sampleIndex}.json`, 'judge');
    const evIds = this.evidenceIds();
    const trIds = this.transcriptIds();
    const frameIds = this.inputFrameIds();
    const out = substitute(raw, (token) => {
      const [kind, idx] = token.split('#');
      const i = Number(idx);
      if (kind === 'ev') return evIds[i] ?? null;
      if (kind === 'tr') return trIds[i] ?? null;
      if (kind === 'frame') return frameIds[i] ?? null;
      return null;
    });
    return fixtureResult(out, start);
  }
}
