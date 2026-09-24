/** Trace shot encoding: JPEG from the last raw frame (never a second capture, never `screencap -p`). */
import sharp from 'sharp';
import type { RawFrame } from '../contracts.js';
import { getCv } from '../vision.js';

/** Wide enough to read buttons when investigating a failure. */
export const SHOT_WIDTH = 1280;
export const SHOT_QUALITY = 72;

export async function encodeTraceShot(raw: RawFrame, width = SHOT_WIDTH, quality = SHOT_QUALITY): Promise<Uint8Array> {
  const input = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const out = await sharp(input, { raw: { width: raw.width, height: raw.height, channels: 4 } })
    .resize({ width: Math.min(width, raw.width) })
    .jpeg({ quality })
    .toBuffer();
  // Copy into an exact-size buffer: `out` may be a slice of a pooled allocation.
  return Uint8Array.from(out);
}

/** Initialise OpenCV (≈1 s of WASM start-up) before the first match needs it. */
export async function warmUpVision(): Promise<void> {
  await getCv();
}
