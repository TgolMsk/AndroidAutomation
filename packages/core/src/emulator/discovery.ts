import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { emulatorDiscoveryDirs } from '../paths.js';
import type { DiscoveryEntry } from '../types.js';
import { parseIniRecord } from '../util/ini.js';
import { PID_START_SLACK_MS, isPidAlive, processStartTimes } from '../util/proc.js';

/**
 * Emulator discovery files: the emulator writes `pid_<pid>.ini` into the discovery dir while running
 * (keys: port.serial, port.adb, avd.name, avd.dir, grpc.port, grpc.token, emulator.version, cmdline …).
 * Stale files (dead pid) are common and must be ignored.
 * IMPLEMENTER: agent "core-emu" (see docs/DESIGN.md §emulator).
 */

const DISCOVERY_FILE_RE = /^pid_(\d+)\.ini$/;

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function parseDiscoveryIni(text: string, file: string, pid: number): DiscoveryEntry {
  const raw = parseIniRecord(text);
  return {
    pid,
    file,
    // Real emulators write the AVD id to `avd.id` and the *display name* (avd.ini.displayname) to `avd.name`
    // (verified with emulator 37.1.11); older/vendor builds may only have `avd.name`.
    avdName: nonEmpty(raw['avd.id']) ?? nonEmpty(raw['avd.name']),
    avdDir: nonEmpty(raw['avd.dir']),
    consolePort: positiveInt(raw['port.serial']),
    adbPort: positiveInt(raw['port.adb']),
    grpcPort: positiveInt(raw['grpc.port']),
    grpcToken: nonEmpty(raw['grpc.token']),
    emulatorVersion: nonEmpty(raw['emulator.version']),
    raw,
  };
}

/** Extract the pid from a discovery file name (`pid_1234.ini` → 1234). */
export function discoveryFilePid(fileName: string): number | undefined {
  const m = DISCOVERY_FILE_RE.exec(fileName);
  return m ? positiveInt(m[1]) : undefined;
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return []; // missing dir (no emulator ever ran) or unreadable
  }
}

/**
 * All discovery entries whose pid is alive (from every dir in emulatorDiscoveryDirs(), or `dirs` for tests).
 *
 * A killed or crashed emulator leaves its pid_<pid>.ini behind, and macOS recycles pids. An entry only counts
 * when its process is older than the file (the emulator writes the file after it starts); a younger process
 * holding that pid is an unrelated program and the file is stale. When process start times cannot be read,
 * live pids are trusted.
 */
export async function listRunningEmulators(dirs?: string[]): Promise<DiscoveryEntry[]> {
  const candidates: Array<{ entry: DiscoveryEntry; mtimeMs: number }> = [];
  const seen = new Set<number>();
  for (const dir of dirs ?? emulatorDiscoveryDirs()) {
    for (const name of await readDir(dir)) {
      const pid = discoveryFilePid(name);
      if (pid === undefined || seen.has(pid) || !isPidAlive(pid)) continue;
      const file = path.join(dir, name);
      let text: string;
      let mtimeMs: number;
      try {
        [text, { mtimeMs }] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
      } catch {
        continue; // removed between readdir and read (emulator exiting)
      }
      const entry = parseDiscoveryIni(text, file, pid);
      // A file that is still being written has no keys yet; it will show up on the next scan.
      if (Object.keys(entry.raw).length === 0) continue;
      seen.add(pid);
      candidates.push({ entry, mtimeMs });
    }
  }
  const starts = candidates.length ? await processStartTimes(candidates.map((c) => c.entry.pid)) : undefined;
  const out = candidates
    .filter(({ entry, mtimeMs }) => {
      if (!starts) return true;
      const start = starts.get(entry.pid);
      return start !== undefined && start <= mtimeMs + PID_START_SLACK_MS;
    })
    .map((c) => c.entry);
  return out.sort((a, b) => (a.consolePort ?? 0) - (b.consolePort ?? 0) || a.pid - b.pid);
}
