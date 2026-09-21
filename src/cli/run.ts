import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { CliError } from '../core/errors.js';
import { newJudgeRunId, newPitchId, newRunId } from '../core/ids.js';
import { validateConfig, type JudgeConfig } from '../core/schemas/config.js';
import { validateRubric, type Rubric } from '../core/schemas/rubric.js';
import { FailedAttemptError, type AttemptRecord } from '../core/retry.js';
import {
  fileExists,
  isAbsentOrEmptyDir,
  sha256File,
  sha256Hex,
  writeJsonAtomic,
} from '../core/storage.js';
import { buildUsageReport, loadPricing, pricingRef } from '../core/usage.js';
import { selectAuditSample } from '../core/evidence-audit.js';
import {
  fillPrompt,
  loadPrompt,
  runJudgeStage,
  type PromptRef,
  type ScorecardDocument,
} from './judge-stage.js';
import { buildProviders } from './providers.js';
import {
  extractEvidence,
  freezeInputs,
  prepareMedia,
  transcribe,
  type RunContext,
  type RunManifest,
} from './run-stages.js';

const RUN_DEADLINE_MS = 30 * 60 * 1000;

export interface RunOptions {
  video: string;
  rubricPath: string;
  configPath: string;
  outDir: string;
  outputLanguage?: string;
  providerMode: 'fixture' | 'live';
  fixtureDir: string;
  videoSource: 'screen' | 'camera';
  promptsDir: string;
  pricingPath: string;
  log?: (line: string) => void;
}

async function loadInputs(opts: RunOptions): Promise<{
  config: JudgeConfig;
  rubric: Rubric;
  configSha: string;
  rubricSha: string;
  outputLanguage: string;
}> {
  const configSha = await sha256File(opts.configPath).catch(() => {
    throw new CliError('CONFIG_INVALID', `config not readable: ${opts.configPath}`, 2, 'validate_input');
  });
  const rubricSha = await sha256File(opts.rubricPath).catch(() => {
    throw new CliError('RUBRIC_INVALID', `rubric not readable: ${opts.rubricPath}`, 2, 'validate_input');
  });

  let rawConfig: unknown;
  let rawRubric: unknown;
  try {
    rawConfig = parseYaml(await fs.readFile(opts.configPath, 'utf8'));
  } catch (e) {
    throw new CliError('CONFIG_INVALID', `config YAML parse failed: ${e}`, 2, 'validate_input');
  }
  try {
    rawRubric = parseYaml(await fs.readFile(opts.rubricPath, 'utf8'));
  } catch (e) {
    throw new CliError('RUBRIC_INVALID', `rubric YAML parse failed: ${e}`, 2, 'validate_input');
  }

  const cfg = validateConfig(rawConfig);
  if (!cfg.ok) {
    throw new CliError('CONFIG_INVALID', cfg.errors.join('; '), 2, 'validate_input');
  }
  const rub = validateRubric(rawRubric);
  if (!rub.ok) {
    throw new CliError('RUBRIC_INVALID', rub.errors.join('; '), 2, 'validate_input');
  }

  // Language: --output-language must equal the config value after BCP 47
  // canonicalization; omitted -> use config value.
  let outputLanguage: string;
  try {
    outputLanguage = Intl.getCanonicalLocales(cfg.config.output_language)[0]!;
  } catch {
    throw new CliError(
      'INVALID_LANGUAGE',
      `config output_language '${cfg.config.output_language}' is not a valid BCP 47 tag`,
      2,
      'validate_input',
    );
  }
  if (opts.outputLanguage !== undefined) {
    let cliLang: string;
    try {
      cliLang = Intl.getCanonicalLocales(opts.outputLanguage)[0]!;
    } catch {
      throw new CliError(
        'INVALID_LANGUAGE',
        `--output-language '${opts.outputLanguage}' is not a valid BCP 47 tag`,
        2,
        'validate_input',
      );
    }
    if (cliLang !== outputLanguage) {
      throw new CliError(
        'CONFIG_LANGUAGE_CONFLICT',
        `--output-language '${cliLang}' differs from config output_language '${outputLanguage}'`,
        2,
        'validate_input',
      );
    }
  }

  return { config: cfg.config, rubric: rub.rubric, configSha, rubricSha, outputLanguage };
}

/**
 * `run` sequencer: validate inputs, then media -> transcript -> evidence ->
 * freeze -> judge -> finalize. Stages live in run-stages.ts / judge-stage.ts;
 * this function owns the deadline, the manifest, failure recording and
 * usage.json.
 */
export async function cmdRun(opts: RunOptions): Promise<{
  runId: string;
  outDir: string;
  scorecard: ScorecardDocument;
}> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const startedAt = Date.now();
  const deadlineMs = startedAt + RUN_DEADLINE_MS;
  const runId = newRunId();
  const pitchId = newPitchId();

  // Stage: validate_input (before touching the output dir)
  log('[validate_input] validating config, rubric, args');
  if (!(await fileExists(opts.video))) {
    throw new CliError('INVALID_MEDIA', `video not found: ${opts.video}`, 2, 'validate_input');
  }
  const inputs = await loadInputs(opts);
  const { config, rubric, configSha, rubricSha, outputLanguage } = inputs;

  const ids = {
    transcriptIds: [] as string[],
    inputFrameIds: [] as string[],
    evidenceIds: [] as string[],
  };
  const providers = buildProviders(opts, config, {
    transcriptIds: () => ids.transcriptIds,
    inputFrameIds: () => ids.inputFrameIds,
    evidenceIds: () => ids.evidenceIds,
  });
  if (opts.providerMode === 'fixture' && !(await fileExists(opts.fixtureDir))) {
    throw new CliError('FIXTURE_NOT_FOUND', `fixture dir not found: ${opts.fixtureDir}`, 2, 'validate_input');
  }

  const prompts: Record<'transcriber' | 'evidence_extractor' | 'judge', PromptRef> = {
    transcriber: await loadPrompt(opts.promptsDir, config.transcriber.prompt_version),
    evidence_extractor: await loadPrompt(opts.promptsDir, config.evidence_extractor.prompt_version),
    judge: await loadPrompt(opts.promptsDir, config.judges[0]!.prompt_version),
  };
  prompts.evidence_extractor.text = fillPrompt(prompts.evidence_extractor.text, {
    output_language: outputLanguage,
    video_source: opts.videoSource,
  });
  prompts.evidence_extractor.sha256 = sha256Hex(prompts.evidence_extractor.text);
  prompts.judge.text = fillPrompt(prompts.judge.text, { output_language: outputLanguage });
  prompts.judge.sha256 = sha256Hex(prompts.judge.text);

  const pricing = await loadPricing(opts.pricingPath).catch(() => null);

  // Stage: prepare_output
  log('[prepare_output] checking output dir');
  if (!(await isAbsentOrEmptyDir(opts.outDir))) {
    throw new CliError(
      'OUTPUT_DIR_NOT_EMPTY',
      `output dir exists and is not empty: ${opts.outDir}`,
      2,
      'prepare_output',
    );
  }
  await fs.mkdir(opts.outDir, { recursive: true });

  const outDir = opts.outDir;
  const manifestPath = path.join(outDir, 'manifest.json');
  const manifest: RunManifest = {
    schema_version: 1,
    run_id: runId,
    pitch_id: pitchId,
    status: 'running',
    stage: 'prepare_output',
    created_at: new Date().toISOString(),
  };
  const fail = async (stage: string, err: CliError): Promise<never> => {
    manifest.status = 'failed';
    manifest.stage = stage;
    manifest.error = { code: err.code, message: err.message };
    delete manifest.completed_at;
    try {
      await writeJsonAtomic(manifestPath, manifest);
    } catch {
      // Best-effort: a failed-manifest write must not mask the primary error.
    }
    throw err;
  };

  const ctx: RunContext = {
    opts,
    log,
    deadlineMs,
    runId,
    pitchId,
    outDir,
    config,
    rubric,
    configSha,
    rubricSha,
    outputLanguage,
    providers,
    prompts,
    pricing,
    manifest,
    manifestPath,
    completedAttempts: [],
    reviewFlagsExtra: [],
    ids,
  };

  const writeUsage = async (attempts: AttemptRecord[]): Promise<void> => {
    await writeJsonAtomic(
      path.join(outDir, 'usage.json'),
      buildUsageReport(
        {
          mode: providers.mode,
          pricing: pricingRef(pricing, config.judges[0]!.model),
          attempts,
          model: config.judges[0]!.model,
        },
        pricing?.table ?? null,
      ),
    );
  };

  try {
    const media = await prepareMedia(ctx);
    const transcript = await transcribe(ctx, media);
    const evidence = await extractEvidence(ctx, media, transcript);
    const frozen = await freezeInputs(ctx, transcript, evidence);

    // Stage: judge
    log('[judge] scoring (3 samples)');
    const judgeRes = await runJudgeStage({
      outDir,
      judge: providers.judge,
      judgeEntry: config.judges[0]!,
      prompt: prompts.judge,
      rubric,
      evidenceForPrompt: frozen.judgeEvidence,
      transcriptSegments: frozen.judgeSegments,
      selectedFrames: evidence.selectedFrames.map((f) => ({
        frame_id: f.frame_id,
        timestamp_ms: f.timestamp_ms,
        path: path.join(outDir, f.path),
      })),
      validationCtx: {
        evidenceIds: new Set(ids.evidenceIds),
        transcriptIds: new Set(ids.transcriptIds),
        selectedFrameIds: new Set(evidence.selection.selected_frame_ids),
        evidenceKinds: new Map(evidence.evidenceItems.map((e) => [e.id, e.kind])),
      },
      reviewFlagsExtra: ctx.reviewFlagsExtra,
      extraInjectionSuspected: evidence.injectionSuspected,
      deadlineMs,
      stage: 'judge',
      judgeRunId: newJudgeRunId(),
      phase: 'provisional',
      inputHash: frozen.inputHash,
      evidenceSetId: evidence.evidenceSetId,
      pitchId,
      runId,
      videoAbsent: !media.media.hasVideo,
    });

    ctx.completedAttempts.push(...judgeRes.attempts);
    await writeJsonAtomic(path.join(outDir, 'judge-run.json'), judgeRes.judgeRun);
    await writeJsonAtomic(path.join(outDir, 'scorecard.json'), judgeRes.scorecard);
    manifest.stage = 'judge_done';
    await writeJsonAtomic(manifestPath, manifest);

    // Stage: finalize
    log('[finalize] writing manifest');
    await writeUsage(ctx.completedAttempts);

    const auditIds = selectAuditSample(ids.evidenceIds);
    await writeJsonAtomic(path.join(outDir, 'evidence-audit.json'), {
      schema_version: 1,
      seed: 'evidence-audit-v1',
      selected_ids: auditIds,
      total: ids.evidenceIds.length,
      status: ids.evidenceIds.length === 0 ? 'na' : 'pending_human_review',
      reviews: [],
    });

    manifest.artifacts = {
      transcript: 'transcript.json',
      evidence_set: 'evidence-set.json',
      judge_run: 'judge-run.json',
      scorecard: 'scorecard.json',
      usage: 'usage.json',
      evidence_audit: 'evidence-audit.json',
      config_snapshot: 'config.snapshot.json',
      rubric_snapshot: 'rubric.snapshot.json',
    };
    manifest.status = 'completed';
    manifest.stage = 'completed';
    manifest.completed_at = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);

    return { runId, outDir, scorecard: judgeRes.scorecard };
  } catch (err) {
    // Persist usage for every attempt made so far, including the failed
    // call's attempts (carried by FailedAttemptError).
    const partial = err instanceof FailedAttemptError ? err.attempts : [];
    const recorded = [...ctx.completedAttempts, ...partial];
    if (recorded.length > 0) {
      try {
        await writeUsage(recorded);
      } catch {
        // never mask the real failure with a usage-write error
      }
    }
    const cliErr =
      err instanceof CliError
        ? err
        : Object.assign(
            new CliError(
              'INTERNAL_ERROR',
              err instanceof Error ? err.message : String(err),
              3,
              'internal',
            ),
            { cause: err },
          );
    return await fail(cliErr.stage, cliErr);
  }
}
