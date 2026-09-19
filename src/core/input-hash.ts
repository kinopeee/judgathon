import { sha256Hex } from './storage.js';

/**
 * Composite hash over the frozen inputs that feed the judge stage (§41.6):
 * transcript.json, evidence-set.json, selected frame bytes, rubric, config,
 * and the judge prompt — so `repeat` can prove the bundle is unmodified.
 */
export function computeInputHash(parts: {
  transcriptSha256: string;
  evidenceSetSha256: string;
  selectedFrameSha256s: string[];
  rubricSha256: string;
  configSha256: string;
  judgePromptSha256: string;
}): string {
  return sha256Hex(
    [
      parts.transcriptSha256,
      parts.evidenceSetSha256,
      ...parts.selectedFrameSha256s,
      parts.rubricSha256,
      parts.configSha256,
      parts.judgePromptSha256,
    ].join('\n'),
  );
}
