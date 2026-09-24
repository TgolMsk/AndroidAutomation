/**
 * Frame comparisons of the AI executor (original recover.ts `meanAbsDiff` / `stableTarget`). Both use the vision
 * layer's `prepareFrame`: point-sampled grey at the reference size, or sharp's asynchronous resize for other sizes —
 * no OpenCV. Thresholds are the original ones, in reference coordinates.
 */
import { prepareFrame, type RawFrame } from '@avdm/automation';
import type { AdvisorBox } from '../../../shared/ai';

/** A tap changed the screen when the shrink-4 grey mean absolute difference reaches this (popups closing: > 15; misses: < 3). */
export const CHANGED_THRESHOLD = 6;

/** Mean absolute grey difference of two frames at shrink 4 (a coarse 640×360-level comparison, a few ms). */
export async function meanAbsDiff(a: RawFrame, b: RawFrame, refWidth: number, refHeight: number): Promise<number> {
  const pa = await prepareFrame(a, { refW: refWidth, refH: refHeight, shrink: 4 });
  const pb = await prepareFrame(b, { refW: refWidth, refH: refHeight, shrink: 4 });
  const n = Math.min(pa.gray.length, pb.gray.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(pa.gray[i]! - pb.gray[i]!);
  return sum / n;
}

/**
 * The button and its surroundings did not change between two frames (box ± 160 px sideways, 240 above, 80 below, at
 * shrink 2): mean difference < 3 and fewer than 1.5 % of pixels differ by more than 20. Protects against clicking an
 * old coordinate after the screen changed while the model was answering.
 */
export async function stableTarget(a: RawFrame, b: RawFrame, box: AdvisorBox, refWidth: number, refHeight: number): Promise<boolean> {
  if (a.width !== b.width || a.height !== b.height) return false;
  const pa = await prepareFrame(a, { refW: refWidth, refH: refHeight, shrink: 2 });
  const pb = await prepareFrame(b, { refW: refWidth, refH: refHeight, shrink: 2 });
  const left = Math.max(0, Math.floor((box.x - 160) / 2));
  const top = Math.max(0, Math.floor((box.y - 240) / 2));
  const right = Math.min(pa.w, Math.ceil((box.x + box.w + 160) / 2));
  const bottom = Math.min(pa.h, Math.ceil((box.y + box.h + 80) / 2));
  let changed = 0;
  let sum = 0;
  let n = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const d = Math.abs(pa.gray[y * pa.w + x]! - pb.gray[y * pb.w + x]!);
      sum += d;
      if (d > 20) changed++;
      n++;
    }
  }
  return n > 0 && sum / n < 3 && changed / n < 0.015;
}
