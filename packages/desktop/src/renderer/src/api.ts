import type { AvdmApi, BatchResult } from '../../shared/ipc';

/** Stand-in used when the page is opened without the preload (e.g. in a plain browser). */
function unavailableApi(): AvdmApi {
  return new Proxy({} as AvdmApi, {
    get(_target, prop) {
      if (prop === 'on') return () => () => undefined;
      return () => Promise.reject(new Error('未连接到主进程（预加载脚本不可用）'));
    },
  });
}

export const avdm: AvdmApi = typeof window !== 'undefined' && window.avdm ? window.avdm : unavailableApi();

/** User-facing message of a rejected API call. */
export function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Defensive: strip Electron's wrapper if an error ever bypasses the preload envelope.
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

export interface BatchSummary {
  ok: number;
  failed: Array<{ index: number; error: string }>;
}

export function summarize(results: BatchResult<unknown>[]): BatchSummary {
  const failed: BatchSummary['failed'] = [];
  let ok = 0;
  for (const r of results) {
    if (r.ok) ok++;
    else failed.push({ index: r.index, error: r.error });
  }
  return { ok, failed };
}
