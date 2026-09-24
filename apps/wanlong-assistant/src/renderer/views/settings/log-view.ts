/** Pure helpers of the log viewer (tested without a DOM). */
import type { AppLogEntry, AppLogLevel } from '../../../shared/ipc';

export const LOG_LEVEL_LABEL: Readonly<Record<AppLogLevel, string>> = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
const ORDER: Readonly<Record<AppLogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogFilter {
  minLevel: AppLogLevel;
  scope: string;
  search: string;
}

/** The same rules main applies to a query, for entries that arrive live over `app-log`. */
export function matchesLogFilter(entry: AppLogEntry, filter: LogFilter): boolean {
  if (ORDER[entry.level] < ORDER[filter.minLevel]) return false;
  if (filter.scope && entry.scope !== filter.scope) return false;
  const search = filter.search.trim().toLowerCase();
  return !search || entry.message.toLowerCase().includes(search) || entry.scope.toLowerCase().includes(search);
}

/** Newest first, without duplicates (a live push can race the query that already returned it), at most `limit`. */
export function mergeLogEntries(current: readonly AppLogEntry[], incoming: readonly AppLogEntry[], limit: number): AppLogEntry[] {
  const key = (entry: AppLogEntry) => `${entry.ts}\u0000${entry.level}\u0000${entry.scope}\u0000${entry.message}`;
  const seen = new Set<string>();
  const out: AppLogEntry[] = [];
  for (const entry of [...incoming, ...current].sort((a, b) => b.ts - a.ts)) {
    const k = key(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** Scopes seen so far, sorted, for the source filter. */
export function logScopes(entries: readonly AppLogEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.scope))].sort((a, b) => a.localeCompare(b));
}
