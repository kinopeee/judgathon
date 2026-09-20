import { rawScoreJsonSchema } from './schemas/provider-outputs.js';
import { sha256Hex } from './storage.js';
import type { FrozenInputsV2 } from './schemas/artifacts.js';

export type FrozenInputsV2WithoutHash = Omit<FrozenInputsV2, 'input_hash'>;

export function normalizeReviewFlags(flags: string[]): string[] {
  return [...new Set(flags)].sort();
}

export function computeInputHash(parts: FrozenInputsV2WithoutHash): string {
  const obj = {
    hash_version: parts.hash_version,
    transcript_sha256: parts.transcript_sha256,
    evidence_set_sha256: parts.evidence_set_sha256,
    config_snapshot_sha256: parts.config_snapshot_sha256,
    rubric_snapshot_sha256: parts.rubric_snapshot_sha256,
    selected_frames: parts.selected_frames.map((frame) => ({
      frame_id: frame.frame_id,
      timestamp_ms: frame.timestamp_ms,
      sha256: frame.sha256,
    })),
    prompt_hashes: {
      transcriber: parts.prompt_hashes.transcriber,
      evidence_extractor: parts.prompt_hashes.evidence_extractor,
      judge: parts.prompt_hashes.judge,
    },
    judge_schema_sha256: parts.judge_schema_sha256,
    review_flags_extra: normalizeReviewFlags(parts.review_flags_extra),
  };
  return sha256Hex(JSON.stringify(obj));
}

export function judgeSchemaSha256(): string {
  return sha256Hex(JSON.stringify(rawScoreJsonSchema));
}
