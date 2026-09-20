import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from '../core/errors.js';

const execFileP = promisify(execFile);

let cachedVersion: string | null = null;

export async function ffmpegVersion(): Promise<string> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const { stdout } = await execFileP('ffmpeg', ['-version']);
    cachedVersion = stdout.split('\n')[0] ?? '';
    return cachedVersion;
  } catch {
    throw new CliError('FFMPEG_NOT_FOUND', 'ffmpeg executable not found', 3, 'media');
  }
}

/** Normalize audio to 16 kHz mono s16le WAV. */
export async function extractAudio(inputPath: string, outPath: string): Promise<string[]> {
  const args = [
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outPath,
  ];
  await runFfmpeg(args);
  return args;
}

/**
 * Extract JPEG frames at 1 fps, long edge <= 1280 without upscaling, plus a
 * raw gray 32x32 stream (1024 bytes/frame) for pHash. Returns the argument
 * arrays actually used (recorded in the manifest).
 */
export async function extractFrames(
  inputPath: string,
  framesDir: string,
  grayPath: string,
): Promise<{ jpegArgs: string[]; grayArgs: string[] }> {
  const scale =
    "scale=w='if(gte(iw,ih),min(iw,1280),-2)':h='if(gte(iw,ih),-2,min(ih,1280))'";
  const jpegArgs = [
    '-y',
    '-i',
    inputPath,
    '-an',
    '-vf',
    `fps=1,${scale}`,
    '-q:v',
    '3',
    `${framesDir}/frame_%05d.jpg`,
  ];
  const grayArgs = [
    '-y',
    '-i',
    inputPath,
    '-an',
    '-vf',
    'fps=1,scale=32:32',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    grayPath,
  ];
  await runFfmpeg(jpegArgs);
  await runFfmpeg(grayArgs);
  return { jpegArgs, grayArgs };
}

async function runFfmpeg(args: string[]): Promise<void> {
  await ffmpegVersion();
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
      if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
    });
    child.on('error', (e) =>
      reject(new CliError('FFMPEG_NOT_FOUND', `ffmpeg spawn failed: ${e.message}`, 3, 'media')),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const tail = stderr.split('\n').filter(Boolean).slice(-5).join(' | ');
        reject(new CliError('FFMPEG_FAILED', `ffmpeg exited ${code}: ${tail}`, 3, 'media'));
      }
    });
  });
}
