import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from '../core/errors.js';

const execFileP = promisify(execFile);

let cachedVersion: string | null = null;

export async function ffprobeVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const { stdout } = await execFileP('ffprobe', ['-version']);
    cachedVersion = stdout.split('\n')[0] ?? '';
    return cachedVersion;
  } catch {
    throw new CliError('FFMPEG_NOT_FOUND', 'ffprobe executable not found', 3, 'media');
  }
}

export interface ProbeStream {
  codec_type: string;
  width?: number;
  height?: number;
}

export interface ProbeResult {
  formatName: string;
  durationMs: number;
  streams: ProbeStream[];
}

/** Run ffprobe; throws CliError on failure. Resets the cached version is NOT done here. */
export async function probe(filePath: string): Promise<ProbeResult> {
  await ffprobeVersion();
  let stdout: string;
  try {
    const res = await execFileP('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration:stream=codec_type,width,height',
      '-of',
      'json',
      filePath,
    ]);
    stdout = res.stdout;
  } catch (err) {
    throw new CliError(
      'INVALID_MEDIA',
      `ffprobe failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      2,
      'media',
    );
  }
  let parsed: { format?: { format_name?: string; duration?: string }; streams?: ProbeStream[] };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliError('INVALID_MEDIA', `ffprobe returned unparsable output for ${filePath}`, 2, 'media');
  }
  const formatName = parsed.format?.format_name ?? '';
  const durationSec = Number(parsed.format?.duration);
  const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : NaN;
  return { formatName, durationMs, streams: parsed.streams ?? [] };
}
