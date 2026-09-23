/**
 * Hand-rolled table rendering that is aware of terminal display width:
 * CJK / full-width characters occupy two columns, combining marks zero, ANSI escapes none.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** [start, end] inclusive code point ranges rendered two columns wide (East Asian Wide / Fullwidth). */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols & punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compat, Kanbun, CJK compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], // Tangut
  [0x1b000, 0x1b2ff], // Kana supplement/extended
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f], // emoji
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd], // CJK Extension B..F
  [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Display width of one code point: 0 (control / combining / zero-width), 1 or 2. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritics
    (cp >= 0x200b && cp <= 0x200f) || // zero width space / joiners / marks
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0;
  }
  return inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

/** Terminal columns needed to display `s` (ANSI escapes ignored). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Cut plain text (no ANSI) to at most `max` columns, ending with "…" when shortened. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

export function padEnd(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

export interface Column<T> {
  header: string;
  /** Plain cell text (no ANSI); colouring is applied afterwards via `style`. */
  get: (row: T) => string;
  align?: 'left' | 'right';
  /** Truncate the cell text to this many columns. */
  maxWidth?: number;
  /** Colour/decorate the already padded cell. */
  style?: (padded: string, row: T) => string;
}

export interface TableOptions {
  /** Style for the header line (e.g. bold). */
  headerStyle?: (s: string) => string;
  /** Spaces between columns (default 2). */
  gap?: number;
  /** Left indent (default 0). */
  indent?: number;
}

/** Render rows as an aligned text table (no trailing newline). */
export function renderTable<T>(rows: readonly T[], columns: ReadonlyArray<Column<T>>, opts: TableOptions = {}): string {
  const gap = ' '.repeat(opts.gap ?? 2);
  const indent = ' '.repeat(opts.indent ?? 0);
  const cells = rows.map((row) =>
    columns.map((col) => {
      const raw = (col.get(row) ?? '').replace(/[\r\n\t]+/g, ' ');
      return col.maxWidth ? truncate(raw, col.maxWidth) : raw;
    }),
  );
  const widths = columns.map((col, i) =>
    Math.max(displayWidth(col.header), ...cells.map((r) => displayWidth(r[i] ?? ''))),
  );
  const isLast = (i: number) => i === columns.length - 1;
  const pad = (text: string, i: number) => {
    const col = columns[i]!;
    if (col.align === 'right') return padStart(text, widths[i]!);
    // Do not pad the last left-aligned column: avoids trailing spaces.
    return isLast(i) ? text : padEnd(text, widths[i]!);
  };

  const headerStyle = opts.headerStyle ?? ((s: string) => s);
  const lines: string[] = [];
  lines.push(indent + headerStyle(columns.map((col, i) => pad(col.header, i)).join(gap)).trimEnd());
  cells.forEach((row, r) => {
    const line = row
      .map((text, i) => {
        const col = columns[i]!;
        const padded = pad(text, i);
        return col.style ? col.style(padded, rows[r]!) : padded;
      })
      .join(gap);
    lines.push(indent + line.replace(/\s+$/, ''));
  });
  return lines.join('\n');
}

/** Two-column "key  value" list aligned on the key column. */
export function renderKeyValues(pairs: ReadonlyArray<[string, string]>, opts: { indent?: number; keyStyle?: (s: string) => string } = {}): string {
  const indent = ' '.repeat(opts.indent ?? 0);
  const width = Math.max(0, ...pairs.map(([k]) => displayWidth(k)));
  const keyStyle = opts.keyStyle ?? ((s: string) => s);
  return pairs.map(([k, v]) => `${indent}${keyStyle(padEnd(k, width))}  ${v}`).join('\n');
}
