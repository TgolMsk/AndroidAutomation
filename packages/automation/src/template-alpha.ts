import sharp from 'sharp';
import type { Rect } from './contracts.js';

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Keep pixels stable across the same control on different backgrounds. */
export async function buildTemplateAlpha(
  frames: Uint8Array[], crop: Rect, tolerance = 24,
): Promise<{ alphaPng: Uint8Array; previewPng: Uint8Array; coverage: number }> {
  if (frames.length < 2 || frames.length > 8) throw new Error('去底需要 2–8 张同尺寸截图');
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new Error('去底容差无效');
  const rect = { left: crop.x, top: crop.y, width: crop.w, height: crop.h };
  if (!Object.values(rect).every(Number.isSafeInteger) || rect.left < 0 || rect.top < 0 ||
    rect.width < 3 || rect.height < 3 || rect.width * rect.height > 8_000_000) throw new Error('去底区域无效');
  const rgbs: Buffer[] = [];
  let imageSize: string | undefined;
  for (const [index, frame] of frames.entries()) {
    if (!(frame instanceof Uint8Array) || frame.byteLength < 8 || frame.byteLength > MAX_FRAME_BYTES) {
      throw new Error(`第 ${index + 1} 帧无效或过大`);
    }
    const meta = await sharp(frame).metadata();
    const size = `${meta.width}×${meta.height}`;
    if (imageSize !== undefined && size !== imageSize) throw new Error('差分帧尺寸不一致，请在同一实例重新截图');
    imageSize = size;
    if (!meta.width || !meta.height || rect.left + rect.width > meta.width || rect.top + rect.height > meta.height) {
      throw new Error('去底区域超出截图');
    }
    const { data, info } = await sharp(frame).extract(rect).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error('差分帧解码失败');
    rgbs.push(data);
  }
  const length = rect.width * rect.height;
  const raw = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    let maxDiff = 0;
    for (let frame = 1; frame < rgbs.length; frame++) {
      for (let channel = 0; channel < 3; channel++) {
        maxDiff = Math.max(maxDiff, Math.abs(rgbs[0]![i * 3 + channel]! - rgbs[frame]![i * 3 + channel]!));
      }
    }
    raw[i] = maxDiff <= tolerance ? 255 : 0;
  }
  // A 3×3 majority filter removes isolated compression and animation noise.
  const mask = new Uint8Array(length);
  let opaque = 0;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      let count = 0;
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rect.height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= rect.width) continue;
          neighbours++;
          if (raw[yy * rect.width + xx]) count++;
        }
      }
      const value = count >= Math.ceil(neighbours / 2) ? 255 : 0;
      mask[y * rect.width + x] = value;
      if (value) opaque++;
    }
  }
  const coverage = opaque / length;
  const alphaPng = await sharp(mask, { raw: { width: rect.width, height: rect.height, channels: 1 } }).png().toBuffer();
  const rgba = Buffer.alloc(length * 4);
  for (let i = 0; i < length; i++) {
    rgba[i * 4] = rgbs[0]![i * 3]!;
    rgba[i * 4 + 1] = rgbs[0]![i * 3 + 1]!;
    rgba[i * 4 + 2] = rgbs[0]![i * 3 + 2]!;
    rgba[i * 4 + 3] = mask[i]!;
  }
  const previewPng = await sharp(rgba, { raw: { width: rect.width, height: rect.height, channels: 4 } })
    .flatten({ background: '#ff00ff' }).resize({ width: Math.min(360, rect.width * 4), kernel: 'nearest' }).png().toBuffer();
  return { alphaPng, previewPng, coverage };
}
