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

function classifyError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof ApiError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return new ProviderError('auth', err.message, { httpStatus: status });
    }
    if (status === 429) {
      return new ProviderError('rate_limited', err.message, { httpStatus: status });
    }
    if (status >= 500) {
      return new ProviderError('server', err.message, { httpStatus: status });
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

async function timed<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ProviderError('timeout', `request aborted after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function generate(
  client: Pick<GoogleGenAI, 'models' | 'files'>,
  entry: ProviderEntry,
  promptText: string,
  parts: Part[],
  schema: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProviderCallResult<unknown>> {
  const start = Date.now();
  let resp: GenerateContentResponse;
  try {
    resp = await timed(
      (signal) =>
        client.models.generateContent({
          model: entry.model,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction: promptText,
            abortSignal: signal,
            ...generationConfig(entry, schema),
          },
        }),
      timeoutMs,
    );
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
      uploaded = await client.files.upload({
        file: input.audioPath,
        config: { mimeType: 'audio/wav' },
      });
      // Poll until ACTIVE (best-effort; short bounded loop).
      for (let i = 0; i < 60 && uploaded.state !== 'ACTIVE'; i++) {
        if (uploaded.state === 'FAILED') {
          throw new ProviderError('invalid_input', 'uploaded audio file failed processing');
        }
        await new Promise((r) => setTimeout(r, 2000));
        uploaded = await client.files.get({ name: uploaded.name! });
      }
      const audioPart = createPartFromUri(uploaded.uri!, 'audio/wav');
      const parts: Part[] = [
        audioPart,
        { text: `duration_ms=${input.durationMs}. Transcribe.` },
      ];
      if (input.repairFeedback) {
        parts.push({ text: input.repairFeedback });
      }
      return await generate(client, this.entry, input.promptText, parts, input.schema, timeoutMs);
    } catch (err) {
      throw classifyError(err);
    } finally {
      if (uploaded?.name) {
        try {
          await client.files.delete({ name: uploaded.name });
        } catch {
          // best-effort cleanup; never mask the real error
        }
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
