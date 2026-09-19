import { randomUUID } from 'node:crypto';

export type IdPrefix =
  | 'run_'
  | 'pitch_'
  | 'media_'
  | 'tr_'
  | 'frame_'
  | 'ev_'
  | 'trv_'
  | 'evs_'
  | 'jr_';

/**
 * System-issued, globally unique prefixed ID.
 * Validity is membership in the current run's ID sets, never the prefix alone.
 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function newRunId(): string {
  return newId('run_');
}
export function newPitchId(): string {
  return newId('pitch_');
}
export function newMediaId(): string {
  return newId('media_');
}
export function newTranscriptSegmentId(): string {
  return newId('tr_');
}
export function newFrameId(): string {
  return newId('frame_');
}
export function newEvidenceId(): string {
  return newId('ev_');
}
export function newTranscriptVersionId(): string {
  return newId('trv_');
}
export function newEvidenceSetId(): string {
  return newId('evs_');
}
export function newJudgeRunId(): string {
  return newId('jr_');
}
