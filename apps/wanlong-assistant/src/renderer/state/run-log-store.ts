/**
 * Run-log ring buffer for the monitor (wanlong-panel `store/logStore.ts`).
 *
 * ★ Logs never live in React state: a run can produce tens of thousands of lines and rebuilding a big array on
 *   every batch would re-render the whole tree. A module-level ring keeps the newest 2000 lines, the snapshot
 *   React sees is a version number, and notifications are coalesced every 150 ms (main pushes ≈ every 100 ms).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { LOG_LEVEL_ORDER, type LogEntry, type LogLevel } from '@avdm/automation/script';

export const LOG_RING_CAPACITY = 2000;
const NOTIFY_INTERVAL_MS = 150;
/**
 * Lines the pane renders at once (the newest ones); older lines of the ring appear on demand. Re-rendering all
 * 2000 rows on every 150 ms batch is what the original avoided with a virtualized list.
 */
export const LOG_RENDER_WINDOW = 300;

export interface RunLogFilter {
  /** null / undefined = every run. */
  runId?: string | null;
  minLevel?: LogLevel;
  /** Case-insensitive match on message, scope and step id. */
  keyword?: string;
  instanceIndex?: number | null;
}

export interface RunLogCounters {
  total: number;
  received: number;
  dropped: number;
  error: number;
  warn: number;
}

const keyOf = (entry: LogEntry): string => `${entry.ts}|${entry.runId ?? ''}|${entry.message}`;

export function matchesFilter(entry: LogEntry, filter: RunLogFilter): boolean {
  if (filter.runId && entry.runId !== filter.runId) return false;
  if (typeof filter.instanceIndex === 'number' && entry.instanceIndex !== filter.instanceIndex) return false;
  if (filter.minLevel && LOG_LEVEL_ORDER[entry.level] < LOG_LEVEL_ORDER[filter.minLevel]) return false;
  if (filter.keyword) {
    const needle = filter.keyword.toLowerCase();
    if (!`${entry.message} ${entry.scope} ${entry.stepId ?? ''}`.toLowerCase().includes(needle)) return false;
  }
  return true;
}

const entryKeys = new WeakMap<LogEntry, number>();
let nextEntryKey = 0;

/** A stable React key per line: the ring keeps the same objects while it slides, so rows are reused, not remounted. */
export function logEntryKey(entry: LogEntry): number {
  let key = entryKeys.get(entry);
  if (key === undefined) {
    key = ++nextEntryKey;
    entryKeys.set(entry, key);
  }
  return key;
}

/** The newest `LOG_RENDER_WINDOW + extra` lines, and how many older ones are not rendered. */
export function logRenderWindow<T>(lines: readonly T[], extra = 0): { shown: readonly T[]; hidden: number } {
  const limit = LOG_RENDER_WINDOW + Math.max(0, Math.floor(extra));
  const hidden = Math.max(0, lines.length - limit);
  return { shown: hidden ? lines.slice(hidden) : lines, hidden };
}

/** The pure ring (tested without React). */
export class RunLogBuffer {
  private lines: LogEntry[] = [];
  private receivedCount = 0;

  constructor(readonly capacity = LOG_RING_CAPACITY) {}

  /** Live batches, in arrival order. */
  push(entries: readonly LogEntry[]): void {
    if (!entries.length) return;
    this.receivedCount += entries.length;
    this.lines = this.lines.concat(entries);
    this.trim();
  }

  /** History read back from disk: de-duplicated against live lines (ts | runId | message), then time-sorted. */
  mergeHistory(entries: readonly LogEntry[]): number {
    if (!entries.length) return 0;
    const seen = new Set(this.lines.map(keyOf));
    const fresh = entries.filter((entry) => !seen.has(keyOf(entry)));
    if (!fresh.length) return 0;
    this.lines = this.lines.concat(fresh).sort((a, b) => a.ts - b.ts);
    this.trim();
    return fresh.length;
  }

  /** Clear everything, or only one run's lines. */
  clear(runId?: string): void {
    this.lines = runId ? this.lines.filter((entry) => entry.runId !== runId) : [];
    if (!runId) this.receivedCount = 0;
  }

  filter(filter: RunLogFilter): LogEntry[] {
    return this.lines.filter((entry) => matchesFilter(entry, filter));
  }

  snapshot(): LogEntry[] {
    return this.lines.slice();
  }

  counters(): RunLogCounters {
    let error = 0;
    let warn = 0;
    for (const entry of this.lines) {
      if (entry.level === 'error') error++;
      else if (entry.level === 'warn') warn++;
    }
    return { total: this.lines.length, received: this.receivedCount, dropped: Math.max(0, this.receivedCount - this.lines.length), error, warn };
  }

  private trim(): void {
    if (this.lines.length > this.capacity) this.lines = this.lines.slice(this.lines.length - this.capacity);
  }
}

const buffer = new RunLogBuffer();
let version = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notifySoon(): void {
  if (timer !== null) return;
  timer = setTimeout(() => { timer = null; notifyNow(); }, NOTIFY_INTERVAL_MS);
}

function notifyNow(): void {
  if (timer !== null) { clearTimeout(timer); timer = null; }
  version++;
  for (const listener of [...listeners]) listener();
}

export function pushRunLogs(entries: readonly LogEntry[]): void {
  if (!entries.length) return;
  buffer.push(entries);
  notifySoon();
}

export function mergeRunLogHistory(entries: readonly LogEntry[]): number {
  const added = buffer.mergeHistory(entries);
  notifyNow();
  return added;
}

export function clearRunLogs(runId?: string): void {
  buffer.clear(runId);
  notifyNow();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getVersion = (): number => version;

/** Filtered lines; the array only changes when the buffer or the filter does. */
export function useRunLogs(filter: RunLogFilter): LogEntry[] {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  const { runId, minLevel, keyword, instanceIndex } = filter;
  // `current` is the buffer version: it must be a dependency.
  return useMemo(() => buffer.filter({ runId, minLevel, keyword, instanceIndex }), [current, runId, minLevel, keyword, instanceIndex]);
}

export function useRunLogCounters(): RunLogCounters {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => buffer.counters(), [current]);
}
