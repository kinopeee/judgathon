import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import { newJudgeRunId, newRunId } from '../core/ids.js';
import { buildRepeatReport } from '../core/repeat-report.js';
import { sha256File, sha256Hex, writeJsonAtomic, readJsonFile, isAbsentOrEmptyDir } from '../core/storage.js';
import { buildUsageReport, loadPricing } from '../core/usage.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import { validateConfig } from '../core/schemas/config.js';
import type { ProviderSet } from '../providers/types.js';
import { FixtureJudge } from '../providers/fixture/index.js';
import { GoogleJudge } from '../providers/google/index.js';
import { runJudgeStage } from './run.js';
import type { AttemptRecord } from '../core/retry.js';

export interface RepeatOptions {
  fromDir: string;
  times: number;
  providerMode: 'fixture' | 'live';
  outDir: string;
  fixtureDir: string;
  pricingPath: string;
  log?: (line: string) => void;
}

const CHILD_DEADLINE_MS = 30 * 60 * 1000;

/**
 * `repeat` (§41.6): verify frozen inputs by hash, then run the judge stage
 * five times against the same transcript/evidence/frames, and write
 * repeat-report.json. Auth failures abort immediately; other failures are
 * recorded and the remaining runs still execute.
 */
export async function cmdRepeat(opts: RepeatOptions): Promise<{
  status: 'pass' | 'fail' | 'not_evaluated';
  reportPath: string;
}> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (opts.times !== 5) {
    throw new CliError('INVALID_ARGS', '--times must be 5 in Phase 0', 2, 'validate_input');
  }
  const manifest = (await readJsonFile(path.join(opts.fromDir, 'manifest.json')).catch(() => {
    throw new CliError('INPUT_INVALID', `manifest.json not found in ${opts.fromDir}`, 2, 'validate_input');
  })) as Record<string, unknown>;
  if (manifest['status'] !== 'completed') {
    throw new CliError('INPUT_INVALID', `source run status is ${manifest['status']}, expected completed`, 2, 'validate_input');
  }

  const configSnap = (await readJsonFile(path.join(opts.fromDir, 'config.snapshot.json'))) as {
    effective: { provider_mode?: string; prompts?: Record<string, { path: string; sha256: string }> };
    config_sha256: string;
    effective_config?: never;
  };
  const snapshotMode = (configSnap.effective as { provider_mode?: string }).provider_mode;
  if (snapshotMode !== opts.providerMode) {
    throw new CliError(
      'PROVIDER_MODE_MISMATCH',
      `--provider-mode ${opts.providerMode} does not match original run mode ${snapshotMode}`,
      2,
      'validate_input',
    );
  }

  // Verify frozen artifacts by sha256 before any child run.
  const verify = async (rel: string): Promise<string> => sha256File(path.join(opts.fromDir, rel));
  const frozen: Record<string, string> = {};
  for (const rel of [
    'transcript.json',
    'evidence-set.json',
    'config.snapshot.json',
    'rubric.snapshot.json',
  ]) {
    frozen[rel] = await verify(rel);
  }
  const evidenceSet = (await readJsonFile(path.join(opts.fromDir, 'evidence-set.json'))) as Record<
    string,
    unknown
  >;
  const transcript = (await readJsonFile(path.join(opts.fromDir, 'transcript.json'))) as Record<
    string,
    unknown
  >;
  const rubricSnap = (await readJsonFile(path.join(opts.fromDir, 'rubric.snapshot.json'))) as {
    rubric: unknown;
    rubric_sha256: string;
  };

  const selectedFrameIds = (evidenceSet['selected_frame_ids'] as string[]) ?? [];
  const framesMeta = ((manifest['media'] as Record<string, unknown>)?.['frames'] ??
    []) as Array<{ frame_id: string; path: string; sha256: string; timestamp_ms: number }>;
  const selectedMeta = framesMeta.filter((f) => selectedFrameIds.includes(f.frame_id));
  for (const f of selectedMeta) {
    const actual = await sha256File(path.join(opts.fromDir, f.path));
    if (actual !== f.sha256) {
      throw new CliError(
        'INPUT_HASH_MISMATCH',
        `frame ${f.frame_id} sha256 mismatch (${f.path})`,
        2,
        'validate_input',
      );
    }
  }
  for (const [key, p] of Object.entries(configSnap.effective.prompts ?? {})) {
    const actual = await sha256File(path.join(opts.fromDir, p.path));
    if (actual !== p.sha256) {
      throw new CliError('INPUT_HASH_MISMATCH', `prompt ${key} sha256 mismatch`, 2, 'validate_input');
    }
  }

  // Config for judge entry: re-derive from the snapshot's effective config.
  const effective = configSnap.effective as unknown as JudgeConfig & { provider_mode: string };
  const cfgCheck = validateConfig({
    schema_version: effective.schema_version,
    id: effective.id,
    output_language: effective.output_language,
    transcriber: effective.transcriber,
    evidence_extractor: effective.evidence_extractor,
    judges: effective.judges,
    samples_per_judge: effective.samples_per_judge,
    aggregation: effective.aggregation,
    ranking: effective.ranking,
    frame_selection: effective.frame_selection,
  });
  if (!cfgCheck.ok) {
    throw new CliError('CONFIG_INVALID', `snapshot config invalid: ${cfgCheck.errors.join('; ')}`, 2, 'validate_input');
  }
  const config = cfgCheck.config;
  const judgeEntry = config.judges[0]!;

  const judgePromptRel = configSnap.effective.prompts?.['judge'];
  const judgePromptText = await fs.readFile(
    path.join(opts.fromDir, judgePromptRel?.path ?? 'prompts/absolute-score-v1.md'),
    'utf8',
  );
  const judgePrompt = {
    version: judgeEntry.prompt_version,
    path: judgePromptRel?.path ?? '',
    sha256: judgePromptRel?.sha256 ?? sha256Hex(judgePromptText),
    text: judgePromptText,
  };

  if (!(await isAbsentOrEmptyDir(opts.outDir))) {
    throw new CliError('OUTPUT_DIR_NOT_EMPTY', `output dir not empty: ${opts.outDir}`, 2, 'prepare_output');
  }
  await fs.mkdir(path.join(opts.outDir, 'runs'), { recursive: true });

  const rubric = rubricSnap.rubric as JudgeConfig extends never ? never : import('../core/schemas/rubric.js').Rubric;

  const evidenceItems = (evidenceSet['evidence'] as Array<Record<string, unknown>>) ?? [];
  const evidenceIds = (evidenceSet['evidence_ids'] as string[]) ?? [];
  const segments = (transcript['segments'] as import('../providers/types.js').TranscriptSegment[]) ?? [];

  const inputHash = sha256Hex(
    [
      frozen['transcript.json']!,
      frozen['evidence-set.json']!,
      ...selectedMeta.map((f) => f.sha256),
      rubricSnap.rubric_sha256,
      configSnap.config_sha256,
      judgePrompt.sha256,
    ].join('\n'),
  );

  const providerSet: ProviderSet =
    opts.providerMode === 'fixture'
      ? {
          mode: 'fixture',
          transcriber: undefined as never,
          extractor: undefined as never,
          judge: new FixtureJudge(
            opts.fixtureDir,
            () => evidenceIds,
            () => segments.map((s) => s.id),
            () => (evidenceSet['input_frame_ids'] as string[]) ?? [],
          ),
        }
      : (() => {
          const apiKey = process.env['GOOGLE_API_KEY'];
          if (!apiKey) {
            throw new CliError(
              'MISSING_CREDENTIALS',
              'GOOGLE_API_KEY environment variable is required for --provider-mode live',
              3,
              'validate_input',
            );
          }
          return {
            mode: 'live',
            transcriber: undefined as never,
            extractor: undefined as never,
            judge: new GoogleJudge(judgeEntry, { apiKey }),
          };
        })();

  const runs: Array<{ index: number; path: string; status: string; run_id: string | null }> = [];
  const perRunLevels: Array<Map<string, string | null> | null> = [];
  const allAttempts: AttemptRecord[] = [];
  const criterionIds = ((rubricSnap.rubric as { criteria: Array<{ id: string }> }).criteria ?? []).map(
    (c) => c.id,
  );

  for (let i = 0; i < 5; i++) {
    const idx = String(i + 1).padStart(2, '0');
    const childDir = path.join(opts.outDir, 'runs', idx);
    const childRunId = newRunId();
    await fs.mkdir(childDir, { recursive: true });
    const childManifest: Record<string, unknown> = {
      schema_version: 1,
      run_id: childRunId,
      source_run_id: manifest['run_id'],
      status: 'running',
      stage: 'judge',
      created_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
    try {
      log(`[judge] child run ${idx}/5`);
      const res = await runJudgeStage({
        outDir: childDir,
        judge: providerSet.judge,
        judgeEntry,
        prompt: judgePrompt,
        rubric,
        evidenceForPrompt: { evidence: evidenceItems },
        transcriptSegments: segments,
        selectedFrames: selectedMeta.map((f) => ({
          frame_id: f.frame_id,
          timestamp_ms: f.timestamp_ms,
          path: path.join(opts.fromDir, f.path),
        })),
        validationCtx: {
          evidenceIds: new Set(evidenceIds),
          transcriptIds: new Set(segments.map((s) => s.id)),
          selectedFrameIds: new Set(selectedFrameIds),
        },
        reviewFlagsExtra: [],
        deadlineMs: Date.now() + CHILD_DEADLINE_MS,
        stage: 'judge',
        judgeRunId: newJudgeRunId(),
        phase: 'provisional',
        inputHash,
        evidenceSetId: String(evidenceSet['evidence_set_id'] ?? ''),
        pitchId: String(manifest['pitch_id'] ?? ''),
        runId: childRunId,
        videoAbsent: selectedMeta.length === 0,
      });
      allAttempts.push(...res.attempts);
      await writeJsonAtomic(path.join(childDir, 'judge-run.json'), res.judgeRun);
      await writeJsonAtomic(path.join(childDir, 'scorecard.json'), res.scorecard);
      const levels = new Map<string, string | null>();
      for (const c of (res.scorecard as { criteria: Array<{ criterion_id: string; aggregated_level: string | null }> }).criteria) {
        levels.set(c.criterion_id, c.aggregated_level);
      }
      perRunLevels.push(levels);
      childManifest['status'] = 'completed';
      childManifest['stage'] = 'completed';
      await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
      runs.push({ index: i + 1, path: `runs/${idx}`, status: 'completed', run_id: childRunId });
    } catch (err) {
      const cliErr =
        err instanceof CliError
          ? err
          : new CliError('PROVIDER_OTHER', String(err), 3, 'judge');
      // Auth failure: abort immediately (no point continuing).
      if (cliErr.code === 'PROVIDER_AUTH') {
        childManifest['status'] = 'failed';
        childManifest['error'] = { code: cliErr.code, message: cliErr.message };
        await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
        throw cliErr;
      }
      childManifest['status'] = 'failed';
      childManifest['error'] = { code: cliErr.code, message: cliErr.message };
      await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
      perRunLevels.push(null);
      runs.push({ index: i + 1, path: `runs/${idx}`, status: 'failed', run_id: childRunId });
    }
  }

  const pricing = await loadPricing(opts.pricingPath).catch(() => null);
  const report = buildRepeatReport({
    sourceRunId: String(manifest['run_id'] ?? ''),
    inputHash,
    mode: opts.providerMode,
    runs,
    criterionIds,
    perRunLevels,
  });
  const reportPath = path.join(opts.outDir, 'repeat-report.json');
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(
    path.join(opts.outDir, 'usage.json'),
    buildUsageReport(
      {
        mode: providerSet.mode,
        pricing: pricing
          ? { path: pricing.path, sha256: pricing.sha256, valid_until: pricing.table.models[judgeEntry.model]?.valid_until ?? null }
          : null,
        attempts: allAttempts,
        model: judgeEntry.model,
      },
      pricing?.table ?? null,
    ),
  );

  return { status: report['status'] as 'pass' | 'fail' | 'not_evaluated', reportPath };
}
