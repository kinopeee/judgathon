import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import { computeInputHash, judgeSchemaSha256 } from '../core/input-hash.js';
import { readJsonFile, sha256File, sha256Hex } from '../core/storage.js';
import type { JudgeConfig, JudgeEntry } from '../core/schemas/config.js';
import { validateConfig } from '../core/schemas/config.js';
import { validateRubric, type Rubric } from '../core/schemas/rubric.js';
import {
  frozenInputsV2Schema,
  manifestMediaSchema,
  storedConfigSnapshotSchema,
  storedEvidenceSetSchema,
  storedRubricSnapshotSchema,
  storedTranscriptSchema,
  type FrozenInputsV2,
  type ManifestFrameRef,
  type StoredEvidenceSet,
} from '../core/schemas/artifacts.js';
import type { TranscriptSegment } from '../providers/types.js';
import {
  buildEvidenceForPrompt,
  fillPrompt,
  loadPrompt,
  maskJudgeInputs,
  type PromptRef,
} from './judge-stage.js';
import type { RepeatOptions } from './repeat.js';

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

export interface LanguageCompareResult {
  judgePrompt: PromptRef;
  inputHash: string;
  compare?: { from: string; to: string };
}

/**
 * Evaluation-only output-language comparison (§41.6 language-diff
 * procedure): the frozen prompt is stored post-substitution, so the
 * template is loaded from promptsDir and re-substituted with the frozen
 * config's output_language — its sha256 must equal the frozen judge prompt
 * hash (proof it is the same template) — then re-substituted with the
 * target language. input_hash is recomputed with the new judge hash.
 * Called only after every frozen hash has matched; a same-language target
 * returns the frozen prompt unchanged without reading the template.
 */
async function compareOutputLanguage(args: {
  outputLanguage: string;
  promptsDir: string | undefined;
  config: JudgeConfig;
  judgeEntry: JudgeEntry;
  frozenInputs: FrozenInputsV2;
  judgePrompt: PromptRef;
  inputHash: string;
  log: (line: string) => void;
}): Promise<LanguageCompareResult> {
  const { frozenInputs, judgeEntry, config, log } = args;
  let targetLang: string;
  try {
    targetLang = Intl.getCanonicalLocales(args.outputLanguage)[0]!;
  } catch {
    throw new CliError(
      'INVALID_LANGUAGE',
      `--output-language '${args.outputLanguage}' is not a valid BCP 47 tag`,
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
  // Same normalized tag as the frozen run: identical to a normal repeat —
  // no template load, no prompt substitution, no compare metadata.
  if (targetLang === frozenLang) {
    return { judgePrompt: args.judgePrompt, inputHash: args.inputHash };
  }
  if (args.promptsDir === undefined) {
    throw new CliError(
      'INVALID_ARGS',
      '--output-language requires --prompts-dir to load the judge prompt template',
      2,
      'validate_input',
    );
  }
  const template = await loadPrompt(args.promptsDir, judgeEntry.prompt_version);
  if (!template.text.includes('{{output_language}}')) {
    throw new CliError(
      'INPUT_INVALID',
      `judge prompt template '${template.version}' does not contain {{output_language}}; cannot perform output-language comparison`,
      2,
      'validate_input',
    );
  }
  const reproduced = sha256Hex(fillPrompt(template.text, { output_language: frozenLang }));
  if (reproduced !== frozenInputs.prompt_hashes.judge) {
    throw new CliError(
      'INPUT_INVALID',
      `judge prompt '${judgeEntry.prompt_version}' under --prompts-dir does not reproduce the frozen judge prompt`,
      2,
      'validate_input',
    );
  }
  const text = fillPrompt(template.text, { output_language: targetLang });
  const judgePrompt: PromptRef = {
    version: template.version,
    path: template.path,
    sha256: sha256Hex(text),
    text,
  };
  const inputHash = computeInputHash({
    hash_version: frozenInputs.hash_version,
    transcript_sha256: frozenInputs.transcript_sha256,
    evidence_set_sha256: frozenInputs.evidence_set_sha256,
    config_snapshot_sha256: frozenInputs.config_snapshot_sha256,
    rubric_snapshot_sha256: frozenInputs.rubric_snapshot_sha256,
    selected_frames: frozenInputs.selected_frames.map((frame) => ({
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      sha256: frame.sha256,
    })),
    prompt_hashes: { ...frozenInputs.prompt_hashes, judge: judgePrompt.sha256 },
    judge_schema_sha256: frozenInputs.judge_schema_sha256,
    review_flags_extra: frozenInputs.review_flags_extra,
  });
  log(`[repeat] output_language compare: ${frozenLang} -> ${targetLang}`);
  return { judgePrompt, inputHash, compare: { from: frozenLang, to: targetLang } };
}

/** Everything `repeat` derives from the source run directory. */
export interface FrozenBundle {
  /** Raw source manifest — `run_id` / `pitch_id` are read from it verbatim. */
  manifest: Record<string, unknown>;
  frozenInputs: FrozenInputsV2;
  config: JudgeConfig;
  judgeEntry: JudgeEntry;
  rubric: Rubric;
  segments: TranscriptSegment[];
  evidenceSet: StoredEvidenceSet;
  /** manifest.media.frames entries for the frozen selected frames, in order. */
  selectedFrames: ManifestFrameRef[];
  judgePrompt: PromptRef;
  inputHash: string;
  outputLanguageCompare?: { from: string; to: string };
  judgeSegments: TranscriptSegment[];
  judgeEvidence: { evidence: Array<Record<string, unknown>> };
  maskRecord?: { enabled: true; replacements: Record<string, string> };
}

/**
 * Load and verify a completed run directory: manifest status, frozen_inputs
 * v2, artifact schemas, and every frozen sha256 (artifacts, frames, prompts,
 * judge schema, composite input_hash). Returns the judge-stage inputs
 * reconstructed exactly as `run` produced them.
 */
export async function loadFrozenBundle(
  opts: RepeatOptions,
  log: (line: string) => void,
): Promise<FrozenBundle> {
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

  const mediaParse = manifestMediaSchema.safeParse(manifest['media'] ?? {});
  if (!mediaParse.success) {
    throw new CliError('INPUT_INVALID', `manifest.media invalid: ${mediaParse.error.message}`, 2, 'validate_input');
  }
  const framesMeta: ManifestFrameRef[] = mediaParse.data.frames ?? [];
  const metaById = new Map<string, ManifestFrameRef>();
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
  let judgePrompt: PromptRef = {
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

  let outputLanguageCompare: { from: string; to: string } | undefined;
  if (opts.outputLanguage !== undefined) {
    const cmp = await compareOutputLanguage({
      outputLanguage: opts.outputLanguage,
      promptsDir: opts.promptsDir,
      config,
      judgeEntry,
      frozenInputs,
      judgePrompt,
      inputHash,
      log,
    });
    judgePrompt = cmp.judgePrompt;
    inputHash = cmp.inputHash;
    outputLanguageCompare = cmp.compare;
  }

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
  // Recompute the same deterministic mask the run applied (§41.6).
  let judgeSegments = segments;
  let judgeEvidence = evidenceForPrompt;
  let maskRecord: { enabled: true; replacements: Record<string, string> } | undefined;
  if (judgeEntry.name_masking === true) {
    const masked = maskJudgeInputs(segments, evidenceForPrompt);
    judgeSegments = masked.segments;
    judgeEvidence = masked.evidence;
    maskRecord = masked.record;
  }

  return {
    manifest,
    frozenInputs,
    config,
    judgeEntry,
    rubric,
    segments,
    evidenceSet,
    selectedFrames: selectedMeta,
    judgePrompt,
    inputHash,
    ...(outputLanguageCompare !== undefined ? { outputLanguageCompare } : {}),
    judgeSegments,
    judgeEvidence,
    ...(maskRecord !== undefined ? { maskRecord } : {}),
  };
}
