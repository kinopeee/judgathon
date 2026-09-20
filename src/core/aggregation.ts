import { Decimal } from 'decimal.js';
import type { RawScoreCriterion, RawScoreOutput } from './schemas/provider-outputs.js';
import type { Rubric } from './schemas/rubric.js';
import { displayScore, levelToScore, normalizedTotal } from './scoring.js';

/**
 * §13 self-consistency aggregation over 3 validated judge samples (per judge).
 */

export interface CriterionFlags {
  sample_insufficient: boolean;
  unstable: boolean;
  insufficient_for_all: boolean;
  needs_review: boolean;
}

export interface AggregatedCriterion {
  criterion_id: string;
  aggregated_level: string | null; // decimal string; may be e.g. "3.5"
  score: string; // decimal string (0 when aggregated null, §14.3)
  display_score: string;
  max_score: string;
  representative: {
    sample_index: number;
    level: number | null;
    evidence_strength: 'strong' | 'partial' | 'none';
    evidence_ids: string[];
    reason: string;
  };
  flags: CriterionFlags;
  samples: Array<RawScoreCriterion & { sample_index: number }>;
}

export interface ScorecardResult {
  criteria: AggregatedCriterion[];
  total_score: string;
  display_total_score: string;
  normalized_total_score: string;
  display_normalized_total_score: string;
  max_total: string;
  summary: string;
  uncertainties: string[];
  injection_suspected: boolean;
  review_flags: string[];
  insufficient_criteria: string[];
  representative_sample_index: number;
  samples: RawScoreOutput[];
}

/** Median over non-null integer levels; even count -> mean of middle two. */
export function medianLevel(levels: number[]): Decimal | null {
  const sorted = [...levels].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 2) return null;
  const mid = Math.floor(n / 2);
  const lo = sorted[mid - 1]!;
  const hi = sorted[mid]!;
  if (n % 2 === 1) return new Decimal(sorted[mid]!);
  return new Decimal(lo).plus(hi).div(2);
}

export function aggregateScores(
  rubric: Rubric,
  samples: RawScoreOutput[],
  opts?: { extraReviewFlags?: string[]; extraInjectionSuspected?: boolean },
): ScorecardResult {
  const criteria: AggregatedCriterion[] = [];

  for (const crit of rubric.criteria) {
    const entries = samples.map((s, i) => {
      const c = s.criteria.find((x) => x.criterion_id === crit.id);
      if (!c) throw new Error(`validated sample ${i} missing criterion ${crit.id}`);
      return { ...c, sample_index: i };
    });
    const valid = entries.filter((e) => e.level !== null);
    const validLevels = valid.map((e) => e.level as number);
    const aggregated = medianLevel(validLevels);

    const anyNull = entries.some((e) => e.level === null);
    const min = validLevels.length > 0 ? Math.min(...validLevels) : 0;
    const max = validLevels.length > 0 ? Math.max(...validLevels) : 0;
    const distinct = new Set(validLevels);
    const unstable = validLevels.length > 0 && (max - min >= 2 || distinct.size === 3);
    const insufficientForAll = aggregated === null;
    const flags: CriterionFlags = {
      sample_insufficient: anyNull,
      unstable,
      insufficient_for_all: insufficientForAll,
      needs_review: unstable || insufficientForAll || anyNull,
    };

    // Representative: valid sample whose level is closest to the aggregate
    // (ties -> lower index); when aggregated is null, lowest-index null sample.
    let rep = entries[0]!;
    if (aggregated !== null) {
      let best: { dist: Decimal; idx: number } | null = null;
      for (const e of valid) {
        const dist = new Decimal(e.level as number).minus(aggregated).abs();
        if (best === null || dist.lt(best.dist)) {
          best = { dist, idx: e.sample_index };
        }
      }
      rep = entries[best!.idx]!;
    } else {
      rep = entries.find((e) => e.level === null) ?? entries[0]!;
    }

    // §13 rule 5: evidence_strength = weakest among valid samples (partial <
    // strong); none when aggregated is null. Representative carries the
    // weakest strength for display, while its own value is kept in samples.
    let repStrength: 'strong' | 'partial' | 'none' = 'none';
    if (aggregated !== null) {
      repStrength = valid.some((e) => e.evidence_strength === 'partial') ? 'partial' : 'strong';
    }

    const score = aggregated === null ? new Decimal(0) : levelToScore(aggregated, crit.max_score);
    criteria.push({
      criterion_id: crit.id,
      aggregated_level: aggregated === null ? null : aggregated.toString(),
      score: score.toString(),
      display_score: displayScore(score),
      max_score: new Decimal(crit.max_score).toString(),
      representative: {
        sample_index: rep.sample_index,
        level: rep.level,
        evidence_strength: repStrength,
        evidence_ids: [...new Set(rep.evidence_ids)],
        reason: rep.reason,
      },
      flags,
      samples: entries,
    });
  }

  let total = new Decimal(0);
  let maxTotal = new Decimal(0);
  for (let i = 0; i < criteria.length; i++) {
    total = total.plus(criteria[i]!.score);
    maxTotal = maxTotal.plus(rubric.criteria[i]!.max_score);
  }
  const norm = normalizedTotal(total, maxTotal);

  const reviewFlags = new Set<string>(opts?.extraReviewFlags ?? []);
  const insufficientCriteria: string[] = [];
  for (const c of criteria) {
    if (c.flags.needs_review) reviewFlags.add('needs_review');
    if (c.flags.unstable) reviewFlags.add('unstable');
    if (c.flags.sample_insufficient) reviewFlags.add('sample_insufficient');
    if (c.flags.insufficient_for_all) {
      reviewFlags.add('insufficient_for_all');
      insufficientCriteria.push(c.criterion_id);
    }
  }
  // §41: extractor flag ORs into the scorecard alongside judge samples.
  const injectionSuspected =
    samples.some((s) => s.injection_suspected) || opts?.extraInjectionSuspected === true;
  if (injectionSuspected) {
    reviewFlags.add('injection_suspected');
    reviewFlags.add('needs_review');
  }
  if (reviewFlags.has('frame_reference_overflow')) reviewFlags.add('needs_review');

  const uncertainties = [...new Set(samples.flatMap((s) => s.uncertainties))];

  // Summary source: sample with the most non-null levels; ties -> lowest index
  // (spec default is sample 0; this only diverges when sample 0 has nulls that
  // a later sample does not).
  let summaryIdx = 0;
  let bestCount = -1;
  samples.forEach((s, i) => {
    const count = s.criteria.filter((c) => c.level !== null).length;
    if (count > bestCount) {
      bestCount = count;
      summaryIdx = i;
    }
  });

  return {
    criteria,
    total_score: total.toString(),
    display_total_score: displayScore(total),
    normalized_total_score: norm.toString(),
    display_normalized_total_score: displayScore(norm),
    max_total: maxTotal.toString(),
    summary: samples[summaryIdx]?.summary ?? '',
    uncertainties,
    injection_suspected: injectionSuspected,
    review_flags: [...reviewFlags],
    insufficient_criteria: insufficientCriteria,
    representative_sample_index: summaryIdx,
    samples,
  };
}
