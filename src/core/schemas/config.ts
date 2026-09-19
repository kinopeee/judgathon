import { z } from 'zod';

/**
 * Judge config schema (§41.2). Strict: unknown keys are rejected as
 * CONFIG_INVALID. Phase 0 pins several values to a single allowed setting.
 */

const nonBlank = (label: string) =>
  z
    .string()
    .refine((s) => typeof s === 'string' && s.trim().length > 0, {
      message: `${label} must be a non-blank string`,
    });

const providerOptions = z
  .object({
    temperature: z.number().min(0).max(2).finite().optional(),
    top_p: z.number().gt(0).lte(1).finite().optional(),
    seed: z.number().int().optional(),
    // Gemini 3.8 does not support "minimal"; reject it at config validation.
    thinking: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

// Any non-google provider is recognized syntactically but rejected as "not
// implemented in Phase 0" by validateConfig below.
const providerEntryAny = providerOptions.extend({
  provider: z.string().refine((s) => s.trim().length > 0, { message: 'provider must be non-blank' }),
  model: nonBlank('model'),
  prompt_version: nonBlank('prompt_version'),
});

export const judgeEntrySchema = providerEntryAny.extend({
  id: nonBlank('id'),
});

export const configSchema = z
  .object({
    schema_version: z.literal(1),
    id: nonBlank('id'),
    output_language: nonBlank('output_language'),
    transcriber: providerEntryAny,
    evidence_extractor: providerEntryAny,
    judges: z.array(judgeEntrySchema).length(1),
    samples_per_judge: z.literal(3),
    aggregation: z
      .object({
        method: z.literal('median'),
      })
      .strict(),
    ranking: z
      .object({
        mode: z.literal('absolute_only'),
      })
      .strict(),
    frame_selection: z
      .object({
        dedupe_phash_distance: z.literal(8),
        max_extraction_frames: z.literal(120),
        max_frames_per_pitch: z.literal(24),
      })
      .strict(),
  })
  .strict();

export type JudgeEntry = z.infer<typeof judgeEntrySchema>;
export type ProviderEntry = z.infer<typeof providerEntryAny> & { id?: string };
export type JudgeConfig = z.infer<typeof configSchema>;

/** Validate a parsed YAML config; returns issues as strings. */
export function validateConfig(raw: unknown): { ok: true; config: JudgeConfig } | { ok: false; errors: string[] } {
  const res = configSchema.safeParse(raw);
  if (res.success) {
    const cfg = res.data;
    const errors: string[] = [];
    for (const [label, entry] of [
      ['transcriber', cfg.transcriber],
      ['evidence_extractor', cfg.evidence_extractor],
      ...cfg.judges.map((j) => [`judges[${j.id}]`, j] as const),
    ] as Array<[string, { provider: string }] | [string, JudgeEntry]>) {
      if (entry.provider !== 'google') {
        errors.push(`${label}.provider: '${entry.provider}' is not implemented in Phase 0 (only 'google')`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, config: cfg };
  }
  return { ok: false, errors: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}
