import { z } from 'zod';

const nonBlank = (label: string) =>
  z.string().refine((s) => s.trim().length > 0, { message: `${label} must be a non-blank string` });

export const criterionSchema = z
  .object({
    id: nonBlank('criterion id'),
    name: nonBlank('name'),
    max_score: z.number().finite().positive(),
    description: nonBlank('description'),
    include_qa: z.boolean(),
    anchors: z
      .object({
        '1': nonBlank('anchor 1'),
        '2': nonBlank('anchor 2'),
        '3': nonBlank('anchor 3'),
        '4': nonBlank('anchor 4'),
        '5': nonBlank('anchor 5'),
      })
      .strict(),
  })
  .strict();

export const rubricSchema = z
  .object({
    rubric: z
      .object({
        id: nonBlank('rubric id'),
        language: nonBlank('language'),
        levels: z.literal(5),
        criteria: z.array(criterionSchema).min(1).max(20),
      })
      .strict(),
  })
  .strict();

export type Criterion = z.infer<typeof criterionSchema>;
export type Rubric = z.infer<typeof rubricSchema>['rubric'];

export function validateRubric(
  raw: unknown,
): { ok: true; rubric: Rubric } | { ok: false; errors: string[] } {
  const res = rubricSchema.safeParse(raw);
  if (!res.success) {
    return { ok: false, errors: res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const rubric = res.data.rubric;
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const c of rubric.criteria) {
    if (seen.has(c.id)) errors.push(`duplicate criterion id: ${c.id}`);
    seen.add(c.id);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rubric };
}
