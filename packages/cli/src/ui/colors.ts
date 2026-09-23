import type { InstanceStatus } from '@avdm/core';

/**
 * Minimal ANSI styling. Colour is used only when the target stream is a TTY and NO_COLOR is unset
 * (https://no-color.org); FORCE_COLOR=1 forces it on (useful for `| less -R`).
 */

export function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') return true;
  return Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
}

type Style = (s: string) => string;

export interface Palette {
  readonly enabled: boolean;
  red: Style;
  green: Style;
  yellow: Style;
  blue: Style;
  magenta: Style;
  cyan: Style;
  gray: Style;
  bold: Style;
  dim: Style;
}

function wrap(enabled: boolean, open: number, close: number): Style {
  if (!enabled) return (s) => s;
  return (s) => (s === '' ? s : `\x1b[${open}m${s}\x1b[${close}m`);
}

export function makePalette(enabled: boolean): Palette {
  return {
    enabled,
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    blue: wrap(enabled, 34, 39),
    magenta: wrap(enabled, 35, 39),
    cyan: wrap(enabled, 36, 39),
    gray: wrap(enabled, 90, 39),
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
  };
}

let stdoutPalette: Palette | undefined;
let stderrPalette: Palette | undefined;

/** Palette for text written to stdout. */
export function c(): Palette {
  return (stdoutPalette ??= makePalette(colorEnabled(process.stdout)));
}

/** Palette for text written to stderr. */
export function ce(): Palette {
  return (stderrPalette ??= makePalette(colorEnabled(process.stderr)));
}

// ───────────────────────────── Instance status ─────────────────────────────

const STATUS_LABELS: Record<InstanceStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  booting: '开机中',
  running: '运行中',
  stopping: '停止中',
  error: '异常',
};

export function statusLabel(status: InstanceStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** Colour a (possibly padded) status text according to its status. */
export function colorStatus(status: InstanceStatus, text: string, p: Palette = c()): string {
  switch (status) {
    case 'running':
      return p.green(text);
    case 'starting':
    case 'booting':
      return p.yellow(text);
    case 'stopping':
      return p.magenta(text);
    case 'error':
      return p.red(text);
    default:
      return p.gray(text);
  }
}

// ───────────────────────────── Result marks ─────────────────────────────

export const MARK_OK = '✓';
export const MARK_FAIL = '✗';
export const MARK_WARN = '⚠';

export function okMark(p: Palette = c()): string {
  return p.green(MARK_OK);
}

export function failMark(p: Palette = c()): string {
  return p.red(MARK_FAIL);
}

export function warnMark(p: Palette = c()): string {
  return p.yellow(MARK_WARN);
}
