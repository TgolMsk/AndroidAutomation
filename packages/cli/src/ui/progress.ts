import type { InstallProgress } from '@avdm/core';
import { ce, failMark, okMark } from './colors.js';
import { truncate } from './table.js';

/**
 * A transient status line on a TTY stream (default stderr): `update()` rewrites the line in place,
 * `log()` prints a permanent line above it. On a non-TTY stream updates are dropped and only
 * `log()` lines are written, so piped output stays clean.
 */
export class StatusLine {
  private current = '';
  private visible = false;

  constructor(readonly stream: NodeJS.WriteStream = process.stderr, readonly enabled = Boolean(stream.isTTY)) {}

  get tty(): boolean {
    return this.enabled;
  }

  update(text: string): void {
    if (!this.enabled) return;
    const cols = this.stream.columns || 80;
    this.current = truncate(text, Math.max(10, cols - 1));
    this.stream.write(`\r\x1b[2K${this.current}`);
    this.visible = true;
  }

  /** Print a permanent line (to `target`, default stdout) without garbling the status line. */
  log(line: string, target: NodeJS.WriteStream = process.stdout): void {
    this.clear();
    target.write(line + '\n');
    if (this.current && this.enabled) {
      this.stream.write(this.current);
      this.visible = true;
    }
  }

  /** Remove the status line from the screen (it is redrawn by the next update()/log()). */
  clear(): void {
    if (this.enabled && this.visible) {
      this.stream.write('\r\x1b[2K');
      this.visible = false;
    }
  }

  /** Clear and forget the status line. */
  done(): void {
    this.clear();
    this.current = '';
  }
}

export function renderBar(ratio: number, width = 24): string {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * width);
  if (filled >= width) return `[${'='.repeat(width)}]`;
  if (filled === 0) return `[${' '.repeat(width)}]`;
  return `[${'='.repeat(filled - 1)}>${' '.repeat(width - filled)}]`;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatMb(n: number): string {
  return (n / 1024 / 1024).toFixed(1);
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${String(s % 60).padStart(2, '0')}秒`;
  return `${Math.floor(m / 60)}时${String(m % 60).padStart(2, '0')}分`;
}

/**
 * Renders 'sdk-progress' events: a single refreshing line with percent + MB (+ speed) on a TTY,
 * or one line per phase / every 10 % when not a TTY.
 */
export class SdkProgressReporter {
  private readonly line: StatusLine;
  private pkg = '';
  private phase = '';
  private startedAt = 0;
  private lastDecile = -1;
  private lastDraw = 0;

  constructor(stream: NodeJS.WriteStream = process.stderr) {
    this.line = new StatusLine(stream);
  }

  handle(p: InstallProgress): void {
    const p2 = ce();
    const name = p.packagePath;
    if (name !== this.pkg || p.phase !== this.phase) {
      if (name !== this.pkg || (p.phase === 'download' && this.phase !== 'download')) {
        this.startedAt = Date.now();
        this.lastDecile = -1;
      }
      this.pkg = name;
      this.phase = p.phase;
      if (!this.line.tty && p.phase !== 'download' && p.phase !== 'done' && p.phase !== 'error') {
        this.line.log(`${phaseLabel(p.phase)} ${name}…`, this.line.stream);
      }
    }
    switch (p.phase) {
      case 'download': {
        const total = p.totalBytes ?? 0;
        const got = p.receivedBytes ?? 0;
        const ratio = total > 0 ? got / total : 0;
        const pct = total > 0 ? Math.floor(ratio * 100) : 0;
        const elapsed = (Date.now() - this.startedAt) / 1000;
        const speed = elapsed > 0.5 ? `  ${formatMb(got / elapsed)} MB/s` : '';
        const sizes = total > 0 ? `${formatMb(got)}/${formatMb(total)} MB` : `${formatMb(got)} MB`;
        if (this.line.tty) {
          // Installers may report every chunk; redraw at most ~10 times per second.
          const now = Date.now();
          if (now - this.lastDraw < 100 && got < total) break;
          this.lastDraw = now;
          this.line.update(`下载 ${name}  ${renderBar(ratio)} ${String(pct).padStart(3)}%  ${sizes}${speed}`);
        } else {
          const decile = Math.floor(pct / 10);
          if (decile !== this.lastDecile) {
            this.lastDecile = decile;
            this.line.log(`下载 ${name}  ${pct}%  ${sizes}`, this.line.stream);
          }
        }
        break;
      }
      case 'verify':
      case 'extract':
        this.line.update(`${phaseLabel(p.phase)} ${name}…${p.message ? ` ${p.message}` : ''}`);
        break;
      case 'done':
        this.line.done();
        this.line.log(`${okMark(p2)} ${name} 安装完成${p.message ? `（${p.message}）` : ''}`, this.line.stream);
        break;
      case 'error':
        this.line.done();
        this.line.log(`${failMark(p2)} ${name} 安装失败${p.message ? `: ${p.message}` : ''}`, this.line.stream);
        break;
    }
  }

  stop(): void {
    this.line.done();
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'download':
      return '下载';
    case 'verify':
      return '校验';
    case 'extract':
      return '解压';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    default:
      return phase;
  }
}
