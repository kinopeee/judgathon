import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateMediaFile, MAX_SIZE_BYTES } from '../src/media/media-validation.js';
import { tmpDir, sampleVideo } from './helpers.js';
import type { ProbeResult } from '../src/media/ffprobe.js';

const probeOf = (durationMs: number, streams: Array<{ codec_type: string }>): ProbeResult => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationMs,
  streams: streams as ProbeResult['streams'],
});

async function fakeVideoFile(size = 1024): Promise<string> {
  const dir = await tmpDir('judgathon-media-');
  const p = path.join(dir, 'v.mp4');
  await fs.writeFile(p, Buffer.alloc(size));
  return p;
}

describe('media validation boundaries', () => {
  it('P0-26 duration 0 -> INVALID_MEDIA exit 2', async () => {
    const p = await fakeVideoFile();
    await expect(
      validateMediaFile(p, { probeOverride: probeOf(0, [{ codec_type: 'audio' }]) }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA', exitCode: 2 });
  });
  it('P0-27 duration 600000 passes', async () => {
    const p = await fakeVideoFile();
    const r = await validateMediaFile(p, {
      probeOverride: probeOf(600_000, [{ codec_type: 'audio' }]),
    });
    expect(r.hasAudio).toBe(true);
  });
  it('P0-28 duration 600001 -> INVALID_MEDIA', async () => {
    const p = await fakeVideoFile();
    await expect(
      validateMediaFile(p, { probeOverride: probeOf(600_001, [{ codec_type: 'audio' }]) }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA', exitCode: 2 });
  });
  it('size boundary: exactly 512 MiB ok, +1 rejected', async () => {
    const p = await fakeVideoFile();
    const ok = await validateMediaFile(p, {
      statSize: MAX_SIZE_BYTES,
      probeOverride: probeOf(1000, [{ codec_type: 'audio' }]),
    });
    expect(ok.sizeBytes).toBe(MAX_SIZE_BYTES);
    await expect(
      validateMediaFile(p, {
        statSize: MAX_SIZE_BYTES + 1,
        probeOverride: probeOf(1000, [{ codec_type: 'audio' }]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  });
  it('no audio stream -> INVALID_MEDIA', async () => {
    const p = await fakeVideoFile();
    await expect(
      validateMediaFile(p, { probeOverride: probeOf(1000, [{ codec_type: 'video' }]) }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA', exitCode: 2 });
  });
  it('bad extension -> INVALID_MEDIA', async () => {
    const dir = await tmpDir('judgathon-media-');
    const p = path.join(dir, 'v.avi');
    await fs.writeFile(p, 'x');
    await expect(validateMediaFile(p)).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  });
  it('non-media container (ffprobe format mismatch) -> INVALID_MEDIA', async () => {
    const p = await fakeVideoFile();
    await expect(
      validateMediaFile(p, {
        probeOverride: { formatName: 'image2', durationMs: 1000, streams: [{ codec_type: 'audio' }] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MEDIA' });
  });
  it('real synthetic sample validates with audio+video', async () => {
    const r = await validateMediaFile(sampleVideo());
    expect(r.hasAudio).toBe(true);
    expect(r.hasVideo).toBe(true);
    expect(r.probe.durationMs).toBeGreaterThan(55_000);
    expect(r.probe.durationMs).toBeLessThanOrEqual(65_000);
  }, 120_000);
});
