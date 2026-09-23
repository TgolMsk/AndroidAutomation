const EMPTY: readonly string[] = Object.freeze([]);

export interface ScriptOutputStoreOptions {
  maxLinesPerRun?: number;
  maxRuns?: number;
  /** Subscribers are notified at most this often (default 100 ms). */
  throttleMs?: number;
}

/**
 * Buffers live script output outside React state. Lines are appended without rendering anything; views
 * that show output subscribe (useSyncExternalStore) and are notified at most once per `throttleMs`, so a
 * chatty script does not re-render the whole main window for every line.
 */
export class ScriptOutputStore {
  private readonly lines = new Map<string, string[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly maxLinesPerRun: number;
  private readonly maxRuns: number;
  private readonly throttleMs: number;

  constructor(opts: ScriptOutputStoreOptions = {}) {
    this.maxLinesPerRun = opts.maxLinesPerRun ?? 2000;
    this.maxRuns = opts.maxRuns ?? 60;
    this.throttleMs = opts.throttleMs ?? 100;
  }

  push(runId: string, line: string): void {
    let buf = this.lines.get(runId);
    if (!buf) {
      buf = [];
      this.lines.set(runId, buf);
      if (this.lines.size > this.maxRuns) {
        const oldest = this.lines.keys().next().value;
        if (oldest !== undefined) this.lines.delete(oldest);
      }
    }
    buf.push(line);
    if (buf.length > this.maxLinesPerRun) buf.splice(0, buf.length - this.maxLinesPerRun);
    this.scheduleNotify();
  }

  output(runId: string): readonly string[] {
    return this.lines.get(runId) ?? EMPTY;
  }

  /** Changes whenever buffered output changed and subscribers were notified (useSyncExternalStore snapshot). */
  readonly getVersion = (): number => this.version;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Drop a pending notification (subscribers unsubscribe themselves). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNotify(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.version++;
      for (const listener of [...this.listeners]) listener();
    }, this.throttleMs);
  }
}
