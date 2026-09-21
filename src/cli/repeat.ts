import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import { newJudgeRunId, newRunId } from '../core/ids.js';
import { buildRepeatReport } from '../core/repeat-report.js';
import { normalizeReviewFlags } from '../core/input-hash.js';
import { writeJsonAtomic, isAbsentOrEmptyDir } from '../core/storage.js';
import { buildUsageReport, loadPricing, pricingRef } from '../core/usage.js';
import { FailedAttemptError, type AttemptRecord } from '../core/retry.js';
import { runJudgeStage } from './judge-stage.js';
import { buildJudge } from './providers.js';
import { loadFrozenBundle } from './repeat-bundle.js';

export interface RepeatOptions {
  fromDir: string;
  times: number;
  providerMode: 'fixture' | 'live';
  outDir: string;
  fixtureDir: string;
  pricingPath: string;
  /**
   * Evaluation-only output-language comparison: re-substitute only
   * `{{output_language}}` in the judge prompt template (§41.6 language-diff
   * procedure). Requires `promptsDir` to locate the template.
   */
  outputLanguage?: string;
  promptsDir?: string;
  log?: (line: string) => void;
}

const CHILD_DEADLINE_MS = 30 * 60 * 1000;

interface RepeatChildManifest {
  schema_version: number;
  run_id: string;
  source_run_id: unknown;
  status: string;
  stage: string;
  created_at: string;
  judge_input_mask?: { enabled: true; replacements: Record<string, string> };
  error?: { code: string; message: string };
}

/**
 * `repeat` (§41.6): verify frozen inputs via loadFrozenBundle, then run the
 * judge stage five times against the same transcript/evidence/frames, and
 * write repeat-report.json. Auth failures abort immediately; other failures
 * are recorded and the remaining runs still execute.
 */
export async function cmdRepeat(opts: RepeatOptions): Promise<{
  status: 'pass' | 'fail' | 'not_evaluated';
  reportPath: string;
}> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (opts.times !== 5) {
    throw new CliError('INVALID_ARGS', '--times must be 5 in Phase 0', 2, 'validate_input');
  }
  const bundle = await loadFrozenBundle(opts, log);
  const { evidenceSet, frozenInputs, judgeEntry, rubric } = bundle;

  // Providers (incl. credential check) before creating the output dir.
  const judge = buildJudge(opts, judgeEntry, {
    evidenceIds: () => evidenceSet.evidence_ids,
    transcriptIds: () => bundle.segments.map((s) => s.id),
    inputFrameIds: () => evidenceSet.input_frame_ids,
  });

  if (!(await isAbsentOrEmptyDir(opts.outDir))) {
    throw new CliError('OUTPUT_DIR_NOT_EMPTY', `output dir not empty: ${opts.outDir}`, 2, 'prepare_output');
  }
  await fs.mkdir(path.join(opts.outDir, 'runs'), { recursive: true });

  const evidenceItems = evidenceSet.evidence;
  const selectedSet = new Set(frozenInputs.selected_frames.map((frame) => frame.frame_id));
  const runs: Array<{ index: number; path: string; status: string; run_id: string | null }> = [];
  const perRunLevels: Array<Map<string, string | null> | null> = [];
  const allAttempts: AttemptRecord[] = [];
  const criterionIds = rubric.criteria.map((c) => c.id);
  const pricing = await loadPricing(opts.pricingPath).catch(() => null);
  const finishUsage = async (bestEffort: boolean): Promise<void> => {
    const write = async (): Promise<void> => {
      await writeJsonAtomic(
        path.join(opts.outDir, 'usage.json'),
        buildUsageReport(
          {
            mode: opts.providerMode,
            pricing: pricingRef(pricing, judgeEntry.model),
            attempts: allAttempts,
            model: judgeEntry.model,
          },
          pricing?.table ?? null,
        ),
      );
    };
    if (bestEffort) {
      try {
        await write();
      } catch {
        // Never mask the original repeat result with a usage-write failure.
      }
      return;
    }
    await write();
  };

  try {
    for (let i = 0; i < 5; i++) {
      const idx = String(i + 1).padStart(2, '0');
      const childDir = path.join(opts.outDir, 'runs', idx);
      const childRunId = newRunId();
      let childManifest: RepeatChildManifest;
      try {
        await fs.mkdir(childDir, { recursive: true });
        childManifest = {
          schema_version: 1,
          run_id: childRunId,
          source_run_id: bundle.manifest['run_id'],
          status: 'running',
          stage: 'judge',
          created_at: new Date().toISOString(),
          ...(bundle.maskRecord !== undefined ? { judge_input_mask: bundle.maskRecord } : {}),
        };
        await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
      } catch (err) {
        // If the child dir itself is unwritable every later artifact save
        // fails too, so abort immediately with a normalized error.
        throw err instanceof CliError
          ? err
          : Object.assign(
              new CliError(
                'INTERNAL_ERROR',
                err instanceof Error ? err.message : String(err),
                3,
                'judge',
              ),
              { cause: err },
            );
      }
      // Best-effort: a failed-manifest save must not mask the primary error
      // (the on-disk manifest may stay 'running'; the report records 'failed').
      const writeFailedManifest = async (cliErr: CliError): Promise<void> => {
        childManifest.status = 'failed';
        childManifest.error = { code: cliErr.code, message: cliErr.message };
        try {
          await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
        } catch (saveErr) {
          try {
            log(
              `[repeat] failed to write failed manifest for run ${idx}: ${
                saveErr instanceof Error ? saveErr.message : String(saveErr)
              }`,
            );
          } catch {
            // Diagnostic logging must not mask the primary run failure.
          }
        }
      };
      try {
        log(`[judge] child run ${idx}/5`);
        const res = await runJudgeStage({
          outDir: childDir,
          judge,
          judgeEntry,
          prompt: bundle.judgePrompt,
          rubric,
          evidenceForPrompt: bundle.judgeEvidence,
          transcriptSegments: bundle.judgeSegments,
          selectedFrames: bundle.selectedFrames.map((f) => ({
            frame_id: f.frame_id,
            timestamp_ms: f.timestamp_ms,
            path: path.join(opts.fromDir, f.path),
          })),
          validationCtx: {
            evidenceIds: new Set(evidenceSet.evidence_ids),
            transcriptIds: new Set(bundle.segments.map((s) => s.id)),
            selectedFrameIds: selectedSet,
            evidenceKinds: new Map(evidenceItems.map((e) => [e.id, e.kind])),
          },
          reviewFlagsExtra: normalizeReviewFlags(frozenInputs.review_flags_extra),
          extraInjectionSuspected: evidenceSet.injection_suspected === true,
          deadlineMs: Date.now() + CHILD_DEADLINE_MS,
          stage: 'judge',
          judgeRunId: newJudgeRunId(),
          phase: 'provisional',
          inputHash: bundle.inputHash,
          evidenceSetId: evidenceSet.evidence_set_id,
          pitchId: String(bundle.manifest['pitch_id'] ?? ''),
          runId: childRunId,
          videoAbsent: bundle.selectedFrames.length === 0,
        });
        allAttempts.push(...res.attempts);
        const levels = new Map<string, string | null>();
        for (const c of res.scorecard.criteria) {
          levels.set(c.criterion_id, c.aggregated_level);
        }
        try {
          await writeJsonAtomic(path.join(childDir, 'judge-run.json'), res.judgeRun);
          await writeJsonAtomic(path.join(childDir, 'scorecard.json'), res.scorecard);
          childManifest.status = 'completed';
          childManifest.stage = 'completed';
          await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
        } catch (err) {
          // Artifact persistence failed, not the judge call: revert the
          // tentative completed state so the failed manifest records where
          // the run actually stopped.
          childManifest.status = 'running';
          childManifest.stage = 'judge';
          throw err instanceof CliError
            ? err
            : Object.assign(
                new CliError(
                  'INTERNAL_ERROR',
                  err instanceof Error ? err.message : String(err),
                  3,
                  'judge',
                ),
                { cause: err },
              );
        }
        perRunLevels.push(levels);
        runs.push({ index: i + 1, path: `runs/${idx}`, status: 'completed', run_id: childRunId });
      } catch (err) {
        // Merge all attempts made so far (prior samples + the failed call's
        // attempts, carried by FailedAttemptError) into usage.json.
        if (err instanceof FailedAttemptError) allAttempts.push(...err.attempts);
        const cliErr =
          err instanceof CliError
            ? err
            : new CliError('PROVIDER_OTHER', String(err), 3, 'judge');
        // Auth failure: abort immediately (no point continuing).
        if (cliErr.code === 'PROVIDER_AUTH') {
          await writeFailedManifest(cliErr);
          throw cliErr;
        }
        await writeFailedManifest(cliErr);
        perRunLevels.push(null);
        runs.push({ index: i + 1, path: `runs/${idx}`, status: 'failed', run_id: childRunId });
      }
    }

    const report = buildRepeatReport({
      sourceRunId: String(bundle.manifest['run_id'] ?? ''),
      inputHash: bundle.inputHash,
      mode: opts.providerMode,
      runs,
      criterionIds,
      perRunLevels,
      ...(bundle.outputLanguageCompare !== undefined
        ? { sourceInputHash: frozenInputs.input_hash, outputLanguageCompare: bundle.outputLanguageCompare }
        : {}),
    });
    const reportPath = path.join(opts.outDir, 'repeat-report.json');
    await writeJsonAtomic(reportPath, report);
    await finishUsage(false);

    return { status: report.status, reportPath };
  } catch (err) {
    await finishUsage(true);
    throw err;
  }
}
