import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { broadcast } from './events';

/**
 * Detect that the main bundle on disk was rebuilt (`pnpm build`) while this client keeps running old code.
 * A stale client launches emulators with its old flags (e.g. without -feature GuestAngle, which made a game report
 * "设备不支持" again), so the renderer shows a "restart to apply" banner. Skipped under the dev server (HMR).
 */
export function watchBuild(intervalMs = 5000): () => void {
  if (process.env['ELECTRON_RENDERER_URL']) return () => undefined;
  let bundle: string;
  let startMtime: number;
  try {
    bundle = fileURLToPath(import.meta.url);
    startMtime = statSync(bundle).mtimeMs;
  } catch {
    return () => undefined;
  }
  let notified = false;
  const timer = setInterval(() => {
    if (notified) return;
    try {
      const mtime = statSync(bundle).mtimeMs;
      if (mtime > startMtime) {
        notified = true;
        broadcast('app-outdated', { builtAt: mtime });
      }
    } catch {
      // mid-rebuild (file briefly missing): check again next tick
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
