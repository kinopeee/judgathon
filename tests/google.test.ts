import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the @google/genai module before importing the adapter. All values used
// inside the factory must be created with vi.hoisted (factory is hoisted).
const h = vi.hoisted(() => {
  const genContent = vi.fn();
  const fileUpload = vi.fn();
  const fileGet = vi.fn();
  const fileDelete = vi.fn();
  class FakeApiError extends Error {
    status: number;
    constructor(opts: { message: string; status: number }) {
      super(opts.message);
      this.status = opts.status;
    }
  }
  return { genContent, fileUpload, fileGet, fileDelete, FakeApiError };
});
const { genContent, fileUpload, fileGet, fileDelete, FakeApiError } = h;

vi.mock('@google/genai', () => ({
  ApiError: h.FakeApiError,
  GoogleGenAI: class {
    models = { generateContent: h.genContent };
    files = { upload: h.fileUpload, get: h.fileGet, delete: h.fileDelete };
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
}));

import { GoogleJudge, GoogleTranscriber, GoogleEvidenceExtractor } from '../src/providers/google/index.js';
import { ProviderError } from '../src/core/errors.js';
import { promises as fs } from 'node:fs';
import { tmpDir } from './helpers.js';
import path from 'node:path';

const entry = { provider: 'google', model: 'gemini-3.8-flash', prompt_version: 'absolute-score-v1', temperature: 0 } as const;

function fakeResponse(obj: unknown) {
  return {
    text: JSON.stringify(obj),
    modelVersion: 'gemini-3.8-flash-001',
    responseId: 'resp-1',
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20,
      totalTokenCount: 170,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 60 }],
    },
  };
}

describe('google adapter (mocked SDK)', () => {
  beforeEach(() => {
    genContent.mockReset();
    fileUpload.mockReset();
    fileGet.mockReset();
    fileDelete.mockReset();
  });

  it('maps 401 to auth', async () => {
    genContent.mockRejectedValue(new FakeApiError({ message: 'no', status: 401 }));
    const judge = new GoogleJudge(entry, { apiKey: 'x' });
    await expect(
      judge.score({
        promptText: 'p', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [],
        sampleIndex: 0, schema: {},
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 429 to rate_limited and 500 to server and 400 to invalid_input', async () => {
    const judge = new GoogleJudge(entry, { apiKey: 'x' });
    genContent.mockRejectedValueOnce(new FakeApiError({ message: 'rl', status: 429 }));
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    genContent.mockRejectedValueOnce(new FakeApiError({ message: 'srv', status: 500 }));
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toMatchObject({ kind: 'server' });
    genContent.mockRejectedValueOnce(new FakeApiError({ message: 'bad', status: 400 }));
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('parses RetryInfo retryDelay from a 429 body into retryAfterMs', async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded. Please retry in 29.4s',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '29.415s' },
        ],
      },
    });
    const judge = new GoogleJudge(entry, { apiKey: 'x' });
    genContent.mockRejectedValueOnce(new FakeApiError({ message: body, status: 429 }));
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 29415 });
    // Fallback: plain message without RetryInfo JSON.
    genContent.mockRejectedValueOnce(new FakeApiError({ message: 'Please retry in 29.4s', status: 429 }));
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 29400 });
  });

  it('extracts usage + modelVersion + responseId', async () => {
    genContent.mockResolvedValue(fakeResponse({ ok: 1 }));
    const judge = new GoogleJudge(entry, { apiKey: 'x' });
    const res = await judge.score({
      promptText: 'p', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [],
      sampleIndex: 0, schema: { type: 'object' },
    });
    expect(res.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 20,
      total_tokens: 170,
    });
    expect(res.usage!.input_modality_tokens).toEqual({ TEXT: 60 });
    expect(res.modelVersion).toBe('gemini-3.8-flash-001');
    expect(res.responseId).toBe('resp-1');
    const call = genContent.mock.calls[0]![0];
    expect(call.config.responseJsonSchema).toEqual({ type: 'object' });
    expect(call.config.systemInstruction).toBe('p');
  });

  it('transcriber uploads, polls to ACTIVE, and deletes the file', async () => {
    fileUpload.mockResolvedValue({ name: 'files/abc', state: 'PROCESSING', uri: 'gs://x' });
    fileGet.mockResolvedValue({ name: 'files/abc', state: 'ACTIVE', uri: 'gs://x' });
    fileDelete.mockResolvedValue({});
    genContent.mockResolvedValue(fakeResponse({ language: 'en', segments: [] }));
    const dir = tmpDir('judgathon-g-');
    const audio = path.join(dir, 'a.wav');
    await fs.writeFile(audio, 'RIFF');
    const tr = new GoogleTranscriber(
      { provider: 'google', model: 'm', prompt_version: 'transcribe-v2' },
      { apiKey: 'x' },
    );
    await tr.transcribe({ audioPath: audio, durationMs: 1000, promptText: 'p', schema: {} });
    expect(fileUpload).toHaveBeenCalledWith({
      file: audio,
      config: { mimeType: 'audio/wav', abortSignal: expect.any(AbortSignal) },
    });
    expect(fileGet).toHaveBeenCalledWith({
      name: 'files/abc',
      config: { abortSignal: expect.any(AbortSignal) },
    });
    expect(fileDelete).toHaveBeenCalledWith({
      name: 'files/abc',
      config: { abortSignal: expect.any(AbortSignal) },
    });
  });

  it('transcriber times out when files.upload never resolves (120s budget is effective)', async () => {
    fileUpload.mockImplementation(() => new Promise(() => {}));
    fileDelete.mockResolvedValue({});
    const dir = tmpDir('judgathon-g-');
    const audio = path.join(dir, 'a.wav');
    await fs.writeFile(audio, 'RIFF');
    const tr = new GoogleTranscriber(
      { provider: 'google', model: 'm', prompt_version: 'transcribe-v2' },
      { apiKey: 'x', timeoutMs: 50 },
    );
    await expect(
      tr.transcribe({ audioPath: audio, durationMs: 1000, promptText: 'p', schema: {} }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(genContent).not.toHaveBeenCalled();
  });

  it('transcriber deletes a file that finishes uploading after the attempt timed out', async () => {
    let resolveUpload!: (f: unknown) => void;
    fileUpload.mockImplementation(() => new Promise((res) => { resolveUpload = res; }));
    fileDelete.mockResolvedValue({});
    const dir = tmpDir('judgathon-g-');
    const audio = path.join(dir, 'a.wav');
    await fs.writeFile(audio, 'RIFF');
    const tr = new GoogleTranscriber(
      { provider: 'google', model: 'm', prompt_version: 'transcribe-v2' },
      { apiKey: 'x', timeoutMs: 50 },
    );
    await expect(
      tr.transcribe({ audioPath: audio, durationMs: 1000, promptText: 'p', schema: {} }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    // The signal-ignoring upload resolves after the attempt already ended.
    resolveUpload({ name: 'files/abc', state: 'ACTIVE', uri: 'gs://x' });
    await vi.waitFor(() => {
      expect(fileDelete).toHaveBeenCalledWith({
        name: 'files/abc',
        config: { abortSignal: expect.any(AbortSignal) },
      });
    });
  });

  it('transcriber does not wait for a stuck files.delete (attempt latency stays within budget)', async () => {
    fileUpload.mockResolvedValue({ name: 'files/abc', state: 'ACTIVE', uri: 'gs://x' });
    fileDelete.mockImplementation(() => new Promise(() => {}));
    genContent.mockResolvedValue(fakeResponse({ language: 'en', segments: [] }));
    const dir = tmpDir('judgathon-g-');
    const audio = path.join(dir, 'a.wav');
    await fs.writeFile(audio, 'RIFF');
    const tr = new GoogleTranscriber(
      { provider: 'google', model: 'm', prompt_version: 'transcribe-v2' },
      { apiKey: 'x', timeoutMs: 500 },
    );
    await expect(
      tr.transcribe({ audioPath: audio, durationMs: 1000, promptText: 'p', schema: {} }),
    ).resolves.toBeDefined();
    expect(fileDelete).toHaveBeenCalledWith({
      name: 'files/abc',
      config: { abortSignal: expect.any(AbortSignal) },
    });
  });

  it('extractor guards payload size (>18 MiB inline -> invalid_input)', async () => {
    const dir = tmpDir('judgathon-g-');
    const big = path.join(dir, 'big.jpg');
    await fs.writeFile(big, Buffer.alloc(19 * 1024 * 1024));
    const ex = new GoogleEvidenceExtractor(
      { provider: 'google', model: 'm', prompt_version: 'evidence-v1' },
      { apiKey: 'x' },
    );
    await expect(
      ex.extract({
        promptText: '', transcriptSegments: [], rubricCriteria: [],
        frames: [{ frameId: 'f1', timestampMs: 0, path: big }],
        schema: {},
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(genContent).not.toHaveBeenCalled();
  });

  it('abort -> timeout ProviderError', async () => {
    genContent.mockImplementation((_p: unknown) => {
      return new Promise((_res, rej) => setTimeout(() => rej(new Error('aborted')), 50));
    });
    const judge = new GoogleJudge(entry, { apiKey: 'x', timeoutMs: 10 });
    await expect(
      judge.score({ promptText: '', rubric: {}, evidenceSet: {}, transcriptSegments: [], frames: [], sampleIndex: 0, schema: {} }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
