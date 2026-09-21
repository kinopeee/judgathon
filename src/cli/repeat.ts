import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import { newJudgeRunId, newRunId } from '../core/ids.js';
import { buildRepeatReport } from '../core/repeat-report.js';
import { computeInputHash, judgeSchemaSha256, normalizeReviewFlags } from '../core/input-hash.js';
import { sha256File, sha256Hex, writeJsonAtomic, readJsonFile, isAbsentOrEmptyDir } from '../core/storage.js';
import { buildUsageReport, loadPricing } from '../core/usage.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import { validateConfig } from '../core/schemas/config.js';
import { validateRubric, type Rubric } from '../core/schemas/rubric.js';
import {
  frozenInputsV2Schema,
  storedConfigSnapshotSchema,
  storedEvidenceSetSchema,
  storedRubricSnapshotSchema,
  storedTranscriptSchema,
  type FrozenInputsV2,
} from '../core/schemas/artifacts.js';
import type { ProviderSet } from '../providers/types.js';
import type { TranscriptSegment } from '../providers/types.js';
import { FixtureJudge } from '../providers/fixture/index.js';
import { GoogleJudge } from '../providers/google/index.js';
import { runJudgeStage, buildEvidenceForPrompt, fillPrompt, loadPrompt } from './run.js';
import type { AttemptRecord } from '../core/retry.js';

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

  const frozenRaw = manifest['frozen_inputs'];
  if (
    !frozenRaw ||
    typeof frozenRaw !== 'object' ||
    (frozenRaw as Record<string, unknown>)['hash_version'] !== 2
  ) {
    throw new CliError(
      'UNSUPPORTED_FROZEN_INPUT_VERSION',
      'source run uses an unsupported frozen input version; create a new run with the current CLI',
      2,
      'validate_input',
    );
  }
  const frozenParse = frozenInputsV2Schema.safeParse(frozenRaw);
  if (!frozenParse.success) {
    throw new CliError(
      'INPUT_INVALID',
      `manifest.frozen_inputs invalid: ${frozenParse.error.message}`,
      2,
      'validate_input',
    );
  }
  const frozenInputs: FrozenInputsV2 = frozenParse.data;

  const parseArtifact = async <T>(
    name: string,
    schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } },
  ): Promise<T> => {
    let raw: unknown;
    try {
      raw = await readJsonFile(path.join(opts.fromDir, name));
    } catch {
      throw new CliError('INPUT_INVALID', `${name} not found or invalid JSON`, 2, 'validate_input');
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new CliError('INPUT_INVALID', `${name} invalid: ${parsed.error.message}`, 2, 'validate_input');
    }
    return parsed.data;
  };
  const configSnap = await parseArtifact('config.snapshot.json', storedConfigSnapshotSchema);
  const rubricSnap = await parseArtifact('rubric.snapshot.json', storedRubricSnapshotSchema);
  const transcript = await parseArtifact('transcript.json', storedTranscriptSchema);
  const evidenceSet = await parseArtifact('evidence-set.json', storedEvidenceSetSchema);

  const snapshotMode = configSnap.effective.provider_mode;
  if (snapshotMode !== opts.providerMode) {
    throw new CliError(
      'PROVIDER_MODE_MISMATCH',
      `--provider-mode ${opts.providerMode} does not match original run mode ${snapshotMode}`,
      2,
      'validate_input',
    );
  }

  const rubricParsed = validateRubric({ rubric: rubricSnap.rubric });
  if (!rubricParsed.ok) {
    throw new CliError('INPUT_INVALID', `rubric.snapshot.json invalid: ${rubricParsed.errors.join('; ')}`, 2, 'validate_input');
  }
  const rubric: Rubric = rubricParsed.rubric;
  const segments: TranscriptSegment[] = transcript.segments.map((s) => ({
    id: s.id,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    text: s.text,
    asr_confidence: s.asr_confidence,
  }));

  const hashMismatch = (what: string): never => {
    throw new CliError('INPUT_HASH_MISMATCH', `${what} hash mismatch`, 2, 'validate_input');
  };
  const hashSourceFile = async (filePath: string, label: string): Promise<string> => {
    try {
      return await sha256File(filePath);
    } catch {
      throw new CliError('INPUT_INVALID', `${label} not found in source bundle`, 2, 'validate_input');
    }
  };
  const selectedFrameIds = frozenInputs.selected_frames.map((frame) => frame.frame_id);
  if (
    selectedFrameIds.length !== evidenceSet.selected_frame_ids.length ||
    selectedFrameIds.some((id, i) => id !== evidenceSet.selected_frame_ids[i]) ||
    new Set(selectedFrameIds).size !== selectedFrameIds.length
  ) {
    throw new CliError(
      'INPUT_INVALID',
      'frozen_inputs.selected_frames does not match evidence-set.selected_frame_ids',
      2,
      'validate_input',
    );
  }
  if (
    evidenceSet.evidence_ids.length !== evidenceSet.evidence.length ||
    evidenceSet.evidence_ids.some((id, i) => id !== evidenceSet.evidence[i]?.id) ||
    new Set(evidenceSet.evidence_ids).size !== evidenceSet.evidence_ids.length
  ) {
    throw new CliError(
      'INPUT_INVALID',
      'evidence-set.evidence_ids does not match evidence item ids',
      2,
      'validate_input',
    );
  }

  const framesMeta = ((manifest['media'] as Record<string, unknown> | undefined)?.['frames'] ?? []) as Array<{
    frame_id: string;
    path: string;
    sha256: string;
    timestamp_ms: number;
  }>;
  const metaById = new Map<string, (typeof framesMeta)[number]>();
  for (const frame of framesMeta) {
    if (metaById.has(frame.frame_id)) {
      throw new CliError('INPUT_INVALID', `duplicate frame record for ${frame.frame_id}`, 2, 'validate_input');
    }
    metaById.set(frame.frame_id, frame);
  }
  const selectedMeta = frozenInputs.selected_frames.map((frozenFrame) => {
    const meta = metaById.get(frozenFrame.frame_id);
    if (!meta) {
      throw new CliError(
        'INPUT_INVALID',
        `selected frame ${frozenFrame.frame_id} missing from manifest.media.frames`,
        2,
        'validate_input',
      );
    }
    if (meta.timestamp_ms !== frozenFrame.timestamp_ms) {
      hashMismatch(`frame ${frozenFrame.frame_id} timestamp`);
    }
    resolveInside(opts.fromDir, meta.path);
    return meta;
  });

  const transcriptSha256 = await hashSourceFile(path.join(opts.fromDir, 'transcript.json'), 'transcript.json');
  if (transcriptSha256 !== frozenInputs.transcript_sha256) {
    hashMismatch('transcript.json');
  }
  const evidenceSetSha256 = await hashSourceFile(path.join(opts.fromDir, 'evidence-set.json'), 'evidence-set.json');
  if (evidenceSetSha256 !== frozenInputs.evidence_set_sha256) {
    hashMismatch('evidence-set.json');
  }
  const configSnapshotSha256 = await hashSourceFile(
    path.join(opts.fromDir, 'config.snapshot.json'),
    'config.snapshot.json',
  );
  if (configSnapshotSha256 !== frozenInputs.config_snapshot_sha256) {
    hashMismatch('config.snapshot.json');
  }
  const rubricSnapshotSha256 = await hashSourceFile(
    path.join(opts.fromDir, 'rubric.snapshot.json'),
    'rubric.snapshot.json',
  );
  if (rubricSnapshotSha256 !== frozenInputs.rubric_snapshot_sha256) {
    hashMismatch('rubric.snapshot.json');
  }
  for (const [i, frame] of selectedMeta.entries()) {
    const actual = await hashSourceFile(resolveInside(opts.fromDir, frame.path), `frame ${frame.frame_id}`);
    if (actual !== frame.sha256 || actual !== frozenInputs.selected_frames[i]!.sha256) {
      hashMismatch(`frame ${frame.frame_id}`);
    }
  }

  for (const [key, prompt] of Object.entries(configSnap.effective.prompts)) {
    const actual = await hashSourceFile(resolveInside(opts.fromDir, prompt.path), `prompt ${key}`);
    if (actual !== prompt.sha256 || actual !== frozenInputs.prompt_hashes[key as keyof typeof frozenInputs.prompt_hashes]) {
      hashMismatch(`prompt ${key}`);
    }
  }

  // Config for judge entry: re-derive from the snapshot's effective config.
  const effective = configSnap.effective as unknown as JudgeConfig;
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

  const judgePromptRel = configSnap.effective.prompts.judge;
  const judgePromptText = await fs.readFile(resolveInside(opts.fromDir, judgePromptRel.path), 'utf8');
  let judgePrompt = {
    version: judgeEntry.prompt_version,
    path: judgePromptRel.path,
    sha256: judgePromptRel.sha256,
    text: judgePromptText,
  };

  const currentJudgeSchemaSha256 = judgeSchemaSha256();
  if (currentJudgeSchemaSha256 !== frozenInputs.judge_schema_sha256) {
    hashMismatch('judge schema');
  }
  const frozenPromptHashes = frozenInputs.prompt_hashes;
  let inputHash = computeInputHash({
    hash_version: frozenInputs.hash_version,
    transcript_sha256: transcriptSha256,
    evidence_set_sha256: evidenceSetSha256,
    config_snapshot_sha256: configSnapshotSha256,
    rubric_snapshot_sha256: rubricSnapshotSha256,
    selected_frames: frozenInputs.selected_frames.map((frame) => ({
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      sha256: frame.sha256,
    })),
    prompt_hashes: frozenPromptHashes,
    judge_schema_sha256: currentJudgeSchemaSha256,
    review_flags_extra: frozenInputs.review_flags_extra,
  });
  if (inputHash !== frozenInputs.input_hash) hashMismatch('composite input_hash');

  // Evaluation-only output-language comparison (§41.6 language-diff
  // procedure): the frozen prompt is stored post-substitution, so the
  // template is loaded from promptsDir and re-substituted with the frozen
  // config's output_language — its sha256 must equal the frozen judge prompt
  // hash (proof it is the same template) — then re-substituted with the
  // target language. input_hash is recomputed with the new judge hash.
  let outputLanguageCompare: { from: string; to: string } | undefined;
  if (opts.outputLanguage !== undefined) {
    let targetLang: string;
    try {
      targetLang = Intl.getCanonicalLocales(opts.outputLanguage)[0]!;
    } catch {
      throw new CliError(
        'INVALID_LANGUAGE',
        `--output-language '${opts.outputLanguage}' is not a valid BCP 47 tag`,
        2,
        'validate_input',
      );
    }
    if (opts.promptsDir === undefined) {
      throw new CliError(
        'INVALID_ARGS',
        '--output-language requires --prompts-dir to load the judge prompt template',
        2,
        'validate_input',
      );
    }
    let frozenLang: string;
    try {
      frozenLang = Intl.getCanonicalLocales(config.output_language)[0]!;
    } catch {
      throw new CliError(
        'CONFIG_INVALID',
        `config output_language '${config.output_language}' is not a valid BCP 47 tag`,
        2,
        'validate_input',
      );
    }
    const template = await loadPrompt(opts.promptsDir, judgeEntry.prompt_version);
    if (!template.text.includes('{{output_language}}')) {
      throw new CliError(
        'INPUT_INVALID',
        `judge prompt template '${template.version}' does not contain {{output_language}}; cannot perform output-language comparison`,
        2,
        'validate_input',
      );
    }
    const reproduced = sha256Hex(fillPrompt(template.text, { output_language: frozenLang }));
    if (reproduced !== frozenPromptHashes.judge) {
      throw new CliError(
        'INPUT_INVALID',
        `judge prompt '${judgeEntry.prompt_version}' under --prompts-dir does not reproduce the frozen judge prompt`,
        2,
        'validate_input',
      );
    }
    // Same normalized tag as the frozen run: behave exactly like a normal
    // repeat — no prompt substitution, no derived input_hash, no compare
    // metadata in the report.
    if (targetLang !== frozenLang) {
      const text = fillPrompt(template.text, { output_language: targetLang });
      judgePrompt = {
        version: template.version,
        path: template.path,
        sha256: sha256Hex(text),
        text,
      };
      inputHash = computeInputHash({
        hash_version: frozenInputs.hash_version,
        transcript_sha256: transcriptSha256,
        evidence_set_sha256: evidenceSetSha256,
        config_snapshot_sha256: configSnapshotSha256,
        rubric_snapshot_sha256: rubricSnapshotSha256,
        selected_frames: frozenInputs.selected_frames.map((frame) => ({
          frame_id: frame.frame_id,
          timestamp_ms: frame.timestamp_ms,
          sha256: frame.sha256,
        })),
        prompt_hashes: { ...frozenPromptHashes, judge: judgePrompt.sha256 },
        judge_schema_sha256: currentJudgeSchemaSha256,
        review_flags_extra: frozenInputs.review_flags_extra,
      });
      outputLanguageCompare = { from: frozenLang, to: targetLang };
      log(`[repeat] output_language compare: ${frozenLang} -> ${targetLang}`);
    }
  }

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
  const pricing = await loadPricing(opts.pricingPath).catch(() => null);
  const finishUsage = async (bestEffort: boolean): Promise<void> => {
    const write = async (): Promise<void> => {
      await writeJsonAtomic(
        path.join(opts.outDir, 'usage.json'),
        buildUsageReport(
          {
            mode: providerSet.mode,
            pricing: pricing
              ? {
                  path: pricing.path,
                  sha256: pricing.sha256,
                  valid_until: pricing.table.models[judgeEntry.model]?.valid_until ?? null,
                }
              : null,
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
      let childManifest: Record<string, unknown>;
      try {
        await fs.mkdir(childDir, { recursive: true });
        childManifest = {
          schema_version: 1,
          run_id: childRunId,
          source_run_id: manifest['run_id'],
          status: 'running',
          stage: 'judge',
          created_at: new Date().toISOString(),
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
        childManifest['status'] = 'failed';
        childManifest['error'] = { code: cliErr.code, message: cliErr.message };
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
            evidenceKinds: new Map(evidenceItems.map((e) => [e.id, e.kind])),
          },
          reviewFlagsExtra: normalizeReviewFlags(frozenInputs.review_flags_extra),
          extraInjectionSuspected: evidenceSet.injection_suspected === true,
          deadlineMs: Date.now() + CHILD_DEADLINE_MS,
          stage: 'judge',
          judgeRunId: newJudgeRunId(),
          phase: 'provisional',
          inputHash,
          evidenceSetId: evidenceSet.evidence_set_id,
          pitchId: String(manifest['pitch_id'] ?? ''),
          runId: childRunId,
          videoAbsent: selectedMeta.length === 0,
        });
        allAttempts.push(...res.attempts);
        const levels = new Map<string, string | null>();
        for (const c of (res.scorecard as { criteria: Array<{ criterion_id: string; aggregated_level: string | null }> }).criteria) {
          levels.set(c.criterion_id, c.aggregated_level);
        }
        try {
          await writeJsonAtomic(path.join(childDir, 'judge-run.json'), res.judgeRun);
          await writeJsonAtomic(path.join(childDir, 'scorecard.json'), res.scorecard);
          childManifest['status'] = 'completed';
          childManifest['stage'] = 'completed';
          await writeJsonAtomic(path.join(childDir, 'manifest.json'), childManifest);
        } catch (err) {
          // Artifact persistence failed, not the judge call: revert the
          // tentative completed state so the failed manifest records where
          // the run actually stopped.
          childManifest['status'] = 'running';
          childManifest['stage'] = 'judge';
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
        // attempts, attached by runJudgeStage/callWithAttempts) into usage.json.
        const partial = (err as { attempts?: AttemptRecord[] }).attempts ?? [];
        allAttempts.push(...partial);
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
      sourceRunId: String(manifest['run_id'] ?? ''),
      inputHash,
      mode: opts.providerMode,
      runs,
      criterionIds,
      perRunLevels,
      ...(outputLanguageCompare !== undefined
        ? { sourceInputHash: frozenInputs.input_hash, outputLanguageCompare }
        : {}),
    });
    const reportPath = path.join(opts.outDir, 'repeat-report.json');
    await writeJsonAtomic(reportPath, report);
    await finishUsage(false);

    return { status: report['status'] as 'pass' | 'fail' | 'not_evaluated', reportPath };
  } catch (err) {
    await finishUsage(true);
    throw err;
  }
}
