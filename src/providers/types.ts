export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  total_tokens: number | null;
  input_modality_tokens: Record<string, number> | null;
}

export interface ProviderCallResult<T> {
  output: T;
  rawText: string;
  usage: Usage | null;
  latencyMs: number;
  modelVersion: string | null;
  responseId: string | null;
  effectiveSettings: Record<string, unknown>;
}

export interface TranscriptSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  asr_confidence: number | null;
}

export interface FrameRef {
  frameId: string;
  timestampMs: number;
  path: string;
}

export interface TranscribeInput {
  audioPath: string;
  durationMs: number;
  promptText: string;
  schema: Record<string, unknown>;
  /** Schema-repair feedback re-sent as a trailing user turn (§41.5). */
  repairFeedback?: string;
}

export interface ExtractInput {
  promptText: string;
  transcriptSegments: TranscriptSegment[];
  frames: FrameRef[];
  rubricCriteria: Array<{ id: string; name: string; description: string }>;
  schema: Record<string, unknown>;
  /** Schema-repair feedback re-sent as a trailing user turn (§41.5). */
  repairFeedback?: string;
}

export interface ScoreInput {
  promptText: string;
  rubric: unknown; // full rubric object (snake_case)
  evidenceSet: unknown; // evidence items with ids + per-item unshown source ids
  transcriptSegments: TranscriptSegment[];
  frames: FrameRef[]; // selected frames only
  sampleIndex: number;
  schema: Record<string, unknown>;
  repairFeedback?: string;
}

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<ProviderCallResult<unknown>>;
}

export interface EvidenceExtractor {
  extract(input: ExtractInput): Promise<ProviderCallResult<unknown>>;
}

export interface Judge {
  score(input: ScoreInput): Promise<ProviderCallResult<unknown>>;
}

export interface ProviderSet {
  transcriber: Transcriber;
  extractor: EvidenceExtractor;
  judge: Judge;
  mode: 'fixture' | 'live';
}
