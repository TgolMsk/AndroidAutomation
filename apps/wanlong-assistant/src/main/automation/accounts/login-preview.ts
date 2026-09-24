import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawFrame } from '@avdm/automation';
import type { LoginPreviewRequest, LoginPreviewResponse } from './login-preview-contract';

export interface EncodedPreview {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

const ENCODE_FAILED = '画面编码失败，请稍后重试。';

interface Pending {
  resolve(value: EncodedPreview): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * JPEG preview frames for the login drawer, encoded in a long-lived `login-preview-worker` (DECISIONS A.6: sharp
 * resizing never runs on the Electron main thread). The worker starts on the first frame and stops after a short
 * idle period, so a closed drawer costs nothing.
 */
export class LoginPreviewEncoder {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: {
    maxWidth?: number; quality?: number; idleMs?: number; timeoutMs?: number; spawn?: () => Worker;
  } = {}) {}

  encode(frame: RawFrame): Promise<EncodedPreview> {
    if (this.disposed) return Promise.reject(new Error('应用正在退出'));
    const worker = this.ensureWorker();
    const id = this.nextId++;
    // A copy: the frame may be a view into a larger (or pooled) buffer, which cannot be transferred.
    const data = frame.data.slice();
    return new Promise<EncodedPreview>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, new Error(ENCODE_FAILED)), this.options.timeoutMs ?? 15_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({
        id, width: frame.width, height: frame.height, data,
        maxWidth: this.options.maxWidth ?? 960, quality: this.options.quality ?? 70,
      } satisfies LoginPreviewRequest, [data.buffer]);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop(new Error('应用正在退出'));
  }

  private ensureWorker(): Worker {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.worker) return this.worker;
    // electron-vite emits this sibling entry for both dev and packaged builds.
    const worker = this.options.spawn?.() ?? new Worker(join(dirname(fileURLToPath(import.meta.url)), 'login-preview-worker.js'));
    worker.on('message', (message: LoginPreviewResponse) => {
      this.settle(message.id, message.ok ? undefined : new Error(ENCODE_FAILED),
        message.ok ? { jpeg: message.jpeg, width: message.width, height: message.height } : undefined);
    });
    const lost = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      this.rejectAll(new Error(ENCODE_FAILED));
    };
    worker.on('error', lost);
    worker.on('exit', lost);
    this.worker = worker;
    return worker;
  }

  private settle(id: number, error?: Error, value?: EncodedPreview): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (value) entry.resolve(value);
    else entry.reject(error ?? new Error(ENCODE_FAILED));
    if (this.pending.size === 0 && this.worker && !this.disposed) {
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => { void this.stop(); }, this.options.idleMs ?? 20_000);
      this.idle.unref?.();
    }
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }

  private async stop(error = new Error(ENCODE_FAILED)): Promise<void> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const worker = this.worker;
    this.worker = null;
    this.rejectAll(error);
    if (worker) await worker.terminate().catch(() => undefined);
  }
}
