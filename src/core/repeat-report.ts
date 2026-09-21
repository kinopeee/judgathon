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

export interface RepeatReportRun {
  index: number;
  path: string;
  status: string;
  run_id: string | null;
}

export interface RepeatReport {
  schema_version: number;
  source_run_id: string;
  input_hash: string;
  mode: 'fixture' | 'live';
  runs: RepeatReportRun[];
  criteria: RepeatCriterionResult[];
  status: 'pass' | 'fail' | 'not_evaluated';
  threshold: { sigma_max: string; spec_version: string };
  source_input_hash?: string;
  output_language_compare?: { from: string; to: string };
  note?: string;
}

export function buildRepeatReport(opts: {
  sourceRunId: string;
  inputHash: string;
  mode: 'fixture' | 'live';
  runs: RepeatReportRun[];
  criterionIds: string[];
  perRunLevels: Array<Map<string, string | null> | null>; // null = run failed
  /** frozen input hash of the source run — set for output-language compare mode */
  sourceInputHash?: string;
  /** set when the judge prompt's output_language was swapped for comparison */
  outputLanguageCompare?: { from: string; to: string };
}): RepeatReport {
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

  const report: RepeatReport = {
    schema_version: 1,
    source_run_id: opts.sourceRunId,
    input_hash: opts.inputHash,
    mode: opts.mode,
    runs: opts.runs,
    criteria,
    status,
    threshold: { sigma_max: SIGMA_MAX.toString(), spec_version: REPEAT_SPEC_VERSION },
    ...(opts.sourceInputHash !== undefined
      ? { source_input_hash: opts.sourceInputHash }
      : {}),
    ...(opts.outputLanguageCompare !== undefined
      ? {
          output_language_compare: {
            from: opts.outputLanguageCompare.from,
            to: opts.outputLanguageCompare.to,
          },
        }
      : {}),
    ...(opts.mode === 'fixture'
      ? { note: 'fixture mode: verifies aggregation mechanics only, not AI quality' }
      : {}),
  };
  return report;
}
