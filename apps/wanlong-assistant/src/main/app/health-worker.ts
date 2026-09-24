import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

/**
 * Self-check probe: initialize the OpenCV WASM runtime in a throwaway worker thread. The main process never loads
 * OpenCV (its ~100 MB heap would stay resident); terminating this worker frees it again.
 */
export type HealthWorkerOutput =
  | { ok: true; version: string | null; ms: number }
  | { ok: false; error: string };

if (!parentPort) throw new Error('自检工作线程缺少通信端口');
const port = parentPort;

type Cv = { Mat?: unknown; CV_8UC1?: number; getBuildInformation?: () => string; then?: unknown } & Record<string, unknown>;

void (async () => {
  const startedAt = performance.now();
  const candidate = createRequire(import.meta.url)('@techstark/opencv-js') as Cv;
  // The CJS export is a thenable Emscripten module: call `then` on the module itself (see packages/automation vision.ts).
  const cv = await new Promise<Cv>((resolve, reject) => {
    if (typeof candidate.then === 'function') (candidate.then as (ok: (v: Cv) => void, fail: (e: unknown) => void) => void).call(candidate, resolve, reject);
    else resolve(candidate);
  });
  if (typeof cv.Mat !== 'function' || typeof cv['matchTemplate'] !== 'function') throw new Error('OpenCV 模块缺少 Mat 或 matchTemplate');
  const Mat = cv.Mat as new (rows: number, cols: number, type: number) => { delete(): void };
  const mat = new Mat(4, 4, typeof cv.CV_8UC1 === 'number' ? cv.CV_8UC1 : 0);
  mat.delete();
  const info = typeof cv.getBuildInformation === 'function' ? cv.getBuildInformation() : '';
  const version = /OpenCV\s+(\d+\.\d+(?:\.\d+)?)/i.exec(info)?.[1] ?? null;
  port.postMessage({ ok: true, version, ms: Math.round(performance.now() - startedAt) } satisfies HealthWorkerOutput);
})().catch((error: unknown) => {
  port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies HealthWorkerOutput);
});
