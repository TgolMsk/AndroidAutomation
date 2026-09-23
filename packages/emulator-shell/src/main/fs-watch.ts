import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirWatchOptions {
  /** Only entries whose name passes take part in change detection (e.g. skip lock dirs and temp files). */
  filter?: (name: string) => boolean;
  /** Quiet period after the last fs event before re-checking (default 300 ms). */
  debounceMs?: number;
  /** Upper bound on how long a burst of events can postpone the check (default 1000 ms). */
  maxWaitMs?: number;
  /**
   * Fallback rescan interval (default 5000 ms). It also (re)attaches fs.watch once the directory exists,
   * so it covers volumes where fs.watch is unavailable and directories created later.
   */
  pollMs?: number;
}

const MISSING = '\0missing';

/**
 * Calls `onChange` when the matching files in `dir` appear, disappear or change (mtime/size/inode).
 * fs.watch gives prompt notification; comparing a directory signature drops the noise (temp files, lock
 * dirs, repeated events for one atomic rename) so `onChange` only fires for real changes.
 *
 * The directory is watched, not the files: writers replace files by renaming a temp file over them, and a
 * kqueue watch on the file itself goes silent after the first rename.
 */
export class DirWatcher {
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private firstEventAt = 0;
  private pollTimer: NodeJS.Timeout | undefined;
  private last: string | undefined;
  private checking: Promise<void> | undefined;
  private recheck = false;
  private closed = false;

  constructor(
    readonly dir: string,
    private readonly onChange: () => void,
    private readonly opts: DirWatchOptions = {},
  ) {}

  /** Take the initial snapshot (no callback for it) and start watching. */
  async start(): Promise<void> {
    if (this.closed || this.pollTimer) return;
    this.last = await this.signature();
    if (this.closed) return;
    this.attach();
    this.pollTimer = setInterval(() => {
      this.attach();
      void this.check();
    }, this.opts.pollMs ?? 5000);
    this.pollTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.detach();
  }

  /** True while an fs.watch handle is attached (the poll is the only source otherwise). */
  get watching(): boolean {
    return this.watcher !== undefined;
  }

  private attach(): void {
    if (this.watcher || this.closed) return;
    try {
      const w = watch(this.dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        if (this.watcher === w) this.detach();
        this.schedule();
      });
      this.watcher = w;
    } catch {
      // Missing directory or fs.watch unsupported here: the poll retries.
    }
  }

  private detach(): void {
    const w = this.watcher;
    this.watcher = undefined;
    try {
      w?.close();
    } catch {
      // already closed
    }
  }

  private schedule(): void {
    if (this.closed) return;
    const now = Date.now();
    if (!this.debounceTimer) this.firstEventAt = now;
    else clearTimeout(this.debounceTimer);
    const debounce = this.opts.debounceMs ?? 300;
    const maxWait = this.opts.maxWaitMs ?? 1000;
    const wait = Math.max(0, Math.min(debounce, this.firstEventAt + maxWait - now));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.check();
    }, wait);
  }

  private check(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return this.checking;
    }
    this.checking = (async () => {
      try {
        do {
          this.recheck = false;
          const sig = await this.signature();
          if (this.closed) return;
          // Directory deleted: drop the dead handle so the poll can re-attach once it is back.
          if (sig === MISSING) this.detach();
          if (sig !== this.last) {
            this.last = sig;
            try {
              this.onChange();
            } catch (err) {
              console.error('[avdm] 目录变化处理出错:', err);
            }
          }
        } while (this.recheck && !this.closed);
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  private async signature(): Promise<string> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return MISSING;
    }
    const filter = this.opts.filter;
    const wanted = (filter ? names.filter((n) => filter(n)) : names).sort();
    const parts = await Promise.all(
      wanted.map(async (name) => {
        try {
          const st = await stat(join(this.dir, name));
          return `${name}:${st.mtimeMs}:${st.size}:${st.ino}`;
        } catch {
          return `${name}:gone`;
        }
      }),
    );
    return parts.join('|');
  }
}
