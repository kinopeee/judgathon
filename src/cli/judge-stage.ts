import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import type { Rubric } from '../core/schemas/rubric.js';
import {
  rawScoreJsonSchema,
  type RawScoreOutput,
} from '../core/schemas/provider-outputs.js';
import { validateScoreOutput } from '../core/reference-validation.js';
import {
  callWithAttempts,
  FailedAttemptError,
  type AttemptRecord,
  type AttemptSuccess,
} from '../core/retry.js';
import { sha256Hex, writeJsonAtomic } from '../core/storage.js';
import { aggregateScores, type ScorecardResult } from '../core/aggregation.js';
import { applyNameMask, buildNameMaskMap } from '../core/name-masking.js';
import type { Judge, TranscriptSegment } from '../providers/types.js';

const MAX_ATTEMPTS = 3;

export interface PromptRef {
  version: string;
  path: string;
  sha256: string;
  text: string;
}

export interface JudgeRunSample {
  sample_index: number;
  attempts: AttemptRecord[];
  status: 'ok';
  validated_output: RawScoreOutput;
}

export interface JudgeRunDocument {
  schema_version: number;
  judge_run_id: string;
  phase: 'provisional' | 'final';
  judge_id: string;
  model: string;
  effective_settings: {
    temperature?: number;
    top_p?: number;
    seed?: number;
    thinking_level?: 'low' | 'medium' | 'high';
    prompt_sha256: string;
  };
  input_hash: string;
  samples: JudgeRunSample[];
  status: string;
}

/** scorecard.json: the aggregation result plus its document envelope. */
export interface ScorecardDocument extends ScorecardResult {
  schema_version: number;
  judge_run_id: string;
  judge_id: string;
  pitch_id: string;
  run_id: string;
  evidence_set_id: string;
  rubric_version_id: string;
}

export interface JudgeStageResult {
  judgeRun: JudgeRunDocument;
  scorecard: ScorecardDocument;
  attempts: AttemptRecord[];
  rawTexts: Array<{ sample: number; attempt: number; file: string }>;
}

export function fillPrompt(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

export async function loadPrompt(promptsDir: string, version: string): Promise<PromptRef> {
  const p = path.join(promptsDir, `${version}.md`);
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    throw new CliError('CONFIG_INVALID', `prompt '${version}' not found at ${p}`, 2, 'validate_input');
  }
  return { version, path: p, sha256: sha256Hex(text), text };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runJudgeStage(opts: {
  outDir: string;
  judge: Judge;
  judgeEntry: JudgeConfig['judges'][number];
  prompt: PromptRef;
  rubric: Rubric;
  evidenceForPrompt: unknown;
  transcriptSegments: TranscriptSegment[];
  selectedFrames: Array<{ frame_id: string; timestamp_ms: number; path: string }>;
  validationCtx: {
    evidenceIds: Set<string>;
    transcriptIds: Set<string>;
    selectedFrameIds: Set<string>;
    observationGradeIds: Set<string>;
  };
  reviewFlagsExtra: string[];
  /** Extractor-side injection flag — OR-ed into the scorecard (§41). */
  extraInjectionSuspected: boolean;
  deadlineMs: number;
  stage: string;
  judgeRunId: string;
  phase: 'provisional' | 'final';
  inputHash: string;
  evidenceSetId: string;
  pitchId: string;
  runId: string;
  videoAbsent: boolean;
}): Promise<JudgeStageResult> {
  const attemptsDir = path.join(opts.outDir, 'attempts');
  const allAttempts: AttemptRecord[] = [];
  const validated: RawScoreOutput[] = [];
  const samples: JudgeRunSample[] = [];

  for (let sampleIndex = 0; sampleIndex < 3; sampleIndex++) {
    let res: AttemptSuccess<RawScoreOutput>;
    try {
      res = await callWithAttempts<RawScoreOutput>(
      {
        operation: 'judge',
        sampleIndex,
        maxAttempts: MAX_ATTEMPTS,
        sleep,
        now: () => Date.now(),
        deadlineMs: opts.deadlineMs,
        stage: opts.stage,
        saveRaw: async (rec) => {
          const name = `judge-s${sampleIndex}-a${rec.attempt_index}.json`;
          await writeJsonAtomic(path.join(attemptsDir, name), rec);
          return path.join('attempts', name);
        },
      },
      (repairFeedback) =>
        opts.judge.score({
          promptText: opts.prompt.text,
          rubric: opts.rubric,
          evidenceSet: opts.evidenceForPrompt,
          transcriptSegments: opts.transcriptSegments,
          frames: opts.selectedFrames.map((f) => ({
            frameId: f.frame_id,
            timestampMs: f.timestamp_ms,
            path: f.path,
          })),
          sampleIndex,
          schema: rawScoreJsonSchema,
          ...(repairFeedback !== undefined ? { repairFeedback } : {}),
        }),
      (parsed) =>
        validateScoreOutput(parsed, {
          rubric: opts.rubric,
          evidenceIds: opts.validationCtx.evidenceIds,
          transcriptIds: opts.validationCtx.transcriptIds,
          selectedFrameIds: opts.validationCtx.selectedFrameIds,
          observationGradeIds: opts.validationCtx.observationGradeIds,
        }),
    );
    } catch (err) {
      // callWithAttempts reports per-call attempts on FailedAttemptError; merge
      // them with prior successful samples so every provider call reaches
      // usage.json.
      if (err instanceof FailedAttemptError) allAttempts.push(...err.attempts);
      const cliErr =
        err instanceof CliError
          ? err
          : Object.assign(
              new CliError(
                'INTERNAL_ERROR',
                err instanceof Error ? err.message : String(err),
                3,
                opts.stage,
              ),
              { cause: err },
            );
      throw new FailedAttemptError(cliErr, allAttempts);
    }
    allAttempts.push(...res.attempts);
    validated.push(res.value);
    samples.push({
      sample_index: sampleIndex,
      attempts: res.attempts,
      status: 'ok',
      validated_output: res.value,
    });
  }

  const score = aggregateScores(opts.rubric, validated, {
    extraReviewFlags: opts.reviewFlagsExtra,
    extraInjectionSuspected: opts.extraInjectionSuspected,
  });

  const judgeRun: JudgeRunDocument = {
    schema_version: 1,
    judge_run_id: opts.judgeRunId,
    phase: opts.phase,
    judge_id: opts.judgeEntry.id,
    model: opts.judgeEntry.model,
    effective_settings: {
      ...(opts.judgeEntry.temperature !== undefined
        ? { temperature: opts.judgeEntry.temperature }
        : {}),
      ...(opts.judgeEntry.top_p !== undefined ? { top_p: opts.judgeEntry.top_p } : {}),
      ...(opts.judgeEntry.seed !== undefined ? { seed: opts.judgeEntry.seed } : {}),
      ...(opts.judgeEntry.thinking !== undefined ? { thinking_level: opts.judgeEntry.thinking } : {}),
      prompt_sha256: opts.prompt.sha256,
    },
    input_hash: opts.inputHash,
    samples,
    status: 'completed',
  };

  const scorecard: ScorecardDocument = {
    schema_version: 1,
    judge_run_id: opts.judgeRunId,
    judge_id: opts.judgeEntry.id,
    pitch_id: opts.pitchId,
    run_id: opts.runId,
    evidence_set_id: opts.evidenceSetId,
    rubric_version_id: opts.rubric.id,
    ...score,
    samples: score.samples,
  };

  return { judgeRun, scorecard, attempts: allAttempts, rawTexts: [] };
}

export function buildEvidenceForPrompt(
  evidenceItems: Array<Record<string, unknown> & { id: string }>,
  unshownSourceIds: Record<string, string[]>,
): { evidence: Array<Record<string, unknown>> } {
  return {
    evidence: evidenceItems.map((e) => ({
      ...e,
      unshown_source_ids: unshownSourceIds[e.id] ?? [],
    })),
  };
}

/**
 * Judge-input masking (§41.6): mask `チーム<Name>` / `Team <Name>` in the
 * transcript segments and evidence descriptions sent to the judge. The map
 * is built in transcript order, then evidence order, so it is deterministic
 * and `repeat` recomputes the same table from the frozen artifacts.
 */
export function maskJudgeInputs(
  segments: TranscriptSegment[],
  evidenceForPrompt: { evidence: Array<Record<string, unknown>> },
): {
  segments: TranscriptSegment[];
  evidence: { evidence: Array<Record<string, unknown>> };
  record: { enabled: true; replacements: Record<string, string> };
} {
  const map = buildNameMaskMap([
    ...segments.map((s) => s.text),
    ...evidenceForPrompt.evidence
      .map((e) => e['description'])
      .filter((d): d is string => typeof d === 'string'),
  ]);
  return {
    segments: segments.map((s) => ({ ...s, text: applyNameMask(s.text, map) })),
    evidence: {
      evidence: evidenceForPrompt.evidence.map((e) =>
        typeof e['description'] === 'string'
          ? { ...e, description: applyNameMask(e['description'], map) }
          : e,
      ),
    },
    record: { enabled: true, replacements: Object.fromEntries(map) },
  };
}
