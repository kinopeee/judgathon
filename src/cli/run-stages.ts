import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import {
  newEvidenceId,
  newEvidenceSetId,
  newFrameId,
  newMediaId,
  newTranscriptSegmentId,
  newTranscriptVersionId,
} from '../core/ids.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import type { Rubric } from '../core/schemas/rubric.js';
import {
  evidenceJsonSchema,
  transcriptJsonSchema,
  type TranscriptOutput,
  type EvidenceOutput,
} from '../core/schemas/provider-outputs.js';
import {
  frozenInputsV2Schema,
  storedConfigSnapshotSchema,
  storedEvidenceSetSchema,
  storedRubricSnapshotSchema,
  storedTranscriptSchema,
  type FrozenInputsV2,
  type StoredEvidenceItem,
} from '../core/schemas/artifacts.js';
import {
  validateEvidenceOutput,
  validateTranscriptOutput,
} from '../core/reference-validation.js';
import {
  capCandidates,
  dedupeCandidates,
  selectJudgeFrames,
  type FrameCandidate,
  type FrameSelectionResult,
} from '../core/frame-selection.js';
import { callWithAttempts, type AttemptRecord } from '../core/retry.js';
import { computeInputHash, judgeSchemaSha256, normalizeReviewFlags } from '../core/input-hash.js';
import { sha256File, sha256Hex, writeJsonAtomic, writeTextAtomic } from '../core/storage.js';
import { buildUsageReport, pricingRef, type PricingFile } from '../core/usage.js';
import { validateMediaFile, type MediaValidationResult } from '../media/media-validation.js';
import { extractAudio, extractFrames, ffmpegVersion } from '../media/ffmpeg.js';
import { ffprobeVersion } from '../media/ffprobe.js';
import { phashFromGray32, phashToHex, PHASH_IMPLEMENTATION } from '../media/phash.js';
import type { ProviderSet, TranscriptSegment } from '../providers/types.js';
import {
  buildEvidenceForPrompt,
  fillPrompt,
  loadPrompt,
  maskJudgeInputs,
  type PromptRef,
} from './judge-stage.js';
import type { RunOptions } from './run.js';

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A frame record persisted under manifest.media.frames. */
export interface ManifestFrame {
  frame_id: string;
  timestamp_ms: number;
  path: string;
  byte_size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  phash: string;
  source: string;
}

/** manifest.json as `run` writes it — mutable, written without a Zod round-trip. */
export interface RunManifest {
  schema_version: number;
  run_id: string;
  pitch_id: string;
  status: string;
  stage: string;
  created_at: string;
  completed_at?: string;
  error?: { code: string; message: string };
  input?: {
    path: string;
    sha256: string;
    byte_size: number;
    duration_ms: number;
    format_name: string;
  };
  video_track?: boolean;
  media?: {
    audio: { path: string; mime: string; byte_size: number; sha256: string };
    frames: ManifestFrame[];
    video_source: string;
    ffmpeg: {
      version: string;
      audio_args: string[];
      frame_args: string[];
      gray_args: string[];
    };
    ffprobe_version: string;
  };
  frozen_inputs?: FrozenInputsV2;
  judge_input_mask?: { enabled: true; replacements: Record<string, string> };
  artifacts?: {
    transcript: string;
    evidence_set: string;
    judge_run: string;
    scorecard: string;
    usage: string;
    evidence_audit: string;
    config_snapshot: string;
    rubric_snapshot: string;
  };
}

/** Shared mutable state the stage functions read and extend. */
export interface RunContext {
  opts: RunOptions;
  log: (line: string) => void;
  deadlineMs: number;
  runId: string;
  pitchId: string;
  outDir: string;
  config: JudgeConfig;
  rubric: Rubric;
  configSha: string;
  rubricSha: string;
  outputLanguage: string;
  providers: ProviderSet;
  prompts: Record<'transcriber' | 'evidence_extractor' | 'judge', PromptRef>;
  pricing: PricingFile | null;
  manifest: RunManifest;
  manifestPath: string;
  /** Attempts already persisted — appended by each stage, read on failure. */
  completedAttempts: AttemptRecord[];
  reviewFlagsExtra: string[];
  /** Id lists read lazily by fixture-provider resolvers. */
  ids: {
    transcriptIds: string[];
    inputFrameIds: string[];
    evidenceIds: string[];
  };
}

export interface MediaStageResult {
  media: MediaValidationResult;
  durationMs: number;
  audioRel: string;
  frames: ManifestFrame[];
  inputFrames: FrameCandidate[];
}

/** media stage: probe, extract audio + frames, dedupe/cap candidates. */
export async function prepareMedia(ctx: RunContext): Promise<MediaStageResult> {
  const { opts, outDir, manifest, manifestPath } = ctx;
  ctx.log('[media] probing media');
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

  const frames: ManifestFrame[] = [];
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

  const deduped = dedupeCandidates(candidates, ctx.config.frame_selection.dedupe_phash_distance);
  const inputFrames = capCandidates(deduped, ctx.config.frame_selection.max_extraction_frames);
  ctx.ids.inputFrameIds = inputFrames.map((f) => f.frame_id);
  if (!media.hasVideo) ctx.reviewFlagsExtra.push('no_video_frames');

  manifest.input = {
    path: path.basename(opts.video),
    sha256: inputSha,
    byte_size: media.sizeBytes,
    duration_ms: durationMs,
    format_name: media.probe.formatName,
  };
  manifest.video_track = media.hasVideo;
  manifest.media = {
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
  manifest.stage = 'media_done';
  await writeJsonAtomic(manifestPath, manifest);

  return { media, durationMs, audioRel, frames, inputFrames };
}

export interface TranscriptStageResult {
  segments: TranscriptSegment[];
  transcriptVersionId: string;
  recordedMediaId: string;
}

/** transcript stage: transcribe audio, persist transcript.json. */
export async function transcribe(
  ctx: RunContext,
  media: MediaStageResult,
): Promise<TranscriptStageResult> {
  const { opts, outDir, config, manifest, manifestPath } = ctx;
  ctx.log('[transcript] transcribing');
  const transcriptPromptText = fillPrompt(
    (await loadPrompt(opts.promptsDir, config.transcriber.prompt_version)).text,
    { duration_ms: String(media.durationMs) },
  );
  ctx.prompts.transcriber.text = transcriptPromptText;
  ctx.prompts.transcriber.sha256 = sha256Hex(transcriptPromptText);

  const transcriptRes = await callWithAttempts<TranscriptOutput>(
    {
      operation: 'transcript',
      sampleIndex: null,
      maxAttempts: MAX_ATTEMPTS,
      sleep,
      now: () => Date.now(),
      deadlineMs: ctx.deadlineMs,
      stage: 'transcript',
      saveRaw: async (rec) => {
        const name = `transcript-a${rec.attempt_index}.json`;
        await writeJsonAtomic(path.join(outDir, 'attempts', name), rec);
        return path.join('attempts', name);
      },
    },
    (repairFeedback) =>
      ctx.providers.transcriber.transcribe({
        audioPath: path.join(outDir, media.audioRel),
        durationMs: media.durationMs,
        promptText: transcriptPromptText,
        schema: transcriptJsonSchema,
        ...(repairFeedback !== undefined ? { repairFeedback } : {}),
      }),
    (parsed) => validateTranscriptOutput(parsed, media.durationMs),
  );
  ctx.completedAttempts.push(...transcriptRes.attempts);

  const segments: TranscriptSegment[] = transcriptRes.value.segments.map((s) => ({
    id: newTranscriptSegmentId(),
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    text: s.text,
    asr_confidence: null,
  }));
  ctx.ids.transcriptIds = segments.map((s) => s.id);
  const transcriptVersionId = newTranscriptVersionId();
  const recordedMediaId = newMediaId();
  const transcriptJson = storedTranscriptSchema.parse({
    schema_version: 1,
    transcript_version_id: transcriptVersionId,
    recorded_media_id: recordedMediaId,
    language: transcriptRes.value.language ?? 'und',
    segments,
    provider: {
      model: config.transcriber.model,
      model_version: transcriptRes.result.modelVersion,
    },
    prompt_sha256: ctx.prompts.transcriber.sha256,
  });

  const nonBlank = segments.filter((s) => s.text.trim().length > 0);
  if (nonBlank.length === 0) {
    await writeJsonAtomic(path.join(outDir, 'transcript.json'), transcriptJson);
    await writeJsonAtomic(
      path.join(outDir, 'usage.json'),
      buildUsageReport(
        {
          mode: ctx.providers.mode,
          pricing: pricingRef(ctx.pricing, config.judges[0]!.model),
          attempts: ctx.completedAttempts,
          model: config.judges[0]!.model,
        },
        ctx.pricing?.table ?? null,
      ),
    );
    throw new CliError(
      'NO_TRANSCRIPT',
      'transcript has no intelligible segments; cannot proceed to judging',
      5,
      'transcript',
    );
  }
  await writeJsonAtomic(path.join(outDir, 'transcript.json'), transcriptJson);
  manifest.stage = 'transcript_done';
  await writeJsonAtomic(manifestPath, manifest);

  return { segments, transcriptVersionId, recordedMediaId };
}

export interface EvidenceStageResult {
  evidenceSetId: string;
  evidenceItems: StoredEvidenceItem[];
  selection: FrameSelectionResult;
  selectedFrames: ManifestFrame[];
  injectionSuspected: boolean;
}

/** evidence stage: extract evidence, pick judge frames, freeze evidence-set. */
export async function extractEvidence(
  ctx: RunContext,
  media: MediaStageResult,
  transcript: TranscriptStageResult,
): Promise<EvidenceStageResult> {
  const { outDir, config, rubric, manifest, manifestPath } = ctx;
  ctx.log('[evidence] extracting evidence');
  const evRes = await callWithAttempts<EvidenceOutput>(
    {
      operation: 'evidence',
      sampleIndex: null,
      maxAttempts: MAX_ATTEMPTS,
      sleep,
      now: () => Date.now(),
      deadlineMs: ctx.deadlineMs,
      stage: 'evidence',
      saveRaw: async (rec) => {
        const name = `evidence-a${rec.attempt_index}.json`;
        await writeJsonAtomic(path.join(outDir, 'attempts', name), rec);
        return path.join('attempts', name);
      },
    },
    (repairFeedback) =>
      ctx.providers.extractor.extract({
        promptText: ctx.prompts.evidence_extractor.text,
        transcriptSegments: transcript.segments,
        ...(repairFeedback !== undefined ? { repairFeedback } : {}),
        frames: media.inputFrames.map((f) => ({
          frameId: f.frame_id,
          timestampMs: f.timestamp_ms,
          path: path.join(outDir, media.frames.find((x) => x.frame_id === f.frame_id)!.path),
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
        transcriptIds: new Set(ctx.ids.transcriptIds),
        inputFrameIds: new Set(ctx.ids.inputFrameIds),
        criterionIds: new Set(rubric.criteria.map((c) => c.id)),
      }),
  );
  ctx.completedAttempts.push(...evRes.attempts);

  const evidenceItems = evRes.value.evidence.map((e) => ({
    id: newEvidenceId(),
    kind: e.kind,
    description: e.description,
    sources: e.sources,
    criterion_hints: e.criterion_hints,
  }));
  ctx.ids.evidenceIds = evidenceItems.map((e) => e.id);

  // Judge frame selection (needs validated evidence)
  const selection = selectJudgeFrames(
    media.inputFrames,
    evidenceItems.map((e) => ({
      id: e.id,
      sourceIds: e.sources.filter((s) => s.type === 'frame').map((s) => s.id),
    })),
    config.frame_selection.max_frames_per_pitch,
  );
  if (selection.frame_reference_overflow) ctx.reviewFlagsExtra.push('frame_reference_overflow');
  const selectedFrames = selection.selected_frame_ids.map((frameId) => {
    const frame = media.frames.find((f) => f.frame_id === frameId);
    if (!frame) {
      throw new CliError(
        'INPUT_INVALID',
        `selected frame ${frameId} missing from extracted frames`,
        2,
        'evidence',
      );
    }
    return frame;
  });

  const evidenceSetId = newEvidenceSetId();
  const injectionSourceRefs = evRes.value.injection_suspected
    ? evidenceItems.flatMap((e) => e.sources)
    : [];
  const evidenceSetJson = storedEvidenceSetSchema.parse({
    schema_version: 1,
    evidence_set_id: evidenceSetId,
    pitch_id: ctx.pitchId,
    run_id: ctx.runId,
    status: 'frozen',
    extractor: {
      provider: config.evidence_extractor.provider,
      model: config.evidence_extractor.model,
      prompt_version: config.evidence_extractor.prompt_version,
    },
    recorded_media_id: transcript.recordedMediaId,
    transcript_version_id: transcript.transcriptVersionId,
    config_version_id: config.id,
    rubric_version_id: `${rubric.id}:${ctx.rubricSha.slice(0, 16)}`,
    input_frame_ids: selection.input_frame_ids,
    selected_frame_ids: selection.selected_frame_ids,
    frame_reference_overflow: selection.frame_reference_overflow,
    evidence: evidenceItems,
    evidence_ids: ctx.ids.evidenceIds,
    injection_suspected: evRes.value.injection_suspected,
    injection_source_refs: injectionSourceRefs,
    prompt_sha256: ctx.prompts.evidence_extractor.sha256,
    created_at: new Date().toISOString(),
  });
  await writeJsonAtomic(path.join(outDir, 'evidence-set.json'), evidenceSetJson);
  manifest.stage = 'evidence_done';
  await writeJsonAtomic(manifestPath, manifest);

  return {
    evidenceSetId,
    evidenceItems,
    selection,
    selectedFrames,
    injectionSuspected: evidenceSetJson.injection_suspected,
  };
}

export interface FreezeStageResult {
  inputHash: string;
  judgeSegments: TranscriptSegment[];
  judgeEvidence: { evidence: Array<Record<string, unknown>> };
}

/**
 * Freeze all judge inputs before the first judge call: write prompt and
 * snapshot files, hash the frozen artifacts, compute input_hash, and apply
 * judge-input masking when enabled.
 */
export async function freezeInputs(
  ctx: RunContext,
  transcript: TranscriptStageResult,
  evidence: EvidenceStageResult,
): Promise<FreezeStageResult> {
  const { outDir, config, rubric, prompts, manifest, manifestPath } = ctx;
  const promptsOutDir = path.join(outDir, 'prompts');
  for (const [role, p] of Object.entries(prompts)) {
    await writeTextAtomic(path.join(promptsOutDir, role, `${p.version}.md`), p.text);
  }
  const configSnapshot = storedConfigSnapshotSchema.parse({
    schema_version: 1,
    config_id: config.id,
    config_sha256: ctx.configSha,
    effective: {
      ...config,
      phash: { implementation: PHASH_IMPLEMENTATION },
      sampling: { fps: 1, max_long_edge: 1280, format: 'jpeg' },
      prompts: {
        transcriber: {
          path: `prompts/transcriber/${prompts.transcriber.version}.md`,
          version: prompts.transcriber.version,
          sha256: prompts.transcriber.sha256,
        },
        evidence_extractor: {
          path: `prompts/evidence_extractor/${prompts.evidence_extractor.version}.md`,
          version: prompts.evidence_extractor.version,
          sha256: prompts.evidence_extractor.sha256,
        },
        judge: {
          path: `prompts/judge/${prompts.judge.version}.md`,
          version: prompts.judge.version,
          sha256: prompts.judge.sha256,
        },
      },
      provider_mode: ctx.providers.mode,
    },
  });
  const rubricSnapshot = storedRubricSnapshotSchema.parse({
    schema_version: 1,
    rubric_version_id: `${rubric.id}:${ctx.rubricSha.slice(0, 16)}`,
    rubric_sha256: ctx.rubricSha,
    rubric,
  });
  await writeJsonAtomic(path.join(outDir, 'config.snapshot.json'), configSnapshot);
  await writeJsonAtomic(path.join(outDir, 'rubric.snapshot.json'), rubricSnapshot);

  const transcriptSha256 = await sha256File(path.join(outDir, 'transcript.json'));
  const evidenceSetSha256 = await sha256File(path.join(outDir, 'evidence-set.json'));
  const configSnapshotSha256 = await sha256File(path.join(outDir, 'config.snapshot.json'));
  const rubricSnapshotSha256 = await sha256File(path.join(outDir, 'rubric.snapshot.json'));
  const selectedFrameHashes = evidence.selectedFrames.map((f) => ({
    frame_id: f.frame_id,
    timestamp_ms: f.timestamp_ms,
    sha256: f.sha256,
  }));
  const reviewFlags = normalizeReviewFlags(ctx.reviewFlagsExtra);
  const frozenInputsWithoutHash = {
    hash_version: 2 as const,
    transcript_sha256: transcriptSha256,
    evidence_set_sha256: evidenceSetSha256,
    config_snapshot_sha256: configSnapshotSha256,
    rubric_snapshot_sha256: rubricSnapshotSha256,
    selected_frames: selectedFrameHashes,
    prompt_hashes: {
      transcriber: prompts.transcriber.sha256,
      evidence_extractor: prompts.evidence_extractor.sha256,
      judge: prompts.judge.sha256,
    },
    judge_schema_sha256: judgeSchemaSha256(),
    review_flags_extra: reviewFlags,
  };
  const inputHash = computeInputHash(frozenInputsWithoutHash);
  const frozenInputs = frozenInputsV2Schema.parse({ ...frozenInputsWithoutHash, input_hash: inputHash });
  manifest.frozen_inputs = frozenInputs;
  const evidenceForPrompt = buildEvidenceForPrompt(evidence.evidenceItems, evidence.selection.unshown_source_ids);
  let judgeSegments = transcript.segments;
  let judgeEvidence = evidenceForPrompt;
  if (config.judges[0]!.name_masking === true) {
    const masked = maskJudgeInputs(transcript.segments, evidenceForPrompt);
    judgeSegments = masked.segments;
    judgeEvidence = masked.evidence;
    manifest.judge_input_mask = masked.record;
  }
  await writeJsonAtomic(manifestPath, manifest);

  return { inputHash, judgeSegments, judgeEvidence };
}
