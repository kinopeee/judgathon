import { Decimal } from 'decimal.js';
import { sha256File } from './storage.js';
import type { AttemptRecord } from './retry.js';
import type { Usage } from '../providers/types.js';

/** Cost accounting (§41.3 usage.json). Decimal arithmetic; null-safe. */

export const USAGE_CALCULATION_VERSION = 'gemini-output-plus-thinking-v2';

export interface PricingModel {
  valid_until: string;
  input_per_1m_tokens: number;
  output_per_1m_tokens: number;
}

export interface PricingTable {
  currency: string;
  models: Record<string, PricingModel>;
}

export interface PricingFile {
  table: PricingTable;
  sha256: string;
  path: string;
}

export async function loadPricing(pricingPath: string): Promise<PricingFile> {
  const sha = await sha256File(pricingPath);
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(pricingPath, 'utf8'));
  return { table: raw as PricingTable, sha256: sha, path: pricingPath };
}

/** usage.json `pricing_table` entry: file identity + model validity window. */
export function pricingRef(
  pricing: PricingFile | null,
  model: string,
): { path: string; sha256: string; valid_until: string | null } | null {
  if (pricing === null) return null;
  return {
    path: pricing.path,
    sha256: pricing.sha256,
    valid_until: pricing.table.models[model]?.valid_until ?? null,
  };
}

export function estimateUsd(usage: Usage | null, model: PricingModel | undefined): Decimal | null {
  if (!usage || !model) return null;
  if (
    usage.input_tokens === null ||
    usage.output_tokens === null ||
    usage.thinking_tokens === null
  ) return null;
  const input = new Decimal(usage.input_tokens)
    .times(model.input_per_1m_tokens)
    .div(1_000_000);
  const output = new Decimal(usage.output_tokens)
    .plus(usage.thinking_tokens)
    .times(model.output_per_1m_tokens)
    .div(1_000_000);
  return input.plus(output);
}

export interface UsageReportOptions {
  mode: 'fixture' | 'live';
  pricing: { path: string; sha256: string; valid_until: string | null } | null;
  attempts: AttemptRecord[];
  model: string;
}

export interface UsageAttemptEntry {
  attempt_index: number;
  operation: string;
  sample_index: number | null;
  started_at: string;
  latency_ms: number;
  status: AttemptRecord['status'];
  usage: Usage | null;
  estimated_usd: string | null;
  possible_double_billing?: boolean;
}

export interface UsageReport {
  schema_version: number;
  calculation_version: string;
  mode: 'fixture' | 'live';
  model: string;
  pricing_table: { path: string; sha256: string; valid_until: string | null } | null;
  attempts: UsageAttemptEntry[];
  totals: {
    input_tokens: string | null;
    output_tokens: string | null;
    thinking_tokens: string | null;
    estimated_usd: string | null;
    known_estimated_usd: string;
    unknown_attempts: number;
  };
}

export function buildUsageReport(
  opts: UsageReportOptions,
  table: PricingTable | null,
): UsageReport {
  const model = opts.model;
  const pricingModel = table?.models[model];

  let input = new Decimal(0);
  let output = new Decimal(0);
  let thinking = new Decimal(0);
  // Per-dimension unknown tracking: a total is null if ANY attempt lacks
  // that specific value — never silently summed as zero.
  let inputUnknown = false;
  let outputUnknown = false;
  let thinkingUnknown = false;
  let costUnknown = false;
  let knownCost = new Decimal(0);
  let unknownAttempts = 0;

  const attemptEntries: UsageAttemptEntry[] = opts.attempts.map((a) => {
    const u: Usage | null = a.usage;
    const cost = estimateUsd(u, pricingModel);
    if (u === null || cost === null) {
      costUnknown = true;
      unknownAttempts += 1;
    } else {
      knownCost = knownCost.plus(cost);
    }
    if (u === null || u.input_tokens === null) inputUnknown = true;
    else input = input.plus(u.input_tokens);
    if (u === null || u.output_tokens === null) outputUnknown = true;
    else output = output.plus(u.output_tokens);
    if (u === null || u.thinking_tokens === null) thinkingUnknown = true;
    else thinking = thinking.plus(u.thinking_tokens);
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
    calculation_version: USAGE_CALCULATION_VERSION,
    mode: opts.mode,
    model,
    pricing_table: opts.pricing,
    attempts: attemptEntries,
    totals: {
      input_tokens: inputUnknown ? null : input.toString(),
      output_tokens: outputUnknown ? null : output.toString(),
      thinking_tokens: thinkingUnknown ? null : thinking.toString(),
      estimated_usd: costUnknown ? null : knownCost.toString(),
      known_estimated_usd: knownCost.toString(),
      unknown_attempts: unknownAttempts,
    },
  };
}
