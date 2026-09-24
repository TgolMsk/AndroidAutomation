/**
 * Batched run logger (wanlong-panel `src/worker/logger.ts`).
 *
 * Two hard rules from the original:
 *  1. Never one message per line: a step can log a dozen lines, so lines are merged into one batch every
 *     `flushMs` (100 ms) before leaving the executor thread.
 *  2. The executor never writes files. The batch goes to the host, which alone appends to the log file
 *     (several writers on one file interleave half lines).
 */
import type { LogEntry, LogLevel } from './types.js';

export interface LogInput {
  level: LogLevel;
  scope: string;
  message: string;
  stepId?: string;
  data?: Record<string, unknown>;
  shot?: string;
  ts?: number;
}

export interface RunLoggerOptions {
  flushMs?: number;
  /** Buffer cap; overflow is dropped and reported once as a warning. */
  maxBuffer?: number;
  /** Also print warn / error lines to the console (the only trace when no window is listening). */
  echo?: boolean;
  now?: () => number;
}

export const LOG_FLUSH_INTERVAL_MS = 100;
export const LOG_MAX_BUFFER = 4000;

export class RunLogger {
  private buffer: LogEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dropped = 0;
  private closed = false;
  private readonly flushMs: number;
  private readonly maxBuffer: number;
  private readonly now: () => number;

  constructor(
    private readonly runId: string,
    private readonly instanceIndex: number,
    private readonly onBatch: (entries: LogEntry[]) => void,
    private readonly options: RunLoggerOptions = {},
  ) {
    this.flushMs = options.flushMs ?? LOG_FLUSH_INTERVAL_MS;
    this.maxBuffer = options.maxBuffer ?? LOG_MAX_BUFFER;
    this.now = options.now ?? Date.now;
  }

  push(input: LogInput): void {
    if (this.closed) return;
    if (this.buffer.length >= this.maxBuffer) { this.dropped++; return; }
    const entry: LogEntry = {
      ts: input.ts ?? this.now(),
      level: input.level,
      runId: this.runId,
      instanceIndex: this.instanceIndex,
      scope: input.scope,
      message: input.message,
    };
    if (input.stepId !== undefined) entry.stepId = input.stepId;
    if (input.data !== undefined) entry.data = input.data;
    if (input.shot !== undefined) entry.shot = input.shot;
    this.buffer.push(entry);
    if (this.options.echo && (input.level === 'error' || input.level === 'warn')) {
      const line = `[run ${this.runId}#${this.instanceIndex}] ${input.stepId ? `(${input.stepId}) ` : ''}${input.message}`;
      if (input.level === 'error') console.error(line); else console.warn(line);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Send the buffer now (on failure, at the end, before exit). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.dropped > 0) {
      const count = this.dropped;
      this.dropped = 0;
      this.buffer.push({
        ts: this.now(), level: 'warn', runId: this.runId, instanceIndex: this.instanceIndex, scope: 'logger',
        message: `日志产生速度超过发送速度，已丢弃 ${count} 条。请降低脚本的日志密度。`,
      });
    }
    if (!this.buffer.length) return;
    const entries = this.buffer;
    this.buffer = [];
    try { this.onBatch(entries); }
    catch (error) { console.error(`[run ${this.runId}] 日志发送失败：${String(error)}`); }
  }

  /** Last flush; later pushes are ignored. */
  dispose(): void {
    this.flush();
    this.closed = true;
  }
}
