import type { InstanceRecord, InstanceSpec, InstanceState } from '@avdm/core';

/** "2核/3G/1280x720@320" */
export function specSummary(spec: InstanceSpec): string {
  return `${spec.cpuCores}核/${formatRam(spec.ramMb)}/${spec.width}x${spec.height}@${spec.dpi}`;
}

/** Longer description used by `create`/`set` confirmations. */
export function specDetail(spec: InstanceSpec): string {
  const parts = [
    `${spec.cpuCores} 核`,
    `内存 ${formatRam(spec.ramMb)}`,
    `${spec.width}x${spec.height} ${spec.dpi}dpi`,
    `数据盘 ${spec.dataPartitionGb}G`,
    `GPU ${spec.gpuMode}`,
    `GLES ${glDriverLabel(spec)}`,
    spec.headless ? '无窗口' : '有窗口',
    spec.bootMode === 'cold' ? '冷启动' : '快速启动',
  ];
  return parts.join('，');
}

/** "ANGLE" / "翻译层" / "由模拟器决定" (software GPU) */
export function glDriverLabel(spec: InstanceSpec): string {
  if (spec.gpuMode === 'software') return '由模拟器决定';
  return (spec.glDriver ?? 'angle') === 'angle' ? 'ANGLE' : '翻译层';
}

export function formatRam(mb: number): string {
  if (mb % 1024 === 0) return `${mb / 1024}G`;
  if (mb > 1024) return `${(mb / 1024).toFixed(1)}G`;
  return `${mb}M`;
}

/** "system-images;android-35;default;arm64-v8a" → "android-35/default" */
export function imageSummary(pkgPath: string): string {
  const parts = pkgPath.split(';');
  if (parts[0] === 'system-images' && parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  return pkgPath;
}

/** Local time "yyyyMMdd-HHmmss" (file names). */
export function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Local time "HH:mm:ss" (event logs). */
export function clockTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Error → one-line human message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/** First non-empty line of a (possibly multi-line) message. */
export function firstLine(s: string | undefined): string {
  if (!s) return '';
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
}

/** A "，日志末尾:" lead-in whose log lines followed on later lines (and were cut off by firstLine). */
const DANGLING_TAIL = /[，,]?\s*日志末尾[:：]\s*(?=[，,。]|$)/g;

/**
 * One self-contained line for an instance error such as "模拟器进程意外退出（pid 1），日志末尾:\n<log…>":
 * the first line without the dangling "，日志末尾:" (the log itself is what `avdm logs <i>` shows).
 */
export function errorSummary(s: string | undefined): string {
  return cleanLogMessage(firstLine(s)) || '状态异常';
}

/** Drop dangling "，日志末尾:" lead-ins embedded in one-line messages ("…（pid 1），日志末尾:，正在自动重启…"). */
export function cleanLogMessage(s: string): string {
  return s.replace(DANGLING_TAIL, '').trim();
}

/** Instance state for JSON output: the gRPC bearer token is a secret and never printed. */
export function publicState(state: InstanceState): Omit<InstanceState, 'grpcToken'> & { grpcAuth: boolean } {
  const { grpcToken, ...rest } = state;
  return { ...rest, grpcAuth: Boolean(grpcToken) };
}

export function recordLabel(rec: Pick<InstanceRecord, 'index' | 'name'>): string {
  return `#${rec.index} ${rec.name}`;
}
