import { Decimal } from 'decimal.js';

/**
 * §12.2: score = max_score * (level - 1) / (levels - 1), levels fixed at 5.
 * All arithmetic is decimal; values are never rounded — display strings are
 * produced separately.
 */
export function levelToScore(level: Decimal.Value, maxScore: Decimal.Value): Decimal {
  return new Decimal(maxScore).times(new Decimal(level).minus(1)).div(4);
}

/** §41.5: normalized_total = 100 * total / sum(max_score). Denominator is never reduced for missing criteria. */
export function normalizedTotal(total: Decimal, sumMaxScore: Decimal): Decimal {
  if (sumMaxScore.isZero()) return new Decimal(0);
  return total.times(100).div(sumMaxScore);
}

/** 2-decimal display string (rounded for presentation only). */
export function displayScore(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
