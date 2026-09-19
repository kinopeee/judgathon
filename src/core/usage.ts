import { Decimal } from 'decimal.js';
import { sha256File } from './storage.js';
import type { AttemptRecord } from './retry.js';
import type { Usage } from '../providers/types.js';

/** Cost accounting (§41.3 usage.json). Decimal arithmetic; null-safe. */

export interface PricingModel {
  valid_until: string;
  input_per_1m_tokens: number;
  output_per_1m_tokens: number;
  output_includes_thinking?: boolean;
}

export interface PricingTable {
  currency: string;
  models: Record<string, PricingModel>;
}

export async function loadPricing(pricingPath: string): Promise<{
  table: PricingTable;
  sha256: string;
  path: string;
}> {
  const sha = await sha256File(pricingPath);
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(pricingPath, 'utf8'));
  return { table: raw as PricingTable, sha256: sha, path: pricingPath };
}

export function estimateUsd(usage: Usage | null, model: PricingModel | undefined): Decimal | null {
  if (!usage || !model) return null;
  if (usage.input_tokens === null || usage.output_tokens === null) return null;
  const thinking = usage.thinking_tokens ?? null;
  const outputTokens = model.output_includes_thinking
    ? new Decimal(usage.output_tokens)
    : new Decimal(usage.output_tokens).plus(thinking ?? 0);
  if (!model.output_includes_thinking && thinking === null) {
    // thinking unknown but required for the formula when billed separately
    return null;
  }
  const input = new Decimal(usage.input_tokens)
    .times(model.input_per_1m_tokens)
    .div(1_000_000);
  const output = outputTokens.times(model.output_per_1m_tokens).div(1_000_000);
  return input.plus(output);
}

export interface UsageReportOptions {
  mode: 'fixture' | 'live';
  pricing: { path: string; sha256: string; valid_until: string | null } | null;
  attempts: AttemptRecord[];
  model: string;
}

export function buildUsageReport(
  opts: UsageReportOptions,
  table: PricingTable | null,
): Record<string, unknown> {
  const model = opts.model;
  const pricingModel = table?.models[model];

  let input = new Decimal(0);
  let output = new Decimal(0);
  let thinking = new Decimal(0);
  let anyNull = false;
  let knownCost = new Decimal(0);
  let unknownAttempts = 0;

  const attemptEntries = opts.attempts.map((a) => {
    const u: Usage | null = a.usage;
    const cost = estimateUsd(u, pricingModel);
    if (cost !== null) knownCost = knownCost.plus(cost);
    if (u === null || u.input_tokens === null || u.output_tokens === null) {
      anyNull = true;
      unknownAttempts += 1;
    } else {
      input = input.plus(u.input_tokens);
      output = output.plus(u.output_tokens);
      if (u.thinking_tokens !== null) thinking = thinking.plus(u.thinking_tokens);
      else if (u.thinking_tokens === null) {
        // unknown thinking tokens still allow the formula when included
      }
    }
    return {
      attempt_index: a.attempt_index,
      operation: a.operation,
      sample_index: a.sample_index,
      started_at: a.started_at,
      latency_ms: a.latency_ms,
      status: a.status,
      usage: u,
      estimated_usd: cost === null ? null : cost.toString(),
      ...(a.possible_double_billing ? { possible_double_billing: true } : {}),
    };
  });

  return {
    schema_version: 1,
    mode: opts.mode,
    model,
    pricing_table: opts.pricing,
    attempts: attemptEntries,
    totals: {
      input_tokens: anyNull ? null : input.toString(),
      output_tokens: anyNull ? null : output.toString(),
      thinking_tokens: anyNull ? null : thinking.toString(),
      estimated_usd: anyNull ? null : knownCost.toString(),
      known_estimated_usd: knownCost.toString(),
      unknown_attempts: unknownAttempts,
    },
  };
}
