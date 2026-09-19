#!/usr/bin/env node
/**
 * Generate a synthetic 60 s, 1280x720 test video with audio.
 *
 *   node scripts/make-sample-video.mjs samples/team_alpha.mp4
 *
 * The video is built entirely from ffmpeg lavfi sources (testsrc2 + sine), so
 * there are no licensing issues. The on-screen pattern changes continuously
 * (testsrc2 animation) plus a color wash changes every 10 s via a hue shift,
 * so 1 fps frames have varying pHashes. Audio is a sine tone — no speech —
 * which is fine for the fixture provider (it never inspects the video).
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'samples/team_alpha.mp4';
mkdirSync(path.dirname(out), { recursive: true });

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg not found on PATH');
  process.exit(3);
}

const args = [
  '-y',
  '-f', 'lavfi',
  '-i', 'testsrc2=size=1280x720:rate=30:duration=60',
  '-f', 'lavfi',
  '-i', 'sine=frequency=440:duration=60',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-shortest',
  out,
];

execFile('ffmpeg', args, (err, _stdout, stderr) => {
  if (err) {
    console.error('ffmpeg failed:', stderr?.split('\n').slice(-5).join('\n'));
    process.exit(3);
  }
  console.log(`wrote ${out}`);
});
