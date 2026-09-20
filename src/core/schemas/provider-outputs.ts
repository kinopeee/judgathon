import { z } from 'zod';

/**
 * Provider output schemas (snake_case at the boundary). These validate the raw
 * LLM JSON before any system IDs are assigned or references checked.
 */

export const transcriptOutputSchema = z
  .object({
    language: z.string().nullable(),
    segments: z.array(
      z
        .object({
          start_ms: z.number().int(),
          end_ms: z.number().int(),
          text: z.string(),
          confidence: z.null().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type TranscriptOutput = z.infer<typeof transcriptOutputSchema>;

export const evidenceSourceSchema = z
  .object({
    type: z.enum(['transcript', 'frame']),
    id: z.string(),
  })
  .strict();

export const evidenceItemSchema = z
  .object({
    kind: z.enum(['claim', 'observation', 'limitation', 'uncertainty']),
    description: z.string(),
    sources: z.array(evidenceSourceSchema).min(1),
    criterion_hints: z.array(z.string()),
  })
  .strict();

export const evidenceOutputSchema = z
  .object({
    evidence: z.array(evidenceItemSchema),
    injection_suspected: z.boolean(),
  })
  .strict();

export type EvidenceOutput = z.infer<typeof evidenceOutputSchema>;
export type EvidenceItem = EvidenceOutput['evidence'][number];

export const rawScoreCriterionSchema = z
  .object({
    criterion_id: z.string(),
    level: z.number().int().min(1).max(5).nullable(),
    evidence_strength: z.enum(['strong', 'partial', 'none']),
    evidence_ids: z.array(z.string()),
    reason: z.string(),
  })
  .strict();

export const rawScoreOutputSchema = z
  .object({
    criteria: z.array(rawScoreCriterionSchema),
    summary: z.string(),
    uncertainties: z.array(z.string()),
    injection_suspected: z.boolean(),
  })
  .strict();

export type RawScoreCriterion = z.infer<typeof rawScoreCriterionSchema>;
export type RawScoreOutput = z.infer<typeof rawScoreOutputSchema>;

/** JSON Schemas handed to the provider (generated once, shared). */
export const transcriptJsonSchema = z.toJSONSchema(transcriptOutputSchema);
export const evidenceJsonSchema = z.toJSONSchema(evidenceOutputSchema);
export const rawScoreJsonSchema = z.toJSONSchema(rawScoreOutputSchema);
