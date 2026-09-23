import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp, type WriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AvdmError } from './errors.js';
import type { ManagerPaths, ScriptManifest, ScriptRunInfo } from './types.js';
import { ensureDir, pathExists, readTextIfExists } from './util/fs.js';

/**
 * Script plugins: any executable in any language, one directory per script:
 *   <scriptsDir>/<id>/script.json   { "name": "...", "description": "...", "command": ["python3", "main.py"], "env": {} }
 * A run = one process per instance, cwd = script dir, env:
 *   ANDROID_SERIAL=<serial> AVDM_INDEX=<index> AVDM_NAME=<name> AVDM_CONSOLE_PORT AVDM_ADB_PORT AVDM_GRPC_PORT
 *   AVDM_GRPC_TOKEN (if any) AVDM_ADB=<adb bin> ANDROID_SDK_ROOT AVDM_HOME PYTHONUNBUFFERED=1
 *   plus manifest.env, plus user args appended to command.
 * stdout+stderr → <scriptLogsDir>/<runId>.log and emitted line by line.
 * IMPLEMENTER: agent "core-manager" (see docs/DESIGN.md §scripts).
 */

export interface ScriptTarget {
  index: number;
  name: string;
  serial: string;
  consolePort: number;
  adbPort: number;
  grpcPort: number;
  grpcToken?: string;
}

export interface ScriptRunnerEvents {
  onRun: (run: ScriptRunInfo) => void;
  onOutput: (runId: string, line: string) => void;
}

/** Directory name of the example created by createExample(). */
export const EXAMPLE_SCRIPT_ID = 'hello-adb';

/** Manifest file name inside each script directory. */
export const SCRIPT_MANIFEST_FILE = 'script.json';

/** Finished runs kept in memory (running ones are never dropped). */
const MAX_KEPT_RUNS = 200;
/** SIGTERM → SIGKILL grace period for stop(). */
const STOP_GRACE_MS = 5000;
/** After the process exits, wait this long for its output pipes to drain (a grandchild may hold them open). */
const DRAIN_AFTER_EXIT_MS = 1500;
/** Lines longer than this are split so a runaway script cannot exhaust memory. */
const MAX_LINE_CHARS = 64 * 1024;

interface RunEntry {
  info: ScriptRunInfo;
  child?: ChildProcess;
  stopRequested: boolean;
  finalized: boolean;
  log?: WriteStream;
  done: Promise<void>;
  resolveDone: () => void;
}

type ManifestLoad = { ok: true; manifest: ScriptManifest } | { ok: false; reason: string };

export class ScriptRunner {
  private readonly runs = new Map<string, RunEntry>();

  constructor(
    readonly paths: ManagerPaths,
    readonly env: { adbBin?: string; sdkRoot: string },
    readonly events: ScriptRunnerEvents,
  ) {}

  /** Load every valid script.json under scriptsDir (invalid ones skipped), sorted by name. */
  async listScripts(): Promise<ScriptManifest[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.paths.scriptsDir);
    } catch {
      return [];
    }
    const loaded = await Promise.all(names.filter(isValidScriptId).map((id) => this.loadManifest(id)));
    const list = loaded.flatMap((r) => (r.ok ? [r.manifest] : []));
    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
  }

  /** Start one process per target. Throws AvdmError('SCRIPT_NOT_FOUND'). */
  async run(scriptId: string, targets: ScriptTarget[], args: string[] = []): Promise<ScriptRunInfo[]> {
    if (!isValidScriptId(scriptId)) throw new AvdmError('SCRIPT_NOT_FOUND', `脚本不存在: "${scriptId}"`);
    const loaded = await this.loadManifest(scriptId);
    if (!loaded.ok) {
      throw new AvdmError('SCRIPT_NOT_FOUND', `脚本 "${scriptId}" 不可用：${loaded.reason}`, {
        dir: path.join(this.paths.scriptsDir, scriptId),
      });
    }
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      throw new AvdmError('INVALID_ARGUMENT', '脚本参数必须是字符串数组');
    }
    if (targets.length === 0) return [];
    await ensureDir(this.paths.scriptLogsDir);
    return Promise.all(targets.map((t) => this.startRun(loaded.manifest, t, args)));
  }

  /** SIGTERM the run's process group, SIGKILL after 5s. Resolves when exited. */
  async stop(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry) throw new AvdmError('INVALID_ARGUMENT', `脚本运行记录不存在: ${runId}`);
    if (entry.finalized) return;
    entry.stopRequested = true;
    const pid = entry.child?.pid;
    if (pid === undefined) {
      await entry.done;
      return;
    }
    signalGroup(pid, 'SIGTERM');
    if (await settlesWithin(entry.done, STOP_GRACE_MS)) return;
    signalGroup(pid, 'SIGKILL');
    if (await settlesWithin(entry.done, STOP_GRACE_MS)) return;
    // The kernel did not report an exit (e.g. stuck in uninterruptible I/O): stop waiting for it.
    await this.finalize(entry, null, 'SIGKILL');
  }

  /** Stop all runs, optionally only those targeting `index`. */
  async stopAll(index?: number): Promise<void> {
    const targets = [...this.runs.values()].filter(
      (e) => !e.finalized && (index === undefined || e.info.index === index),
    );
    await Promise.all(targets.map((e) => this.stop(e.info.runId).catch(() => {})));
  }

  /** Runs started by this process (running first, then most recent), max 200 kept. */
  listRuns(): ScriptRunInfo[] {
    return [...this.runs.values()]
      .map((e) => ({ ...e.info }))
      .sort((a, b) => {
        const ra = a.status === 'running' ? 0 : 1;
        const rb = b.status === 'running' ? 0 : 1;
        return ra - rb || b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId);
      });
  }

  /** Scaffold an example script dir (hello-adb: python3, prints device info and taps the screen centre). */
  async createExample(): Promise<ScriptManifest> {
    const dir = path.join(this.paths.scriptsDir, EXAMPLE_SCRIPT_ID);
    await ensureDir(dir);
    const mainFile = path.join(dir, 'main.py');
    // Never clobber a user's edits: only (re)write files that are missing or unusable.
    if (!(await pathExists(mainFile))) {
      await fsp.writeFile(mainFile, EXAMPLE_MAIN_PY, { mode: 0o755 });
    }
    const current = await this.loadManifest(EXAMPLE_SCRIPT_ID);
    if (current.ok) return current.manifest;
    await fsp.writeFile(path.join(dir, SCRIPT_MANIFEST_FILE), JSON.stringify(EXAMPLE_MANIFEST, null, 2) + '\n');
    const created = await this.loadManifest(EXAMPLE_SCRIPT_ID);
    if (!created.ok) throw new AvdmError('COMMAND_FAILED', `生成示例脚本失败：${created.reason}`);
    return created.manifest;
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async loadManifest(id: string): Promise<ManifestLoad> {
    const dir = path.join(this.paths.scriptsDir, id);
    const file = path.join(dir, SCRIPT_MANIFEST_FILE);
    let text: string | undefined;
    try {
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) return { ok: false, reason: '不是目录' };
      text = await readTextIfExists(file);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    if (text === undefined) return { ok: false, reason: `缺少 ${SCRIPT_MANIFEST_FILE}` };
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `${SCRIPT_MANIFEST_FILE} 不是有效的 JSON（${(err as Error).message}）` };
    }
    return parseManifest(raw, id, dir);
  }

  private async startRun(manifest: ScriptManifest, target: ScriptTarget, args: string[]): Promise<ScriptRunInfo> {
    const runId = makeRunId(manifest.id, target.index);
    const logFile = path.join(this.paths.scriptLogsDir, `${runId}.log`);
    const startedAt = new Date().toISOString();
    const info: ScriptRunInfo = {
      runId,
      scriptId: manifest.id,
      index: target.index,
      serial: target.serial,
      status: 'running',
      startedAt,
      logFile,
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    const entry: RunEntry = { info, stopRequested: false, finalized: false, done, resolveDone };
    this.remember(entry);

    const log = createWriteStream(logFile, { flags: 'a' });
    log.on('error', () => {}); // a broken log file must not break the run; lines are still emitted
    const [cmd, ...cmdArgs] = manifest.command;
    const argv = [...cmdArgs, ...args];
    log.write(
      `# 脚本 ${manifest.name}（${manifest.id}） → 实例 #${target.index} ${target.name} ${target.serial}\n` +
        `# 命令: ${[cmd, ...argv].join(' ')}\n# 开始: ${startedAt}\n`,
    );
    entry.log = log;

    const out = new LineSplitter((line) => this.output(entry, line));
    const err = new LineSplitter((line) => this.output(entry, line));
    let child: ChildProcess;
    try {
      child = spawn(cmd!, argv, {
        cwd: manifest.dir,
        env: this.buildEnv(manifest, target),
        detached: process.platform !== 'win32', // own process group → stop() kills the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this.output(entry, `无法启动脚本进程: ${(e as Error).message}`);
      await this.finalize(entry, null, null, true);
      return { ...info };
    }
    entry.child = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (entry.finalized) return;
      log.write(chunk);
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (entry.finalized) return;
      log.write(chunk);
      err.push(chunk);
    });

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (drainTimer) clearTimeout(drainTimer);
      out.flush();
      err.flush();
      void this.finalize(entry, exit?.code ?? null, exit?.signal ?? null);
    };
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      drainTimer = setTimeout(finish, DRAIN_AFTER_EXIT_MS);
    });
    child.on('close', (code, signal) => {
      exit ??= { code, signal };
      finish();
    });

    const spawned = await new Promise<boolean>((resolve) => {
      let started = false;
      child.once('spawn', () => {
        started = true;
        resolve(true);
      });
      child.on('error', (e) => {
        if (started) {
          // e.g. a failed kill(); the process itself is still tracked through 'exit'/'close'
          this.output(entry, `脚本进程错误: ${e.message}`);
          return;
        }
        finished = true;
        this.output(entry, `无法启动脚本进程（${cmd}）: ${e.message}`);
        void this.finalize(entry, null, null, true);
        resolve(false);
      });
    });
    if (spawned) {
      info.pid = child.pid;
      this.emitRun(entry);
    }
    return { ...info };
  }

  private buildEnv(manifest: ScriptManifest, target: ScriptTarget): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', ...(manifest.env ?? {}) };
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    if (this.env.adbBin) {
      env.AVDM_ADB = this.env.adbBin;
      // Let scripts call plain `adb` and get the SDK's copy (the same one the manager uses).
      env[pathKey] = [path.dirname(this.env.adbBin), env[pathKey]].filter(Boolean).join(path.delimiter);
    }
    env[pathKey] = withUserToolDirs(env[pathKey]);
    env.ANDROID_SERIAL = target.serial;
    env.AVDM_INDEX = String(target.index);
    env.AVDM_NAME = target.name;
    env.AVDM_CONSOLE_PORT = String(target.consolePort);
    env.AVDM_ADB_PORT = String(target.adbPort);
    env.AVDM_GRPC_PORT = String(target.grpcPort);
    if (target.grpcToken) env.AVDM_GRPC_TOKEN = target.grpcToken;
    else delete env.AVDM_GRPC_TOKEN;
    env.ANDROID_SDK_ROOT = this.env.sdkRoot;
    env.AVDM_HOME = this.paths.home;
    return env;
  }

  private output(entry: RunEntry, line: string): void {
    try {
      this.events.onOutput(entry.info.runId, line);
    } catch {
      // listeners must not break the run
    }
  }

  private emitRun(entry: RunEntry): void {
    try {
      this.events.onRun({ ...entry.info });
    } catch {
      // listeners must not break the run
    }
  }

  private async finalize(
    entry: RunEntry,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnFailed = false,
  ): Promise<void> {
    if (entry.finalized) return;
    entry.finalized = true;
    const info = entry.info;
    info.endedAt = new Date().toISOString();
    info.exitCode = code;
    if (entry.stopRequested) info.status = 'stopped';
    else if (!spawnFailed && code === 0) info.status = 'exited';
    else info.status = 'failed';
    const log = entry.log;
    if (log && !log.destroyed && !log.writableEnded) {
      const how = signal ? `信号 ${signal}` : `退出码 ${code ?? '无'}`;
      await new Promise<void>((resolve) => {
        log.end(`\n# 结束: ${info.endedAt}，状态 ${STATUS_LABELS[info.status]}（${how}）\n`, () => resolve());
        // 'finish' may never fire if the stream errored.
        log.once('error', () => resolve());
      });
    }
    this.emitRun(entry);
    entry.resolveDone();
  }

  private remember(entry: RunEntry): void {
    this.runs.set(entry.info.runId, entry);
    if (this.runs.size <= MAX_KEPT_RUNS) return;
    const finished = [...this.runs.values()]
      .filter((e) => e.finalized)
      .sort((a, b) => a.info.startedAt.localeCompare(b.info.startedAt));
    for (const e of finished) {
      if (this.runs.size <= MAX_KEPT_RUNS) break;
      this.runs.delete(e.info.runId);
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

const STATUS_LABELS: Record<ScriptRunInfo['status'], string> = {
  running: '运行中',
  exited: '已完成',
  failed: '失败',
  stopped: '已停止',
};

/**
 * An app started from Finder/Dock inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so `node` or a
 * Homebrew `python3` would not be found although they work from a terminal. On macOS append the usual user tool
 * dirs (Homebrew on Apple Silicon and Intel, ~/.local/bin) when missing; the existing order still wins.
 */
export function withUserToolDirs(pathValue: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const parts = (pathValue ?? '').split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') {
    const home = os.homedir();
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', home ? path.join(home, '.local', 'bin') : '']) {
      if (dir && !parts.includes(dir)) parts.push(dir);
    }
  }
  return parts.join(path.delimiter);
}

/** A script id is its directory name: no path separators, not hidden, no control characters. */
function isValidScriptId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 128 &&
    !id.startsWith('.') &&
    !/[/\\\u0000-\u001f]/.test(id)
  );
}

function parseManifest(raw: unknown, id: string, dir: string): ManifestLoad {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `${SCRIPT_MANIFEST_FILE} 顶层必须是对象` };
  }
  const obj = raw as Record<string, unknown>;
  const command = obj.command;
  if (!Array.isArray(command) || !command[0] || command.some((c) => typeof c !== 'string')) {
    return { ok: false, reason: 'command 必须是非空字符串数组，例如 ["python3", "main.py"]' };
  }
  if (obj.name !== undefined && typeof obj.name !== 'string') return { ok: false, reason: 'name 必须是字符串' };
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    return { ok: false, reason: 'description 必须是字符串' };
  }
  let env: Record<string, string> | undefined;
  if (obj.env !== undefined && obj.env !== null) {
    if (typeof obj.env !== 'object' || Array.isArray(obj.env)) return { ok: false, reason: 'env 必须是对象' };
    env = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) {
        return { ok: false, reason: `env.${k} 必须是字符串` };
      }
      env[k] = String(v);
    }
  }
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : id;
  const manifest: ScriptManifest = { id, name, command: [...(command as string[])], dir };
  if (typeof obj.description === 'string' && obj.description.trim()) manifest.description = obj.description.trim();
  if (env) manifest.env = env;
  return { ok: true, manifest };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `<scriptId>-<index>-<yyyyMMddHHmmss>-<rand4>` (local time). */
export function makeRunId(scriptId: string, index: number, now = new Date()): string {
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${scriptId}-${index}-${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Signal a whole process group (scripts are spawned detached), falling back to the single pid. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // not a group leader / already gone
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Incremental UTF-8 decoder that emits complete lines (CR/LF handled, overlong lines split). */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.consume(this.decoder.write(chunk));
  }

  flush(): void {
    this.consume(this.decoder.end());
    if (this.pending) {
      const rest = this.pending;
      this.pending = '';
      this.onLine(rest.replace(/\r$/, ''));
    }
  }

  private consume(text: string): void {
    if (!text) return;
    this.pending += text;
    let nl: number;
    while ((nl = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, nl).replace(/\r$/, '');
      this.pending = this.pending.slice(nl + 1);
      this.onLine(line);
    }
    while (this.pending.length > MAX_LINE_CHARS) {
      this.onLine(this.pending.slice(0, MAX_LINE_CHARS));
      this.pending = this.pending.slice(MAX_LINE_CHARS);
    }
  }
}

// ───────────────────────────── example script ─────────────────────────────

const EXAMPLE_MANIFEST = {
  name: 'Hello ADB 示例',
  description: '打印设备型号与屏幕尺寸，然后点击屏幕中心一次（仅用 Python 标准库调用 adb）',
  command: ['python3', 'main.py'],
  env: {},
};

const EXAMPLE_MAIN_PY = `#!/usr/bin/env python3
"""AVD 多开管理器 示例脚本 hello-adb。

管理器为每个实例启动一个进程（工作目录 = 本脚本目录），并通过环境变量传入：
  ANDROID_SERIAL     adb 序列号，例如 emulator-5554
  AVDM_INDEX         实例编号
  AVDM_NAME          实例名称
  AVDM_ADB           SDK 中 adb 的绝对路径
  AVDM_CONSOLE_PORT / AVDM_ADB_PORT / AVDM_GRPC_PORT / AVDM_GRPC_TOKEN
标准输出/错误的每一行都会显示在管理器的脚本日志里。
本示例只使用 Python 标准库：打印设备型号与屏幕尺寸，然后点击屏幕中心一次。
"""
import os
import re
import subprocess
import sys
import time

ADB = os.environ.get("AVDM_ADB") or "adb"
SERIAL = os.environ.get("ANDROID_SERIAL", "")
INDEX = os.environ.get("AVDM_INDEX", "?")
NAME = os.environ.get("AVDM_NAME", "")


def log(message):
    print("[%s] %s" % (time.strftime("%H:%M:%S"), message), flush=True)


def adb(*args, timeout=30):
    """Run adb against this instance and return stdout (raises on failure)."""
    cmd = [ADB]
    if SERIAL:
        cmd += ["-s", SERIAL]
    cmd += list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError("adb %s 失败: %s" % (" ".join(args), detail))
    return result.stdout.strip()


def screen_size():
    """Parse \`wm size\`; an "Override size" line (printed last) wins over "Physical size"."""
    out = adb("shell", "wm size")
    sizes = re.findall(r"(\\d+)x(\\d+)", out)
    if not sizes:
        raise RuntimeError("无法解析屏幕尺寸: %r" % out)
    width, height = sizes[-1]
    return int(width), int(height)


def main():
    log("实例 #%s %s（%s）开始运行" % (INDEX, NAME, SERIAL or "未指定序列号"))
    model = adb("shell", "getprop ro.product.model")
    log("设备型号: %s" % (model or "未知"))
    width, height = screen_size()
    log("屏幕尺寸: %dx%d" % (width, height))
    x, y = width // 2, height // 2
    adb("shell", "input tap %d %d" % (x, y))
    log("已点击屏幕中心 (%d, %d)" % (x, y))
    log("完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # report any failure as one readable line
        log("出错: %s" % exc)
        sys.exit(1)
`;
