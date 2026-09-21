import { z } from 'zod';
import { configSchema } from './config.js';
import { rubricSchema } from './rubric.js';
import { evidenceItemSchema } from './provider-outputs.js';

const storedTranscriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    start_ms: z.number().int(),
    end_ms: z.number().int(),
    text: z.string(),
    asr_confidence: z.null(),
  })
  .strict();

export const storedTranscriptSchema = z.looseObject({
  schema_version: z.number().int(),
  transcript_version_id: z.string().min(1),
  segments: z.array(storedTranscriptSegmentSchema),
});
export type StoredTranscript = z.infer<typeof storedTranscriptSchema>;
export type StoredTranscriptSegment = z.infer<typeof storedTranscriptSegmentSchema>;

export const storedEvidenceItemSchema = evidenceItemSchema.extend({
  id: z.string().min(1),
});
export type StoredEvidenceItem = z.infer<typeof storedEvidenceItemSchema>;

export const storedEvidenceSetSchema = z.looseObject({
  schema_version: z.number().int(),
  evidence_set_id: z.string().min(1),
  evidence: z.array(storedEvidenceItemSchema),
  evidence_ids: z.array(z.string().min(1)),
  input_frame_ids: z.array(z.string().min(1)),
  selected_frame_ids: z.array(z.string().min(1)),
  frame_reference_overflow: z.boolean(),
  injection_suspected: z.boolean(),
});
export type StoredEvidenceSet = z.infer<typeof storedEvidenceSetSchema>;

const promptSnapshotSchema = z
  .object({
    path: z.string().min(1),
    version: z.string().min(1),
    sha256: z.string().length(64),
  })
  .strict();

const storedConfigEffectiveSchema = z.looseObject({
  ...configSchema.shape,
  provider_mode: z.enum(['fixture', 'live']),
  prompts: z
    .object({
      transcriber: promptSnapshotSchema,
      evidence_extractor: promptSnapshotSchema,
      judge: promptSnapshotSchema,
    })
    .strict(),
});

export const storedConfigSnapshotSchema = z.looseObject({
  schema_version: z.number().int(),
  config_id: z.string().min(1),
  config_sha256: z.string().length(64),
  effective: storedConfigEffectiveSchema,
});
export type StoredConfigSnapshot = z.infer<typeof storedConfigSnapshotSchema>;

export const storedRubricSnapshotSchema = z.looseObject({
  schema_version: z.number().int(),
  rubric_version_id: z.string().min(1),
  rubric_sha256: z.string().length(64),
  rubric: rubricSchema.shape.rubric,
});
export type StoredRubricSnapshot = z.infer<typeof storedRubricSnapshotSchema>;

const selectedFrameHashSchema = z
  .object({
    frame_id: z.string().min(1),
    timestamp_ms: z.number().int(),
    sha256: z.string().length(64),
  })
  .strict();

/**
 * Read-side schema for `manifest.media.frames` (repeat only needs these four
 * fields per frame record; extras are passed through).
 */
export const manifestMediaSchema = z.looseObject({
  frames: z
    .array(
      z.looseObject({
        frame_id: z.string().min(1),
        path: z.string().min(1),
        sha256: z.string().length(64),
        timestamp_ms: z.number().int(),
      }),
    )
    .optional(),
});
export type ManifestFrameRef = {
  frame_id: string;
  path: string;
  sha256: string;
  timestamp_ms: number;
};

export const frozenInputsV2Schema = z
  .object({
    hash_version: z.literal(2),
    transcript_sha256: z.string().length(64),
    evidence_set_sha256: z.string().length(64),
    config_snapshot_sha256: z.string().length(64),
    rubric_snapshot_sha256: z.string().length(64),
    selected_frames: z.array(selectedFrameHashSchema),
    prompt_hashes: z
      .object({
        transcriber: z.string().length(64),
        evidence_extractor: z.string().length(64),
        judge: z.string().length(64),
      })
      .strict(),
    judge_schema_sha256: z.string().length(64),
    review_flags_extra: z.array(z.string()),
    input_hash: z.string().length(64),
  })
  .strict();
export type FrozenInputsV2 = z.infer<typeof frozenInputsV2Schema>;
export type FrozenSelectedFrame = z.infer<typeof selectedFrameHashSchema>;
