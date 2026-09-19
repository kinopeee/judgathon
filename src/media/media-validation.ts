import path from 'node:path';
import { promises as fs } from 'node:fs';
import { CliError } from '../core/errors.js';
import { probe, type ProbeResult } from './ffprobe.js';

export const MAX_DURATION_MS = 600_000;
export const MAX_SIZE_BYTES = 512 * 1024 * 1024; // 512 MiB, boundary inclusive

export interface MediaValidationResult {
  probe: ProbeResult;
  sizeBytes: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/**
 * INVALID_MEDIA (exit 2) on: bad extension, ffprobe format not mp4/mov or
 * webm/matroska, no audio stream, duration <=0 or >600000 ms, size >512 MiB.
 */
export async function validateMediaFile(
  filePath: string,
  opts?: { statSize?: number; probeOverride?: ProbeResult },
): Promise<MediaValidationResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mp4' && ext !== '.webm') {
    throw new CliError(
      'INVALID_MEDIA',
      `unsupported extension '${ext}' (expected .mp4 or .webm)`,
      2,
      'media',
    );
  }
  const stat = await fs.stat(filePath);
  const sizeBytes = opts?.statSize ?? stat.size;
  if (sizeBytes > MAX_SIZE_BYTES) {
    throw new CliError(
      'INVALID_MEDIA',
      `file size ${sizeBytes} exceeds ${MAX_SIZE_BYTES} bytes`,
      2,
      'media',
    );
  }
  const p = opts?.probeOverride ?? (await probe(filePath));
  const fmt = p.formatName;
  const containerOk =
    /mp4|mov/.test(fmt) || /webm|matroska/.test(fmt);
  if (!containerOk) {
    throw new CliError(
      'INVALID_MEDIA',
      `ffprobe format '${fmt}' is not an mp4/mov or webm/matroska container`,
      2,
      'media',
    );
  }
  if (!Number.isFinite(p.durationMs) || p.durationMs <= 0) {
    throw new CliError('INVALID_MEDIA', `duration must be > 0 ms (got ${p.durationMs})`, 2, 'media');
  }
  if (p.durationMs > MAX_DURATION_MS) {
    throw new CliError(
      'INVALID_MEDIA',
      `duration ${p.durationMs} ms exceeds ${MAX_DURATION_MS} ms`,
      2,
      'media',
    );
  }
  const hasAudio = p.streams.some((s) => s.codec_type === 'audio');
  if (!hasAudio) {
    throw new CliError('INVALID_MEDIA', 'no audio stream found', 2, 'media');
  }
  const hasVideo = p.streams.some((s) => s.codec_type === 'video');
  return { probe: p, sizeBytes, hasAudio, hasVideo };
}
