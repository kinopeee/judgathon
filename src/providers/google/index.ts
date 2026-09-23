import { promises as fs } from 'node:fs';
import {
  ApiError,
  GoogleGenAI,
  createPartFromUri,
  type File as GenaiFile,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import { ProviderError } from '../../core/errors.js';
import { sha256Hex } from '../../core/storage.js';
import type { ProviderEntry } from '../../core/schemas/config.js';
import type {
  EvidenceExtractor,
  ExtractInput,
  Judge,
  ProviderCallResult,
  ScoreInput,
  Transcriber,
  TranscribeInput,
  Usage,
} from '../types.js';

/**
 * Gemini adapters (live mode only). SDK internal retries are disabled
 * (httpOptions.retryOptions.attempts = 1) so attempt accounting in
 * src/core/retry.ts is exact. Per-attempt timeout is enforced with an
 * AbortController plus the SDK httpOptions.timeout.
 */

export const PER_ATTEMPT_TIMEOUT_MS = 120_000;
export const INLINE_BYTE_LIMIT = 18 * 1024 * 1024; // 18 MiB

type ThinkingLevel = 'low' | 'medium' | 'high';
const THINKING_MAP: Record<ThinkingLevel, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};

export interface GoogleClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `new GoogleGenAI(...)`. */
  client?: Pick<GoogleGenAI, 'models' | 'files'>;
}

function makeClient(apiKey: string, timeoutMs: number): Pick<GoogleGenAI, 'models' | 'files'> {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
      retryOptions: { attempts: 1 },
    },
  });
}

/**
 * Gemini 429/503 bodies embed google.rpc.RetryInfo ({"retryDelay":"29.4s"})
 * and/or the text "Please retry in 29.4s". ApiError.message carries the raw
 * JSON body; ApiError exposes no headers field (checked d.ts).
 */
function retryAfterMsFrom(err: ApiError): number | undefined {
  const msg = err.message;
  try {
    const body = JSON.parse(msg) as { error?: { details?: unknown[] }; details?: unknown[] };
    const details = body.error?.details ?? body.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (
          typeof d === 'object' &&
          d !== null &&
          String((d as Record<string, unknown>)['@type'] ?? '').endsWith('google.rpc.RetryInfo')
        ) {
          const m = /([\d.]+)s/.exec(String((d as Record<string, unknown>)['retryDelay'] ?? ''));
          if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
        }
      }
    }
  } catch {
    // message was not a JSON body; fall through to the regex
  }
  const m = /retry in ([\d.]+)s/i.exec(msg);
  if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
  return undefined;
}

function classifyError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ApiError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return new ProviderError('auth', err.message, { httpStatus: status });
    }
    if (status === 429) {
      const ra = retryAfterMsFrom(err);
      return new ProviderError('rate_limited', err.message, {
        httpStatus: status,
        ...(ra !== undefined ? { retryAfterMs: ra } : {}),
      });
    }
    if (status >= 500) {
      const ra = status === 503 ? retryAfterMsFrom(err) : undefined;
      return new ProviderError('server', err.message, {
        httpStatus: status,
        ...(ra !== undefined ? { retryAfterMs: ra } : {}),
      });
    }
    if (status === 400) {
      return new ProviderError('invalid_input', err.message, { httpStatus: status });
    }
    return new ProviderError('other', err.message, { httpStatus: status });
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timed?\s*out|timeout|deadline/i.test(msg)) {
    return new ProviderError('timeout', msg);
  }
  return new ProviderError('other', msg);
}

function extractUsage(resp: GenerateContentResponse): Usage | null {
  const u = resp.usageMetadata;
  if (!u) return null;
  const modality: Record<string, number> = {};
  for (const d of u.promptTokensDetails ?? []) {
    if (d.modality !== undefined && d.tokenCount !== undefined) {
      modality[String(d.modality)] = d.tokenCount;
    }
  }
  return {
    input_tokens: u.promptTokenCount ?? null,
    output_tokens: u.candidatesTokenCount ?? null,
    thinking_tokens: u.thoughtsTokenCount ?? null,
    total_tokens: u.totalTokenCount ?? null,
    input_modality_tokens: Object.keys(modality).length > 0 ? modality : null,
  };
}

function generationConfig(entry: ProviderEntry, schema: Record<string, unknown>) {
  const cfg: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: schema,
  };
  if (entry.temperature !== undefined) cfg['temperature'] = entry.temperature;
  if (entry.top_p !== undefined) cfg['topP'] = entry.top_p;
  if (entry.seed !== undefined) cfg['seed'] = entry.seed;
  if (entry.thinking !== undefined) {
    cfg['thinkingConfig'] = { thinkingLevel: THINKING_MAP[entry.thinking] };
  }
  return cfg;
}

function effectiveSettings(entry: ProviderEntry, promptText: string): Record<string, unknown> {
  return {
    model: entry.model,
    ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
    ...(entry.top_p !== undefined ? { top_p: entry.top_p } : {}),
    ...(entry.seed !== undefined ? { seed: entry.seed } : {}),
    ...(entry.thinking !== undefined ? { thinking_level: entry.thinking } : {}),
    responseMimeType: 'application/json',
    prompt_sha256: sha256Hex(promptText),
  };
}

function sleepAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new ProviderError('timeout', `request aborted (budget exceeded)`));
    if (signal.aborted) {
      fail();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      fail();
    }, { once: true });
  });
}

function deleteBestEffort(
  client: Pick<GoogleGenAI, 'files'>,
  name: string,
  timeoutMs: number,
): Promise<void> {
  return client.files
    .delete({ name, config: { abortSignal: AbortSignal.timeout(timeoutMs) } })
    .then(() => undefined)
    .catch(() => {});
}

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Race so the budget holds even when a callee ignores the signal (the
    // losing promise keeps running in the background but is dropped here).
    return await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new ProviderError('timeout', `request aborted after ${timeoutMs} ms`)),
          { once: true },
        );
      }),
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError('timeout', `request aborted after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGenerate(
  client: Pick<GoogleGenAI, 'models' | 'files'>,
  entry: ProviderEntry,
  promptText: string,
  parts: Part[],
  schema: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ProviderCallResult<unknown>> {
  const start = Date.now();
  let resp: GenerateContentResponse;
  try {
    resp = await client.models.generateContent({
      model: entry.model,
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: promptText,
        abortSignal: signal,
        ...generationConfig(entry, schema),
      },
    });
  } catch (err) {
    throw classifyError(err);
  }
  const rawText = resp.text ?? '';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = { __unparsable__: rawText };
  }
  return {
    output: parsed,
    rawText,
    usage: extractUsage(resp),
    latencyMs: Date.now() - start,
    modelVersion: resp.modelVersion ?? null,
    responseId: resp.responseId ?? null,
    effectiveSettings: effectiveSettings(entry, promptText),
  };
}

function generate(
  client: Pick<GoogleGenAI, 'models' | 'files'>,
  entry: ProviderEntry,
  promptText: string,
  parts: Part[],
  schema: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProviderCallResult<unknown>> {
  return timed(
    (signal) => callGenerate(client, entry, promptText, parts, schema, signal),
    timeoutMs,
  );
}

async function frameParts(frames: ScoreInput['frames']): Promise<Part[]> {
  const parts: Part[] = [];
  let total = 0;
  for (const f of frames) {
    const data = await fs.readFile(f.path);
    total += data.length;
    if (total > INLINE_BYTE_LIMIT) {
      throw new ProviderError(
        'invalid_input',
        `PAYLOAD_TOO_LARGE: inline frame bytes exceed ${INLINE_BYTE_LIMIT}`,
      );
    }
    parts.push({ text: `frame_id=${f.frameId} t_ms=${f.timestampMs}` });
    parts.push({ inlineData: { data: data.toString('base64'), mimeType: 'image/jpeg' } });
  }
  return parts;
}

export class GoogleTranscriber implements Transcriber {
  constructor(
    private entry: ProviderEntry,
    private opts: GoogleClientOptions,
  ) {}
  async transcribe(input: TranscribeInput): Promise<ProviderCallResult<unknown>> {
    const timeoutMs = this.opts.timeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;
    const client = this.opts.client ?? makeClient(this.opts.apiKey, timeoutMs);
    let uploaded: GenaiFile | null = null;
    try {
      // Upload + poll + generate share a single attempt budget so the whole
      // call can never exceed timeoutMs.
      return await timed(async (signal) => {
        const uploadPromise = client.files.upload({
          file: input.audioPath,
          config: { mimeType: 'audio/wav', abortSignal: signal },
        });
        // A callee that ignores the abort can still finish uploading after the
        // attempt ended; delete the late-arriving file so it isn't orphaned.
        void uploadPromise.then((file) => {
          if (signal.aborted && file.name != null) {
            void deleteBestEffort(client, file.name, timeoutMs);
          }
        });
        uploaded = await uploadPromise;
        signal.throwIfAborted();
        // Poll until ACTIVE (bounded by the shared budget).
        for (let i = 0; i < 120 && uploaded.state !== 'ACTIVE'; i++) {
          if (uploaded.state === 'FAILED') {
            throw new ProviderError('invalid_input', 'uploaded audio file failed processing');
          }
          await sleepAbort(1000, signal);
          uploaded = await client.files.get({
            name: uploaded.name!,
            config: { abortSignal: signal },
          });
          signal.throwIfAborted();
        }
        if (uploaded.state !== 'ACTIVE') {
          throw new ProviderError('timeout', 'uploaded file not ACTIVE after wait');
        }
        const audioPart = createPartFromUri(uploaded.uri!, 'audio/wav');
        const parts: Part[] = [
          audioPart,
          { text: `duration_ms=${input.durationMs}. Transcribe.` },
        ];
        if (input.repairFeedback) {
          parts.push({ text: input.repairFeedback });
        }
        return await callGenerate(client, this.entry, input.promptText, parts, input.schema, signal);
      }, timeoutMs);
    } catch (err) {
      throw classifyError(err);
    } finally {
      const uploadedName = (uploaded as GenaiFile | null)?.name;
      if (uploadedName) {
        // Detached cleanup with its own bounded budget: a stuck delete can
        // never push the observed attempt latency past timeoutMs.
        void deleteBestEffort(client, uploadedName, timeoutMs);
      }
    }
  }
}

export class GoogleEvidenceExtractor implements EvidenceExtractor {
  constructor(
    private entry: ProviderEntry,
    private opts: GoogleClientOptions,
  ) {}
  async extract(input: ExtractInput): Promise<ProviderCallResult<unknown>> {
    const timeoutMs = this.opts.timeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;
    const client = this.opts.client ?? makeClient(this.opts.apiKey, timeoutMs);
    const parts: Part[] = [
      { text: `transcript=${JSON.stringify(input.transcriptSegments)}` },
      { text: `rubric_criteria=${JSON.stringify(input.rubricCriteria)}` },
      ...(await frameParts(input.frames)),
    ];
    if (input.repairFeedback) {
      parts.push({ text: input.repairFeedback });
    }
    return generate(client, this.entry, input.promptText, parts, input.schema, timeoutMs);
  }
}

export class GoogleJudge implements Judge {
  constructor(
    private entry: ProviderEntry,
    private opts: GoogleClientOptions,
  ) {}
  async score(input: ScoreInput): Promise<ProviderCallResult<unknown>> {
    const timeoutMs = this.opts.timeoutMs ?? PER_ATTEMPT_TIMEOUT_MS;
    const client = this.opts.client ?? makeClient(this.opts.apiKey, timeoutMs);
    const parts: Part[] = [
      { text: `rubric=${JSON.stringify(input.rubric)}` },
      { text: `evidence_set=${JSON.stringify(input.evidenceSet)}` },
      { text: `transcript=${JSON.stringify(input.transcriptSegments)}` },
      { text: `sample_index=${input.sampleIndex}` },
      ...(await frameParts(input.frames)),
    ];
    if (input.repairFeedback) {
      // Failed outputs are re-sent as a user turn, never merged into the
      // system prompt.
      parts.push({ text: input.repairFeedback });
    }
    return generate(client, this.entry, input.promptText, parts, input.schema, timeoutMs);
  }
}
