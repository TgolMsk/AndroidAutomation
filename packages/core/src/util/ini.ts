/**
 * Minimal INI helpers for AVD files (config.ini, <name>.ini, discovery pid_*.ini,
 * source.properties). These files are flat `key=value` lists; `key = value`
 * with spaces also occurs (vendor emulators), and comments start with '#' or ';'.
 */

export type IniEntries = Array<[key: string, value: string]>;

export function parseIni(text: string): IniEntries {
  const out: IniEntries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.push([line.slice(0, eq).trim(), line.slice(eq + 1).trim()]);
  }
  return out;
}

export function iniToRecord(entries: IniEntries): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const [k, v] of entries) rec[k] = v;
  return rec;
}

export function parseIniRecord(text: string): Record<string, string> {
  return iniToRecord(parseIni(text));
}

/**
 * Serialize `key=value` lines. Line breaks and other control characters inside a value are replaced by spaces:
 * a value must never be able to start a new line (e.g. inject `hw.ramSize=…` into config.ini).
 */
export function serializeIni(entries: IniEntries | Record<string, string>): string {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  return list.map(([k, v]) => `${k}=${sanitizeIniValue(v)}`).join('\n') + '\n';
}

function sanitizeIniValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
}

/**
 * Apply `patch` to INI text: existing keys are replaced in place (order preserved),
 * new keys appended, keys whose patch value is `null` are removed.
 */
export function updateIni(text: string, patch: Record<string, string | null>): string {
  const entries = parseIni(text);
  const remaining = new Map(Object.entries(patch));
  const out: IniEntries = [];
  for (const [k, v] of entries) {
    if (remaining.has(k)) {
      const nv = remaining.get(k);
      remaining.delete(k);
      if (nv === null || nv === undefined) continue;
      out.push([k, nv]);
    } else {
      out.push([k, v]);
    }
  }
  for (const [k, v] of remaining) {
    if (v !== null && v !== undefined) out.push([k, v]);
  }
  return serializeIni(out);
}
