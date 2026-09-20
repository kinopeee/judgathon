import { CliError, ProviderError, isRetryableProviderError } from './errors.js';
import type { ProviderCallResult, Usage } from '../providers/types.js';
import type { ValidationIssue } from './reference-validation.js';

/**
 * §41.5 attempt budget: one attempt = one provider call + validation. Retries
 * on timeout / 429 / 5xx and on schema validation failure share the same
 * budget (default 3). auth (401/403) and invalid_input fail immediately.
 * Backoff 1s, 2s; a Retry-After hint is honored up to 30s.
 */

export interface AttemptRecord {
  attempt_index: number;
  operation: string;
  sample_index: number | null;
  started_at: string;
  latency_ms: number;
  status: 'ok' | 'retryable_error' | 'fatal_error' | 'validation_failed';
  error: { code: string; message: string } | null;
  validation_errors: string[];
  raw_output_path: string | null;
  usage: Usage | null;
  /** true when a timeout may have left provider-side processing running */
  possible_double_billing?: boolean;
}

export interface AttemptContext {
  operation: string;
  sampleIndex: number | null;
  maxAttempts: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called for every attempt to persist the raw output; returns relative path. */
  saveRaw: (rec: RawAttemptBody) => Promise<string>;
  /** Optional run deadline: epoch ms after which no further attempt may start. */
  deadlineMs?: number;
  stage: string;
}

export interface RawAttemptBody {
  operation: string;
  sample_index: number | null;
  attempt_index: number;
  raw_text: string | null;
  parsed?: unknown;
  validation_errors: string[];
  error: { code: string; message: string } | null;
  usage: Usage | null;
  latency_ms: number;
  model_version: string | null;
  response_id: string | null;
}

export interface AttemptSuccess<T> {
  value: T;
  result: ProviderCallResult<unknown>;
  attempts: AttemptRecord[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000];

export async function callWithAttempts<T>(
  ctx: AttemptContext,
  call: (repairFeedback: string | undefined) => Promise<ProviderCallResult<unknown>>,
  validate: (parsed: unknown) =>
    | { ok: true; value: T }
    | { ok: false; errors: ValidationIssue[] },
): Promise<AttemptSuccess<T>> {
  const attempts: AttemptRecord[] = [];
  let repairFeedback: string | undefined;

  for (let attempt = 0; attempt < ctx.maxAttempts; attempt++) {
    if (ctx.deadlineMs !== undefined && ctx.now() >= ctx.deadlineMs) {
      throw Object.assign(
        new CliError(
          'DEADLINE_EXCEEDED',
          `run deadline exceeded before ${ctx.operation} attempt ${attempt}`,
          3,
          ctx.stage,
        ),
        { attempts: [...attempts] },
      );
    }
    const started = ctx.now();
    const startedAt = new Date(started).toISOString();
    let record: AttemptRecord;

    try {
      const result = await call(repairFeedback);
      const latency = ctx.now() - started;
      const validation = validate(result.output);
      if (validation.ok) {
        const rawPath = await ctx.saveRaw({
          operation: ctx.operation,
          sample_index: ctx.sampleIndex,
          attempt_index: attempt,
          raw_text: result.rawText,
          parsed: result.output,
          validation_errors: [],
          error: null,
          usage: result.usage,
          latency_ms: latency,
          model_version: result.modelVersion,
          response_id: result.responseId,
        });
        record = {
          attempt_index: attempt,
          operation: ctx.operation,
          sample_index: ctx.sampleIndex,
          started_at: startedAt,
          latency_ms: latency,
          status: 'ok',
          error: null,
          validation_errors: [],
          raw_output_path: rawPath,
          usage: result.usage,
        };
        attempts.push(record);
        return { value: validation.value, result, attempts };
      }
      const msgs = validation.errors.map((e) => `${e.code}: ${e.message}`);
      const rawPath = await ctx.saveRaw({
        operation: ctx.operation,
        sample_index: ctx.sampleIndex,
        attempt_index: attempt,
        raw_text: result.rawText,
        parsed: result.output,
        validation_errors: msgs,
        error: null,
        usage: result.usage,
        latency_ms: latency,
        model_version: result.modelVersion,
        response_id: result.responseId,
      });
      record = {
        attempt_index: attempt,
        operation: ctx.operation,
        sample_index: ctx.sampleIndex,
        started_at: startedAt,
        latency_ms: latency,
        status: 'validation_failed',
        error: { code: 'PROVIDER_OUTPUT_INVALID', message: msgs.join('; ') },
        validation_errors: msgs,
        raw_output_path: rawPath,
        usage: result.usage,
      };
      attempts.push(record);
      repairFeedback = `Your previous output failed validation: ${msgs.join('; ')}; return corrected JSON`;
    } catch (err) {
      const latency = ctx.now() - started;
      const isTimeout = err instanceof ProviderError && err.kind === 'timeout';
      const code =
        err instanceof ProviderError ? `PROVIDER_${err.kind.toUpperCase()}` : 'PROVIDER_OTHER';
      const message = err instanceof Error ? err.message : String(err);
      const rawPath = await ctx.saveRaw({
        operation: ctx.operation,
        sample_index: ctx.sampleIndex,
        attempt_index: attempt,
        raw_text: null,
        validation_errors: [],
        error: { code, message },
        usage: null,
        latency_ms: latency,
        model_version: null,
        response_id: null,
      });
      const retryable = err instanceof ProviderError && isRetryableProviderError(err);
      record = {
        attempt_index: attempt,
        operation: ctx.operation,
        sample_index: ctx.sampleIndex,
        started_at: startedAt,
        latency_ms: latency,
        status: retryable ? 'retryable_error' : 'fatal_error',
        error: { code, message },
        validation_errors: [],
        raw_output_path: rawPath,
        usage: null,
      };
      if (isTimeout) record.possible_double_billing = true;
      attempts.push(record);
      if (!retryable) {
        throw Object.assign(
          new CliError(code, message, 3, ctx.stage),
          { attempts },
        );
      }
      const retryAfter = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const backoff = DEFAULT_BACKOFF_MS[Math.min(attempt, DEFAULT_BACKOFF_MS.length - 1)]!;
      const waitMs = retryAfter !== undefined ? Math.min(retryAfter, 30000) : backoff;
      if (attempt + 1 < ctx.maxAttempts) {
        await ctx.sleep(waitMs);
      }
      continue;
    }
    // validation_failed path: also wait before next attempt? Spec assigns
    // backoff to retryable comms errors; schema repair re-sends immediately.
    continue;
  }

  const last = attempts[attempts.length - 1];
  const code = last?.status === 'validation_failed' ? 'PROVIDER_OUTPUT_INVALID' : (last?.error?.code ?? 'PROVIDER_OTHER');
  const message = last?.error?.message ?? 'provider call failed';
  throw Object.assign(new CliError(code, `${ctx.operation}: ${message}`, 3, ctx.stage), {
    attempts,
  });
}
