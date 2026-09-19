import { Decimal } from 'decimal.js';

/**
 * §41.6 reproducibility evaluation for `repeat`: per criterion, mean and
 * population standard deviation over the 5 child-run aggregated levels.
 * null in any run -> criterion not_evaluated; never substitute 0/1.
 */

export interface RepeatCriterionResult {
  criterion_id: string;
  values: Array<string | null>;
  missing_count: number;
  mean: string | null;
  sigma: string | null;
  status: 'pass' | 'fail' | 'na';
}

export const SIGMA_MAX = new Decimal('0.5');
export const REPEAT_SPEC_VERSION = 'v0.4-41.6';

export function computeRepeatStats(values: Array<string | null>): {
  mean: Decimal | null;
  sigma: Decimal | null;
  status: 'pass' | 'fail' | 'na';
  missing: number;
} {
  const missing = values.filter((v) => v === null).length;
  if (missing > 0) {
    return { mean: null, sigma: null, status: 'na', missing };
  }
  const nums = values.map((v) => new Decimal(v as string));
  const mean = nums.reduce((a, b) => a.plus(b), new Decimal(0)).div(nums.length);
  const variance = nums
    .reduce((acc, x) => acc.plus(x.minus(mean).pow(2)), new Decimal(0))
    .div(nums.length);
  const sigma = variance.sqrt();
  return { mean, sigma, status: sigma.lte(SIGMA_MAX) ? 'pass' : 'fail', missing };
}

export function buildRepeatReport(opts: {
  sourceRunId: string;
  inputHash: string;
  mode: 'fixture' | 'live';
  runs: Array<{ index: number; path: string; status: string; run_id: string | null }>;
  criterionIds: string[];
  perRunLevels: Array<Map<string, string | null> | null>; // null = run failed
}): Record<string, unknown> {
  const criteria: RepeatCriterionResult[] = opts.criterionIds.map((cid) => {
    const values = opts.perRunLevels.map((m) => (m === null ? null : (m.get(cid) ?? null)));
    const { mean, sigma, status, missing } = computeRepeatStats(values);
    return {
      criterion_id: cid,
      values,
      missing_count: missing,
      mean: mean === null ? null : mean.toString(),
      sigma: sigma === null ? null : sigma.toString(),
      status,
    };
  });

  let status: 'pass' | 'fail' | 'not_evaluated' = 'pass';
  if (criteria.some((c) => c.status === 'na')) status = 'not_evaluated';
  else if (criteria.some((c) => c.status === 'fail')) status = 'fail';

  const report: Record<string, unknown> = {
    schema_version: 1,
    source_run_id: opts.sourceRunId,
    input_hash: opts.inputHash,
    mode: opts.mode,
    runs: opts.runs,
    criteria,
    status,
    threshold: { sigma_max: SIGMA_MAX.toString(), spec_version: REPEAT_SPEC_VERSION },
  };
  if (opts.mode === 'fixture') {
    report['note'] = 'fixture mode: verifies aggregation mechanics only, not AI quality';
  }
  return report;
}
