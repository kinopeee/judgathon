/**
 * judgathon-phash-v1: perceptual hash from a 32x32 grayscale frame.
 *
 * Pipeline: ffmpeg emits a raw gray 32x32 stream (1024 bytes/frame). We run a
 * separable DCT-II over the 32x32 block, keep the top-left 8x8 coefficients,
 * compute the median of all 64 coefficients, and set bit i (row-major over the
 * 8x8 block) when coefficient > median. The DC coefficient participates in the
 * median but its bit is still recorded (documented choice — excluding DC is
 * also acceptable per spec; we keep it for a full 64-bit value).
 *
 * Output: 64-bit bigint; hex rendering is 16 chars, MSB = coefficient [0][0].
 */

const SIZE = 32;
const BLOCK = 8;

// Precompute cosine tables.
const COS = new Float64Array(BLOCK * SIZE);
for (let u = 0; u < BLOCK; u++) {
  for (let x = 0; x < SIZE; x++) {
    COS[u * SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
  }
}
const CU = new Float64Array(BLOCK);
for (let u = 0; u < BLOCK; u++) {
  CU[u] = u === 0 ? Math.sqrt(1 / SIZE) : Math.sqrt(2 / SIZE);
}

export function phashFromGray32(pixels: Uint8Array): bigint {
  if (pixels.length !== SIZE * SIZE) {
    throw new Error(`expected ${SIZE * SIZE} gray pixels, got ${pixels.length}`);
  }
  // Row-wise DCT: F[y][u] for u < BLOCK.
  const rowDct = new Float64Array(SIZE * BLOCK);
  for (let y = 0; y < SIZE; y++) {
    for (let u = 0; u < BLOCK; u++) {
      let sum = 0;
      const base = y * SIZE;
      const cosRow = u * SIZE;
      for (let x = 0; x < SIZE; x++) {
        sum += pixels[base + x]! * COS[cosRow + x]!;
      }
      rowDct[y * BLOCK + u] = CU[u]! * sum;
    }
  }
  // Column-wise DCT over rowDct: G[v][u] for v < BLOCK.
  const coeff = new Float64Array(BLOCK * BLOCK);
  for (let u = 0; u < BLOCK; u++) {
    for (let v = 0; v < BLOCK; v++) {
      let sum = 0;
      for (let y = 0; y < SIZE; y++) {
        sum += rowDct[y * BLOCK + u]! * Math.cos(((2 * y + 1) * v * Math.PI) / (2 * SIZE));
      }
      coeff[v * BLOCK + u] = CU[v]! * sum;
    }
  }
  const sorted = [...coeff].sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (coeff[i]! > median) hash |= 1n << BigInt(63 - i);
  }
  return hash;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function phashToHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}

export function phashFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

export const PHASH_IMPLEMENTATION = 'judgathon-phash-v1 (ffmpeg gray32 + DCT-II 8x8 median)';
