import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { CliError } from '../core/errors.js';
import {
  newEvidenceId,
  newEvidenceSetId,
  newFrameId,
  newJudgeRunId,
  newMediaId,
  newPitchId,
  newRunId,
  newTranscriptSegmentId,
  newTranscriptVersionId,
} from '../core/ids.js';
import { validateConfig, type JudgeConfig } from '../core/schemas/config.js';
import { validateRubric, type Rubric } from '../core/schemas/rubric.js';
import {
  evidenceJsonSchema,
  rawScoreJsonSchema,
  transcriptJsonSchema,
  type TranscriptOutput,
  type EvidenceOutput,
  type RawScoreOutput,
} from '../core/schemas/provider-outputs.js';
import {
  validateEvidenceOutput,
  validateScoreOutput,
  validateTranscriptOutput,
} from '../core/reference-validation.js';
import {
  capCandidates,
  dedupeCandidates,
  selectJudgeFrames,
  type FrameCandidate,
} from '../core/frame-selection.js';
import { callWithAttempts, type AttemptRecord } from '../core/retry.js';
import {
  fileExists,
  isAbsentOrEmptyDir,
  sha256File,
  sha256Hex,
  writeJsonAtomic,
  writeTextAtomic,
} from '../core/storage.js';
import { aggregateScores } from '../core/aggregation.js';
import { buildUsageReport, loadPricing, type PricingTable } from '../core/usage.js';
import { selectAuditSample } from '../core/evidence-audit.js';
import { validateMediaFile } from '../media/media-validation.js';
import { extractAudio, extractFrames, ffmpegVersion } from '../media/ffmpeg.js';
import { ffprobeVersion } from '../media/ffprobe.js';
import { phashFromGray32, phashToHex, PHASH_IMPLEMENTATION } from '../media/phash.js';
import type { ProviderSet, TranscriptSegment } from '../providers/types.js';
import { FixtureExtractor, FixtureJudge, FixtureTranscriber } from '../providers/fixture/index.js';
import {
  GoogleEvidenceExtractor,
  GoogleJudge,
  GoogleTranscriber,
} from '../providers/google/index.js';

const RUN_DEADLINE_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;

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

interface PromptRef {
  version: string;
  path: string;
  sha256: string;
  text: string;
}

export interface JudgeStageResult {
  judgeRun: Record<string, unknown>;
  scorecard: Record<string, unknown>;
  attempts: AttemptRecord[];
  rawTexts: Array<{ sample: number; attempt: number; file: string }>;
}

function fillPrompt(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

async function loadPrompt(promptsDir: string, version: string): Promise<PromptRef> {
  const p = path.join(promptsDir, `${version}.md`);
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch {
    throw new CliError('CONFIG_INVALID', `prompt '${version}' not found at ${p}`, 2, 'validate_input');
  }
  return { version, path: p, sha256: sha256Hex(text), text };
}

export async function loadInputs(opts: RunOptions): Promise<{
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
    throw new CliError('CONFIG_INVALID', `rubric not readable: ${opts.rubricPath}`, 2, 'validate_input');
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

export function buildProviders(
  opts: RunOptions,
  config: JudgeConfig,
  resolvers: {
    transcriptIds: () => string[];
    inputFrameIds: () => string[];
    evidenceIds: () => string[];
  },
): ProviderSet {
  if (opts.providerMode === 'fixture') {
    return {
      mode: 'fixture',
      transcriber: new FixtureTranscriber(opts.fixtureDir),
      extractor: new FixtureExtractor(opts.fixtureDir, resolvers.transcriptIds),
      judge: new FixtureJudge(
        opts.fixtureDir,
        resolvers.evidenceIds,
        resolvers.transcriptIds,
        resolvers.inputFrameIds,
      ),
    };
  }
  const apiKey = process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new CliError(
      'MISSING_CREDENTIALS',
      'GOOGLE_API_KEY environment variable is required for --provider-mode live',
      3,
      'validate_input',
    );
  }
  const g = { apiKey };
  return {
    mode: 'live',
    transcriber: new GoogleTranscriber(config.transcriber, g),
    extractor: new GoogleEvidenceExtractor(config.evidence_extractor, g),
    judge: new GoogleJudge(config.judges[0]!, g),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runJudgeStage(opts: {
  outDir: string;
  judge: ProviderSet['judge'];
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
  };
  reviewFlagsExtra: string[];
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
  const samples: unknown[] = [];

  for (let sampleIndex = 0; sampleIndex < 3; sampleIndex++) {
    const res = await callWithAttempts<RawScoreOutput>(
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
        }),
    );
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
  });

  const judgeRun = {
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

  const scorecard = {
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

export async function cmdRun(opts: RunOptions): Promise<{
  runId: string;
  outDir: string;
  scorecard: Record<string, unknown>;
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

  let transcriptIds: string[] = [];
  let inputFrameIds: string[] = [];
  let evidenceIds: string[] = [];
  const providers = buildProviders(opts, config, {
    transcriptIds: () => transcriptIds,
    inputFrameIds: () => inputFrameIds,
    evidenceIds: () => evidenceIds,
  });
  if (opts.providerMode === 'fixture' && !(await fileExists(opts.fixtureDir))) {
    throw new CliError('FIXTURE_NOT_FOUND', `fixture dir not found: ${opts.fixtureDir}`, 2, 'validate_input');
  }

  const prompts: Record<'transcriber' | 'extractor' | 'judge', PromptRef> = {
    transcriber: await loadPrompt(opts.promptsDir, config.transcriber.prompt_version),
    extractor: await loadPrompt(opts.promptsDir, config.evidence_extractor.prompt_version),
    judge: await loadPrompt(opts.promptsDir, config.judges[0]!.prompt_version),
  };
  prompts.extractor.text = fillPrompt(prompts.extractor.text, { output_language: outputLanguage });
  prompts.extractor.sha256 = sha256Hex(prompts.extractor.text);
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
  const manifest: Record<string, unknown> = {
    schema_version: 1,
    run_id: runId,
    pitch_id: pitchId,
    status: 'running',
    stage: 'prepare_output',
    created_at: new Date().toISOString(),
  };
  const fail = async (stage: string, err: CliError): Promise<never> => {
    manifest['status'] = 'failed';
    manifest['stage'] = stage;
    manifest['error'] = { code: err.code, message: err.message };
    await writeJsonAtomic(manifestPath, manifest);
    throw err;
  };

  try {
    // Stage: media
    log('[media] probing media');
    const media = await validateMediaFile(opts.video);
    const durationMs = media.probe.durationMs;
    const inputSha = await sha256File(opts.video);
    const ffprobeVer = await ffprobeVersion();
    const ffmpegVer = await ffmpegVersion();

    const mediaDir = path.join(outDir, 'media');
    const framesDir = path.join(mediaDir, 'frames');
    await fs.mkdir(framesDir, { recursive: true });

    const audioRel = 'media/audio.wav';
    const audioArgs = await extractAudio(opts.video, path.join(outDir, audioRel));

    const frames: Array<{
      frame_id: string;
      timestamp_ms: number;
      path: string;
      byte_size: number;
      sha256: string;
      width: number | null;
      height: number | null;
      phash: string;
      source: string;
    }> = [];
    const candidates: FrameCandidate[] = [];
    let jpegArgs: string[] = [];
    let grayArgs: string[] = [];
    if (media.hasVideo) {
      const grayPath = path.join(mediaDir, 'frames.gray32');
      const r = await extractFrames(opts.video, framesDir, grayPath);
      jpegArgs = r.jpegArgs;
      grayArgs = r.grayArgs;
      const grayBuf = await fs.readFile(grayPath);
      const frameFiles = (await fs.readdir(framesDir))
        .filter((f) => f.endsWith('.jpg'))
        .sort();
      const nGray = Math.floor(grayBuf.length / 1024);
      const count = Math.min(frameFiles.length, nGray);
      for (let i = 0; i < count; i++) {
        const ts = i * 1000;
        if (ts >= durationMs) break; // drop frames at/after end of media
        const fname = frameFiles[i]!;
        const abs = path.join(framesDir, fname);
        const buf = await fs.readFile(abs);
        const ph = phashFromGray32(grayBuf.subarray(i * 1024, (i + 1) * 1024));
        const frameId = newFrameId();
        const vstream = media.probe.streams.find((s) => s.codec_type === 'video');
        frames.push({
          frame_id: frameId,
          timestamp_ms: ts,
          path: path.join('media/frames', fname),
          byte_size: buf.length,
          sha256: sha256Hex(buf),
          width: vstream?.width ?? null,
          height: vstream?.height ?? null,
          phash: phashToHex(ph),
          source: opts.videoSource,
        });
        candidates.push({
          frame_id: frameId,
          timestamp_ms: ts,
          phash: ph,
          source: opts.videoSource,
        });
      }
      await fs.rm(grayPath, { force: true });
    }

    const deduped = dedupeCandidates(candidates, config.frame_selection.dedupe_phash_distance);
    const inputFrames = capCandidates(deduped, config.frame_selection.max_extraction_frames);
    inputFrameIds = inputFrames.map((f) => f.frame_id);
    const reviewFlagsExtra: string[] = [];
    if (!media.hasVideo) reviewFlagsExtra.push('no_video_frames');

    manifest['input'] = {
      path: path.basename(opts.video),
      sha256: inputSha,
      byte_size: media.sizeBytes,
      duration_ms: durationMs,
      format_name: media.probe.formatName,
    };
    manifest['video_track'] = media.hasVideo;
    manifest['media'] = {
      audio: {
        path: audioRel,
        mime: 'audio/wav',
        byte_size: (await fs.stat(path.join(outDir, audioRel))).size,
        sha256: await sha256File(path.join(outDir, audioRel)),
      },
      frames,
      video_source: opts.videoSource,
      ffmpeg: { version: ffmpegVer, audio_args: audioArgs, frame_args: jpegArgs, gray_args: grayArgs },
      ffprobe_version: ffprobeVer,
    };
    manifest['stage'] = 'media_done';
    await writeJsonAtomic(manifestPath, manifest);

    // Stage: transcript
    log('[transcript] transcribing');
    const transcriptPromptText = fillPrompt(
      (await loadPrompt(opts.promptsDir, config.transcriber.prompt_version)).text,
      { duration_ms: String(durationMs) },
    );
    prompts.transcriber.text = transcriptPromptText;
    prompts.transcriber.sha256 = sha256Hex(transcriptPromptText);

    const transcriptRes = await callWithAttempts<TranscriptOutput>(
      {
        operation: 'transcript',
        sampleIndex: null,
        maxAttempts: MAX_ATTEMPTS,
        sleep,
        now: () => Date.now(),
        deadlineMs,
        stage: 'transcript',
        saveRaw: async (rec) => {
          const name = `transcript-a${rec.attempt_index}.json`;
          await writeJsonAtomic(path.join(outDir, 'attempts', name), rec);
          return path.join('attempts', name);
        },
      },
      (repairFeedback) =>
        providers.transcriber.transcribe({
          audioPath: path.join(outDir, audioRel),
          durationMs,
          promptText: transcriptPromptText,
          schema: transcriptJsonSchema,
          ...(repairFeedback !== undefined ? { repairFeedback } : {}),
        }),
      (parsed) => validateTranscriptOutput(parsed, durationMs),
    );

    const segments: TranscriptSegment[] = transcriptRes.value.segments.map((s) => ({
      id: newTranscriptSegmentId(),
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      text: s.text,
      asr_confidence: s.confidence,
    }));
    transcriptIds = segments.map((s) => s.id);
    const transcriptVersionId = newTranscriptVersionId();
    const recordedMediaId = newMediaId();
    const transcriptJson = {
      schema_version: 1,
      transcript_version_id: transcriptVersionId,
      recorded_media_id: recordedMediaId,
      language: transcriptRes.value.language ?? 'und',
      segments,
      provider: {
        model: config.transcriber.model,
        model_version: transcriptRes.result.modelVersion,
      },
      prompt_sha256: prompts.transcriber.sha256,
    };

    const nonBlank = segments.filter((s) => s.text.trim().length > 0);
    if (nonBlank.length === 0) {
      await writeJsonAtomic(path.join(outDir, 'transcript.json'), transcriptJson);
      await writeJsonAtomic(path.join(outDir, 'usage.json'), usageDoc(providers, [transcriptRes.attempts], config, pricing));
      throw new CliError(
        'NO_TRANSCRIPT',
        'transcript has no intelligible segments; cannot proceed to judging',
        5,
        'transcript',
      );
    }
    await writeJsonAtomic(path.join(outDir, 'transcript.json'), transcriptJson);
    manifest['stage'] = 'transcript_done';
    await writeJsonAtomic(manifestPath, manifest);

    // Stage: evidence
    log('[evidence] extracting evidence');
    const evRes = await callWithAttempts<EvidenceOutput>(
      {
        operation: 'evidence',
        sampleIndex: null,
        maxAttempts: MAX_ATTEMPTS,
        sleep,
        now: () => Date.now(),
        deadlineMs,
        stage: 'evidence',
        saveRaw: async (rec) => {
          const name = `evidence-a${rec.attempt_index}.json`;
          await writeJsonAtomic(path.join(outDir, 'attempts', name), rec);
          return path.join('attempts', name);
        },
      },
      (repairFeedback) =>
        providers.extractor.extract({
          promptText: prompts.extractor.text,
          transcriptSegments: segments,
          ...(repairFeedback !== undefined ? { repairFeedback } : {}),
          frames: inputFrames.map((f) => ({
            frameId: f.frame_id,
            timestampMs: f.timestamp_ms,
            path: path.join(outDir, frames.find((x) => x.frame_id === f.frame_id)!.path),
          })),
          rubricCriteria: rubric.criteria.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
          })),
          schema: evidenceJsonSchema,
        }),
      (parsed) =>
        validateEvidenceOutput(parsed, {
          transcriptIds: new Set(transcriptIds),
          inputFrameIds: new Set(inputFrameIds),
          criterionIds: new Set(rubric.criteria.map((c) => c.id)),
        }),
    );

    const evidenceItems = evRes.value.evidence.map((e) => ({
      id: newEvidenceId(),
      kind: e.kind,
      description: e.description,
      sources: e.sources,
      criterion_hints: e.criterion_hints,
    }));
    evidenceIds = evidenceItems.map((e) => e.id);

    // Judge frame selection (needs validated evidence)
    const selection = selectJudgeFrames(
      inputFrames,
      evidenceItems.map((e) => ({
        id: e.id,
        sourceIds: e.sources.filter((s) => s.type === 'frame').map((s) => s.id),
      })),
      config.frame_selection.max_frames_per_pitch,
    );
    if (selection.frame_reference_overflow) reviewFlagsExtra.push('frame_reference_overflow');
    const selectedFrames = frames.filter((f) => selection.selected_frame_ids.includes(f.frame_id));

    const evidenceSetId = newEvidenceSetId();
    const injectionSourceRefs = evRes.value.injection_suspected
      ? evidenceItems.flatMap((e) => e.sources)
      : [];
    const evidenceSetJson = {
      schema_version: 1,
      evidence_set_id: evidenceSetId,
      pitch_id: pitchId,
      run_id: runId,
      status: 'frozen',
      extractor: {
        provider: config.evidence_extractor.provider,
        model: config.evidence_extractor.model,
        prompt_version: config.evidence_extractor.prompt_version,
      },
      recorded_media_id: recordedMediaId,
      transcript_version_id: transcriptVersionId,
      config_version_id: config.id,
      rubric_version_id: `${rubric.id}:${rubricSha.slice(0, 16)}`,
      input_frame_ids: selection.input_frame_ids,
      selected_frame_ids: selection.selected_frame_ids,
      frame_reference_overflow: selection.frame_reference_overflow,
      evidence: evidenceItems,
      evidence_ids: evidenceIds,
      injection_suspected: evRes.value.injection_suspected,
      injection_source_refs: injectionSourceRefs,
      prompt_sha256: prompts.extractor.sha256,
      created_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(outDir, 'evidence-set.json'), evidenceSetJson);
    manifest['stage'] = 'evidence_done';
    await writeJsonAtomic(manifestPath, manifest);

    // Stage: judge
    log('[judge] scoring (3 samples)');
    const evidenceForPrompt = {
      evidence: evidenceItems.map((e) => ({
        ...e,
        unshown_source_ids: selection.unshown_source_ids[e.id] ?? [],
      })),
    };
    const inputHash = sha256Hex(
      [
        sha256Hex(stableStringify(transcriptJson)),
        sha256Hex(stableStringify(evidenceSetJson)),
        ...selectedFrames.map((f) => f.sha256),
        rubricSha,
        configSha,
        prompts.judge.sha256,
      ].join('\n'),
    );

    const judgeRunId = newJudgeRunId();
    const judgeRes = await runJudgeStage({
      outDir,
      judge: providers.judge,
      judgeEntry: config.judges[0]!,
      prompt: prompts.judge,
      rubric,
      evidenceForPrompt,
      transcriptSegments: segments,
      selectedFrames: selectedFrames.map((f) => ({
        frame_id: f.frame_id,
        timestamp_ms: f.timestamp_ms,
        path: path.join(outDir, f.path),
      })),
      validationCtx: {
        evidenceIds: new Set(evidenceIds),
        transcriptIds: new Set(transcriptIds),
        selectedFrameIds: new Set(selection.selected_frame_ids),
      },
      reviewFlagsExtra,
      deadlineMs,
      stage: 'judge',
      judgeRunId,
      phase: 'provisional',
      inputHash,
      evidenceSetId,
      pitchId,
      runId,
      videoAbsent: !media.hasVideo,
    });

    await writeJsonAtomic(path.join(outDir, 'judge-run.json'), judgeRes.judgeRun);
    await writeJsonAtomic(path.join(outDir, 'scorecard.json'), judgeRes.scorecard);
    manifest['stage'] = 'judge_done';
    await writeJsonAtomic(manifestPath, manifest);

    // Stage: finalize
    log('[finalize] writing snapshots and manifest');
    const promptsOutDir = path.join(outDir, 'prompts');
    for (const p of Object.values(prompts)) {
      await writeTextAtomic(path.join(promptsOutDir, `${p.version}.md`), p.text);
    }
    const configSnapshot = {
      schema_version: 1,
      config_id: config.id,
      config_sha256: configSha,
      effective: {
        ...config,
        phash: { implementation: PHASH_IMPLEMENTATION },
        sampling: { fps: 1, max_long_edge: 1280, format: 'jpeg' },
        prompts: {
          transcriber: { path: `prompts/${prompts.transcriber.version}.md`, version: prompts.transcriber.version, sha256: prompts.transcriber.sha256 },
          evidence_extractor: { path: `prompts/${prompts.extractor.version}.md`, version: prompts.extractor.version, sha256: prompts.extractor.sha256 },
          judge: { path: `prompts/${prompts.judge.version}.md`, version: prompts.judge.version, sha256: prompts.judge.sha256 },
        },
        provider_mode: providers.mode,
      },
    };
    const rubricSnapshot = {
      schema_version: 1,
      rubric_version_id: `${rubric.id}:${rubricSha.slice(0, 16)}`,
      rubric_sha256: rubricSha,
      rubric,
    };
    await writeJsonAtomic(path.join(outDir, 'config.snapshot.json'), configSnapshot);
    await writeJsonAtomic(path.join(outDir, 'rubric.snapshot.json'), rubricSnapshot);

    const allAttempts = [
      ...transcriptRes.attempts,
      ...evRes.attempts,
      ...judgeRes.attempts,
    ];
    await writeJsonAtomic(
      path.join(outDir, 'usage.json'),
      usageDoc(providers, allAttempts, config, pricing),
    );

    const auditIds = selectAuditSample(evidenceIds);
    await writeJsonAtomic(path.join(outDir, 'evidence-audit.json'), {
      schema_version: 1,
      seed: 'evidence-audit-v1',
      selected_ids: auditIds,
      total: evidenceIds.length,
      status: evidenceIds.length === 0 ? 'na' : 'pending_human_review',
      reviews: [],
    });

    manifest['artifacts'] = {
      transcript: 'transcript.json',
      evidence_set: 'evidence-set.json',
      judge_run: 'judge-run.json',
      scorecard: 'scorecard.json',
      usage: 'usage.json',
      evidence_audit: 'evidence-audit.json',
      config_snapshot: 'config.snapshot.json',
      rubric_snapshot: 'rubric.snapshot.json',
    };
    manifest['status'] = 'completed';
    manifest['stage'] = 'completed';
    manifest['completed_at'] = new Date().toISOString();
    await writeJsonAtomic(manifestPath, manifest);

    return { runId, outDir, scorecard: judgeRes.scorecard };
  } catch (err) {
    if (err instanceof CliError) {
      await fail(err.stage, err);
    }
    throw err;
  }
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v);
}

function usageDoc(
  providers: ProviderSet,
  attemptGroups: AttemptRecord[][] | AttemptRecord[],
  config: JudgeConfig,
  pricing: { table: PricingTable; sha256: string; path: string } | null,
): Record<string, unknown> {
  const flat: AttemptRecord[] = Array.isArray(attemptGroups[0])
    ? (attemptGroups as AttemptRecord[][]).flat()
    : (attemptGroups as AttemptRecord[]);
  return buildUsageReport(
    {
      mode: providers.mode,
      pricing: pricing
        ? {
            path: pricing.path,
            sha256: pricing.sha256,
            valid_until: pricing.table.models[config.judges[0]!.model]?.valid_until ?? null,
          }
        : null,
      attempts: flat,
      model: config.judges[0]!.model,
    },
    pricing?.table ?? null,
  );
}
