import type { DisplayRotation, LiveFrame } from '../../../shared/ipc';
import { uprightSize, uprightTransform } from './rotation';

/**
 * Expand packed RGB888 rows into an RGBA ImageData buffer. Handles row padding by deriving the
 * stride from the payload size. Assumes a little-endian host (all Macs / PCs Electron runs on).
 */
export function rgbToRgba(src: Uint8Array, width: number, height: number, dst: Uint8ClampedArray): void {
  const pixels = width * height;
  const out = new Uint32Array(dst.buffer, dst.byteOffset, Math.min(pixels, dst.length >> 2));
  const stride = height > 0 ? Math.floor(src.length / height) : 0;
  const tight = stride === width * 3;
  if (tight) {
    const n = Math.min(out.length, Math.floor(src.length / 3));
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out[i] = 0xff000000 | (src[j + 2]! << 16) | (src[j + 1]! << 8) | src[j]!;
    }
    return;
  }
  if (stride < width * 3) return; // malformed frame
  for (let y = 0; y < height; y++) {
    let j = y * stride;
    const row = y * width;
    for (let x = 0; x < width; x++, j += 3) {
      out[row + x] = 0xff000000 | (src[j + 2]! << 16) | (src[j + 1]! << 8) | src[j]!;
    }
  }
}

/**
 * Draws live frames onto a canvas, at most once per animation frame. Frames arriving while one is
 * pending replace it (latest wins), so a slow renderer never builds a backlog. A frame with a rotation
 * (Android rotated while frames stay panel-native) is drawn turned upright; the canvas takes the upright size.
 */
export class FrameRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private image: ImageData | undefined;
  /** Panel-native staging surface for rotated raw frames (putImageData ignores transforms). */
  private scratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined;
  private pending: LiveFrame | undefined;
  private raf = 0;
  private decoding = false;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onDrawn: (frame: LiveFrame) => void,
  ) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }

  push(frame: LiveFrame): void {
    if (this.disposed) return;
    this.pending = frame;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pending = undefined;
  }

  private schedule(): void {
    if (this.raf || this.decoding || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private ensureSize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** Draw a panel-native image turned upright by `rotation`. */
  private paint(ctx: CanvasRenderingContext2D, source: CanvasImageSource, width: number, height: number, rotation: DisplayRotation): void {
    const up = uprightSize(width, height, rotation);
    this.ensureSize(up.width, up.height);
    ctx.setTransform(...uprightTransform(rotation, width, height));
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private scratchFor(width: number, height: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined {
    if (!this.scratch || this.scratch.canvas.width !== width || this.scratch.canvas.height !== height) {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d', { alpha: false });
      this.scratch = ctx ? { canvas, ctx } : undefined;
    }
    return this.scratch;
  }

  private draw(): void {
    const frame = this.pending;
    this.pending = undefined;
    const ctx = this.ctx;
    if (!frame || !ctx || this.disposed) return;
    const rotation = frame.rotation ?? 0;

    if (frame.format === 'png') {
      this.decoding = true;
      createImageBitmap(new Blob([frame.data as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
        .then((bmp) => {
          if (!this.disposed) {
            this.paint(ctx, bmp, bmp.width, bmp.height, rotation);
            this.onDrawn(frame);
          }
          bmp.close();
        })
        .catch(() => undefined)
        .finally(() => {
          this.decoding = false;
          if (this.pending) this.schedule();
        });
      return;
    }

    const { width, height } = frame;
    if (width <= 0 || height <= 0) return;
    if (!this.image || this.image.width !== width || this.image.height !== height) {
      this.image = ctx.createImageData(width, height);
    }
    const dst = this.image.data;
    if (frame.format === 'rgba8888') {
      dst.set(frame.data.length > dst.length ? frame.data.subarray(0, dst.length) : frame.data);
    } else {
      rgbToRgba(frame.data, width, height, dst);
    }
    const scratch = rotation ? this.scratchFor(width, height) : undefined;
    if (scratch) {
      scratch.ctx.putImageData(this.image, 0, 0);
      this.paint(ctx, scratch.canvas, width, height, rotation);
    } else {
      this.ensureSize(width, height);
      ctx.putImageData(this.image, 0, 0);
    }
    this.onDrawn(frame);
  }
}
