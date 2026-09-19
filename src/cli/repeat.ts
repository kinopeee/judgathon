import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { CliError } from '../core/errors.js';
import { newJudgeRunId, newRunId } from '../core/ids.js';
import { buildRepeatReport } from '../core/repeat-report.js';
import { computeInputHash } from '../core/input-hash.js';
import { sha256File, sha256Hex, writeJsonAtomic, readJsonFile, isAbsentOrEmptyDir } from '../core/storage.js';
import { buildUsageReport, loadPricing } from '../core/usage.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import { validateConfig } from '../core/schemas/config.js';
import { validateRubric, type Rubric } from '../core/schemas/rubric.js';
import type { ProviderSet } from '../providers/types.js';
import type { TranscriptSegment } from '../providers/types.js';
import { FixtureJudge } from '../providers/fixture/index.js';
import { GoogleJudge } from '../providers/google/index.js';
import { runJudgeStage, buildEvidenceForPrompt } from './run.js';
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

// Minimal structural validation of the frozen artifacts (§41.6): enough to
// guarantee the fields the judge stage depends on are present and shaped.
const FrozenTranscript = z.object({
  segments: z.array(
    z.object({
      id: z.string().min(1),
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      text: z.string(),
      asr_confidence: z.number().nullable().optional(),
    }),
  ),
});
const FrozenEvidenceSet = z.object({
  evidence: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      sources: z.array(z.object({ type: z.string(), id: z.string() })),
    }),
  ),
  evidence_ids: z.array(z.string()),
  input_frame_ids: z.array(z.string()),
  selected_frame_ids: z.array(z.string()),
  injection_suspected: z.boolean().optional(),
});

/** Resolve a bundle-relative path, rejecting traversal outside fromDir. */
function resolveInside(fromDir: string, rel: string): string {
  const abs = path.resolve(fromDir, rel);
  if (!abs.startsWith(path.resolve(fromDir) + path.sep)) {
    throw new CliError(
      'INPUT_INVALID',
      `path escapes source bundle: ${rel}`,
      2,
      'validate_input',
    );
  }
  return abs;
}

interface FrozenInputs {
  transcript_sha256: string;
  evidence_set_sha256: string;
  selected_frame_ids: string[];
  rubric_sha256: string;
  config_sha256: string;
  judge_prompt_sha256: string;
  input_hash: string;
}

function readFrozenInputs(manifest: Record<string, unknown>): FrozenInputs {
  const fi = manifest['frozen_inputs'] as Partial<FrozenInputs> | undefined;
  if (
    !fi ||
    typeof fi.transcript_sha256 !== 'string' ||
    typeof fi.evidence_set_sha256 !== 'string' ||
    !Array.isArray(fi.selected_frame_ids) ||
    typeof fi.rubric_sha256 !== 'string' ||
    typeof fi.config_sha256 !== 'string' ||
    typeof fi.judge_prompt_sha256 !== 'string' ||
    typeof fi.input_hash !== 'string'
  ) {
    throw new CliError(
      'INPUT_INVALID',
      'manifest.frozen_inputs missing or malformed',
      2,
      'validate_input',
    );
  }
  return fi as FrozenInputs;
}

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

  const frozenInputs = readFrozenInputs(manifest);

  const evidenceSetRaw = await readJsonFile(path.join(opts.fromDir, 'evidence-set.json'));
  const transcriptRaw = await readJsonFile(path.join(opts.fromDir, 'transcript.json'));
  const rubricSnap = (await readJsonFile(path.join(opts.fromDir, 'rubric.snapshot.json'))) as {
    rubric: unknown;
    rubric_sha256: string;
  };

  const transcriptParsed = FrozenTranscript.safeParse(transcriptRaw);
  if (!transcriptParsed.success) {
    throw new CliError('INPUT_INVALID', `transcript.json invalid: ${transcriptParsed.error.message}`, 2, 'validate_input');
  }
  const evidenceParsed = FrozenEvidenceSet.safeParse(evidenceSetRaw);
  if (!evidenceParsed.success) {
    throw new CliError('INPUT_INVALID', `evidence-set.json invalid: ${evidenceParsed.error.message}`, 2, 'validate_input');
  }
  // rubric.snapshot.json stores the inner rubric object; validateRubric
  // expects the document root ({rubric: ...}).
  const rubricParsed = validateRubric({ rubric: rubricSnap.rubric });
  if (!rubricParsed.ok) {
    throw new CliError('INPUT_INVALID', `rubric.snapshot.json invalid: ${rubricParsed.errors.join('; ')}`, 2, 'validate_input');
  }
  const rubric: Rubric = rubricParsed.rubric;
  const evidenceSet = evidenceParsed.data;
  const segments: TranscriptSegment[] = transcriptParsed.data.segments.map((s) => ({
    id: s.id,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    text: s.text,
    asr_confidence: s.asr_confidence ?? null,
  }));

  // Frozen-input verification (must complete before creating the out dir):
  // component hashes + composite input_hash must match the manifest.
  const hashMismatch = (what: string): never => {
    throw new CliError('INPUT_HASH_MISMATCH', `${what} hash mismatch`, 2, 'validate_input');
  };
  if ((await sha256File(path.join(opts.fromDir, 'transcript.json'))) !== frozenInputs.transcript_sha256) {
    hashMismatch('transcript.json');
  }
  if ((await sha256File(path.join(opts.fromDir, 'evidence-set.json'))) !== frozenInputs.evidence_set_sha256) {
    hashMismatch('evidence-set.json');
  }
  if (rubricSnap.rubric_sha256 !== frozenInputs.rubric_sha256) hashMismatch('rubric');
  if (configSnap.config_sha256 !== frozenInputs.config_sha256) hashMismatch('config');

  const selectedFrameIds = frozenInputs.selected_frame_ids;
  if (new Set(selectedFrameIds).size !== selectedFrameIds.length) {
    throw new CliError('INPUT_INVALID', 'selected_frame_ids contains duplicates', 2, 'validate_input');
  }
  const framesMeta = ((manifest['media'] as Record<string, unknown> | undefined)?.['frames'] ??
    []) as Array<{ frame_id: string; path: string; sha256: string; timestamp_ms: number }>;
  const metaById = new Map(framesMeta.map((f) => [f.frame_id, f]));
  const selectedMeta: typeof framesMeta = [];
  for (const id of selectedFrameIds) {
    const meta = metaById.get(id);
    if (!meta) {
      throw new CliError('INPUT_INVALID', `selected frame ${id} missing from manifest.media.frames`, 2, 'validate_input');
    }
    if (framesMeta.filter((f) => f.frame_id === id).length !== 1) {
      throw new CliError('INPUT_INVALID', `duplicate frame record for ${id}`, 2, 'validate_input');
    }
    selectedMeta.push(meta);
  }
  for (const f of selectedMeta) {
    const actual = await sha256File(resolveInside(opts.fromDir, f.path));
    if (actual !== f.sha256) hashMismatch(`frame ${f.frame_id}`);
  }

  for (const [key, p] of Object.entries(configSnap.effective.prompts ?? {})) {
    const actual = await sha256File(resolveInside(opts.fromDir, p.path));
    if (actual !== p.sha256) hashMismatch(`prompt ${key}`);
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
    resolveInside(opts.fromDir, judgePromptRel?.path ?? 'prompts/absolute-score-v1.md'),
    'utf8',
  );
  const judgePromptSha = sha256Hex(judgePromptText);
  if (judgePromptSha !== frozenInputs.judge_prompt_sha256) hashMismatch('judge prompt');
  const judgePrompt = {
    version: judgeEntry.prompt_version,
    path: judgePromptRel?.path ?? '',
    sha256: judgePromptSha,
    text: judgePromptText,
  };

  const inputHash = computeInputHash({
    transcriptSha256: frozenInputs.transcript_sha256,
    evidenceSetSha256: frozenInputs.evidence_set_sha256,
    selectedFrameSha256s: selectedMeta.map((f) => f.sha256),
    rubricSha256: rubricSnap.rubric_sha256,
    configSha256: configSnap.config_sha256,
    judgePromptSha256: judgePromptSha,
  });
  if (inputHash !== frozenInputs.input_hash) hashMismatch('composite input_hash');

  // Providers (incl. credential check) before creating the output dir.
  const evidenceIds = evidenceSet.evidence_ids;
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
            () => evidenceSet.input_frame_ids,
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

  if (!(await isAbsentOrEmptyDir(opts.outDir))) {
    throw new CliError('OUTPUT_DIR_NOT_EMPTY', `output dir not empty: ${opts.outDir}`, 2, 'prepare_output');
  }
  await fs.mkdir(path.join(opts.outDir, 'runs'), { recursive: true });

  const evidenceItems = evidenceSet.evidence;
  // Reconstruct unshown frame sources: frame sources of each evidence item
  // that were not among selected_frame_ids.
  const selectedSet = new Set(selectedFrameIds);
  const unshownSourceIds: Record<string, string[]> = {};
  for (const item of evidenceItems) {
    const unshown = item.sources
      .filter((s) => s.type === 'frame' && !selectedSet.has(s.id))
      .map((s) => s.id);
    if (unshown.length > 0) unshownSourceIds[item.id] = unshown;
  }
  const evidenceForPrompt = buildEvidenceForPrompt(evidenceItems, unshownSourceIds);

  const runs: Array<{ index: number; path: string; status: string; run_id: string | null }> = [];
  const perRunLevels: Array<Map<string, string | null> | null> = [];
  const allAttempts: AttemptRecord[] = [];
  const criterionIds = rubric.criteria.map((c) => c.id);

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
        evidenceForPrompt,
        transcriptSegments: segments,
        selectedFrames: selectedMeta.map((f) => ({
          frame_id: f.frame_id,
          timestamp_ms: f.timestamp_ms,
          path: path.join(opts.fromDir, f.path),
        })),
        validationCtx: {
          evidenceIds: new Set(evidenceIds),
          transcriptIds: new Set(segments.map((s) => s.id)),
          selectedFrameIds: selectedSet,
        },
        reviewFlagsExtra: [],
        extraInjectionSuspected: evidenceSet.injection_suspected === true,
        deadlineMs: Date.now() + CHILD_DEADLINE_MS,
        stage: 'judge',
        judgeRunId: newJudgeRunId(),
        phase: 'provisional',
        inputHash,
        evidenceSetId: String((evidenceSetRaw as Record<string, unknown>)['evidence_set_id'] ?? ''),
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
      // Merge all attempts made so far (prior samples + the failed call's
      // attempts, attached by runJudgeStage/callWithAttempts) into usage.json.
      const partial = (err as { attempts?: AttemptRecord[] }).attempts ?? [];
      allAttempts.push(...partial);
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
