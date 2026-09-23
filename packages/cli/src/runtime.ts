import { AvdManager, AvdmError, parseSelector } from '@avdm/core';
import type { AvdmErrorCode, InstanceState } from '@avdm/core';
import { c, ce, failMark, okMark, statusLabel, warnMark } from './ui/colors.js';
import { formatDuration, StatusLine } from './ui/progress.js';
import { deferInterrupt, killTerminalChild, setInterruptReplay } from './ui/terminal.js';
import { errorMessage } from './util/format.js';

/**
 * Shared plumbing for commands: opening/disposing the manager, Ctrl-C handling, JSON output,
 * batch execution with ✓/✗ lines and error reporting.
 */

export interface CommandContext {
  manager: AvdManager;
  /** `--json`: print machine-readable JSON on stdout and nothing else. */
  json: boolean;
  /** Aborted on the first Ctrl-C (SIGINT) / SIGTERM / SIGHUP. */
  signal: AbortSignal;
}

export interface ManagerRunOptions {
  json?: boolean;
  /**
   * The command handles Ctrl-C itself by watching `ctx.signal` (long-running commands). Otherwise the
   * first Ctrl-C disposes the manager and exits with code 130. A second Ctrl-C always exits immediately.
   */
  interruptible?: boolean;
  /**
   * The command changes instances (create/clone/start/stop/restart/rm/set). The first Ctrl-C must not
   * exit mid-operation — core would be killed before it rolls back a half-created instance or releases
   * `run/launch.lock`. Instead `ctx.signal` aborts (runBatch skips instances not started yet, waits are
   * abandoned) and the operations already running finish. A second Ctrl-C still exits immediately.
   */
  mutating?: boolean;
}

export const debugEnabled = (): boolean => Boolean(process.env.AVDM_DEBUG && process.env.AVDM_DEBUG !== '0');

export function debugLog(what: string, err: unknown): void {
  if (!debugEnabled()) return;
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(ce().gray(`[debug] ${what}: ${detail}`) + '\n');
}

/** Signals that interrupt a command. SIGHUP: the terminal was closed (script runs must still be stopped). */
const INTERRUPT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** Delay before an interruptible command that is still cleaning up tells the user so. */
const CANCEL_NOTICE_MS = 500;

let outputErrorsIgnored = false;

/** The controlling terminal went away (SIGHUP): later writes to it fail with EIO, which must not crash us. */
function ignoreOutputErrors(): void {
  if (outputErrorsIgnored) return;
  outputErrorsIgnored = true;
  const ignore = () => {};
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
}

function interruptReason(signal: NodeJS.Signals): string {
  if (signal === 'SIGINT') return '用户中断';
  if (signal === 'SIGHUP') return '终端已关闭';
  return `收到 ${signal}`;
}

/**
 * Open the manager, run `fn`, and always dispose the manager afterwards (also on Ctrl-C).
 * For interruptible and mutating commands an error thrown after Ctrl-C is reported as "已取消" (exit code 130).
 */
export async function withManager(opts: ManagerRunOptions, fn: (ctx: CommandContext) => Promise<void>): Promise<void> {
  const manager = await AvdManager.open();
  const controller = new AbortController();
  let interrupts = 0;
  let disposed = false;
  let settled = false;
  let hungUp = false;
  /** A status message about the interrupt itself (stderr; dropped once the terminal is gone). */
  const interruptNote = (text: string) => {
    if (!hungUp) process.stderr.write('\n' + ce().yellow(text) + '\n');
  };
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await manager.dispose();
    } catch (err) {
      debugLog('manager.dispose', err);
    }
  };
  const forceExit = async () => {
    interruptNote('已强制退出');
    await killTerminalChild();
    process.exit(130);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    // Ctrl-C while the license pager owns the terminal belongs to the pager; replayed when it exits.
    if (signal === 'SIGINT' && deferInterrupt()) return;
    if (signal === 'SIGHUP') {
      hungUp = true;
      ignoreOutputErrors();
    }
    interrupts++;
    if (interrupts > 1) {
      void forceExit();
      return;
    }
    controller.abort(new CancelledError(interruptReason(signal)));
    // SIGTERM/SIGHUP reach only us, not a pager that owns the terminal: close it so the command can stop.
    void killTerminalChild();
    if (opts.mutating) {
      interruptNote('正在完成当前操作…（再按一次 Ctrl-C 强制退出）');
    } else if (!opts.interruptible) {
      interruptNote('已中断');
      void dispose().finally(() => flushAndExit(130));
    } else {
      setTimeout(() => {
        if (!settled) interruptNote('正在取消…（再按一次 Ctrl-C 强制退出）');
      }, CANCEL_NOTICE_MS).unref();
    }
  };
  for (const sig of INTERRUPT_SIGNALS) process.on(sig, onSignal);
  setInterruptReplay(() => onSignal('SIGINT'));
  try {
    await fn({ manager, json: Boolean(opts.json), signal: controller.signal });
  } catch (err) {
    if (!((opts.interruptible || opts.mutating) && controller.signal.aborted)) throw err;
    debugLog('after interrupt', err);
    if (!hungUp) process.stderr.write(ce().yellow('已取消') + '\n');
    process.exitCode = 130;
  } finally {
    // Still listening while disposing: a second Ctrl-C during a slow cleanup must force the exit.
    await dispose();
    settled = true;
    setInterruptReplay(undefined);
    for (const sig of INTERRUPT_SIGNALS) process.off(sig, onSignal);
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
  readonly code = 'CANCELLED';
}

export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'CancelledError';
}

/** Reject as soon as `signal` aborts (the underlying operation keeps running in the background). */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new CancelledError('已取消'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new CancelledError('已取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Resolves when `signal` is aborted (keeps the event loop alive until then). */
export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(keepAlive);
        resolve();
      },
      { once: true },
    );
  });
}

// ───────────────────────────── Output ─────────────────────────────

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonReplacer, 2) + '\n');
}

/** One compact JSON object per line (streaming output such as `monitor --json`). */
export function printJsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonReplacer) + '\n');
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { message: value.message, ...(isCodedError(value) ? { code: value.code } : {}) };
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  return value;
}

export function out(line = ''): void {
  process.stdout.write(line + '\n');
}

/** Informational/progress text that must not pollute stdout (goes to stderr; suppressed in JSON mode). */
export function note(ctx: { json: boolean } | boolean, line: string): void {
  const json = typeof ctx === 'boolean' ? ctx : ctx.json;
  if (json) return;
  process.stderr.write(ce().gray(line) + '\n');
}

export async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((r) => process.stdout.write('', () => r()));
  await new Promise<void>((r) => process.stderr.write('', () => r()));
  process.exit(code);
}

// ───────────────────────────── Errors ─────────────────────────────

interface CodedError extends Error {
  code: string;
}

function isCodedError(err: unknown): err is CodedError {
  return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

/** AvdmError check that also works if two copies of @avdm/core were loaded. */
export function isAvdmLike(err: unknown): err is CodedError & { code: AvdmErrorCode } {
  return isCodedError(err) && err.name === 'AvdmError';
}

const HINTS: Partial<Record<AvdmErrorCode, string>> = {
  SDK_MISSING: '运行 `avdm sdk install` 安装 SDK 组件，或 `avdm settings set sdkRoot <路径>` 指定已有 SDK',
  EMULATOR_MISSING: '运行 `avdm sdk install emulator` 安装模拟器',
  ADB_MISSING: '运行 `avdm sdk install platform-tools` 安装 adb',
  IMAGE_MISSING: '运行 `avdm sdk install` 安装默认镜像，或 `avdm sdk images` 查看可用镜像',
  LICENSE_NOT_ACCEPTED: '运行 `avdm sdk install` 阅读并接受许可',
  ADMISSION_DENIED: '可先停止部分实例，或加 --force 跳过准入检查',
  INSTANCE_RUNNING: '先运行 `avdm stop <实例>` 停止实例',
  INSTANCE_NOT_RUNNING: '先运行 `avdm start <实例> --wait` 启动实例',
  NO_FREE_INDEX: '可用 `avdm rm <实例>` 删除不再需要的实例',
};

/** Print an error: AvdmError → "错误: <message>" (+ hint); anything else also gets a stack with AVDM_DEBUG=1. */
export function reportError(err: unknown): void {
  const p = ce();
  if (isAvdmLike(err)) {
    process.stderr.write(`${p.red('错误:')} ${err.message}\n`);
    const hint = HINTS[err.code];
    if (hint) process.stderr.write(p.gray(`提示: ${hint}`) + '\n');
    if (debugEnabled() && err.stack) process.stderr.write(p.gray(err.stack) + '\n');
    return;
  }
  process.stderr.write(`${p.red('错误:')} ${errorMessage(err)}\n`);
  if (debugEnabled()) {
    if (err instanceof Error && err.stack) process.stderr.write(p.gray(err.stack) + '\n');
  } else {
    process.stderr.write(p.gray('（设置环境变量 AVDM_DEBUG=1 可查看详细堆栈）') + '\n');
  }
}

export function markFailed(code = 1): void {
  const current = Number(process.exitCode ?? 0) || 0;
  if (current === 0) process.exitCode = code;
}

// ───────────────────────────── Selectors / instances ─────────────────────────────

export async function resolveSelector(manager: AvdManager, sel: string): Promise<number[]> {
  return parseSelector(sel, await manager.indices());
}

/** index → display name. */
export async function instanceNames(manager: AvdManager): Promise<Map<number, string>> {
  const records = await manager.registry.list();
  return new Map(records.map((r) => [r.index, r.name]));
}

/** index → computed state (one `list()` call). */
export async function instanceStates(manager: AvdManager): Promise<Map<number, InstanceState>> {
  const states = await manager.list();
  return new Map(states.map((s) => [s.record.index, s]));
}

/** Throw INSTANCE_NOT_RUNNING unless the instance has fully booted. */
export function assertRunning(states: Map<number, InstanceState>, index: number): InstanceState {
  const st = states.get(index);
  if (!st) throw new AvdmError('INSTANCE_NOT_FOUND', `实例 ${index} 不存在`);
  if (st.status !== 'running') {
    throw new AvdmError('INSTANCE_NOT_RUNNING', `实例未运行（当前状态: ${statusLabel(st.status)}）`);
  }
  return st;
}

// ───────────────────────────── Batch ─────────────────────────────

export type BatchOutcome<T> = { index: number; ok: true; value: T } | { index: number; ok: false; error: Error };

export interface BatchOptions<T> {
  concurrency?: number;
  /** Verb shown on the TTY progress line, e.g. "启动". */
  label: string;
  /** Extra text after "✓ #i 名称". */
  describe?: (value: T, index: number) => string | undefined;
  /** Value representation in `--json` output (default: the value itself). */
  toJson?: (value: T, index: number) => unknown;
  /** Do not print ✓ lines (the command prints its own output, e.g. `shell`). */
  quietSuccess?: boolean;
  /** No transient TTY progress line (the command streams its own output while running, e.g. `shell`). */
  noProgress?: boolean;
  /** Print the JSON result array (default true in JSON mode). */
  printJsonResult?: boolean;
}

/**
 * Run `fn` for every index via manager.batch (bounded concurrency). Prints "✓ #i 名称" / "✗ #i 原因"
 * as each finishes, a summary for multi-instance runs, and sets exit code 1 if anything failed.
 *
 * After Ctrl-C (`ctx.signal` aborted) instances that have not started yet are skipped, and a
 * CancelledError thrown by `fn` counts as cancelled rather than failed ("⚠ #i …"); exit code 130.
 */
export async function runBatch<T>(
  ctx: CommandContext,
  indices: number[],
  fn: (index: number) => Promise<T>,
  opts: BatchOptions<T>,
): Promise<Array<BatchOutcome<T>>> {
  const { manager, json, signal } = ctx;
  if (indices.length === 0) {
    if (json) {
      if (opts.printJsonResult !== false) printJson([]);
    } else {
      out(c().yellow('没有匹配的实例'));
    }
    return [];
  }

  const names = await instanceNames(manager).catch(() => new Map<number, string>());
  const name = (i: number) => names.get(i) ?? '';
  const p = c();
  const status = new StatusLine(process.stderr, Boolean(process.stderr.isTTY) && !json && !opts.noProgress);
  const active = new Set<number>();
  const cancelled = new Set<number>();
  let finished = 0;
  const startedAt = Date.now();
  const render = () => {
    if (!status.tty) return;
    const running = [...active].slice(0, 6).map((i) => `#${i}`).join(' ');
    const more = active.size > 6 ? ` 等 ${active.size} 个` : '';
    status.update(
      p.gray(
        `${opts.label} ${finished}/${indices.length}${running ? ` · 进行中 ${running}${more}` : ''} · 已用 ${formatDuration(Date.now() - startedAt)}`,
      ),
    );
  };
  const timer = status.tty ? setInterval(render, 1000) : undefined;
  timer?.unref();
  const logCancelled = (index: number, why: string) => {
    cancelled.add(index);
    if (!json) status.log(`${warnMark(p)} #${index} ${name(index)} ${why}`.replace(/ {2,}/g, ' '));
  };

  let results: Array<BatchOutcome<T>>;
  try {
    results = await manager.batch(
      indices,
      async (index) => {
        if (signal.aborted) {
          // Interrupted: do not begin work on instances that have not started yet.
          finished++;
          logCancelled(index, '已跳过（已中断）');
          render();
          throw new CancelledError('已中断，未执行');
        }
        active.add(index);
        render();
        try {
          const value = await fn(index);
          finished++;
          active.delete(index);
          if (!json && !opts.quietSuccess) {
            const extra = opts.describe?.(value, index);
            status.log(`${okMark(p)} #${index} ${name(index)}${extra ? ` ${extra}` : ''}`.trimEnd());
          }
          render();
          return value;
        } catch (err) {
          finished++;
          active.delete(index);
          if (signal.aborted && isCancelled(err)) {
            logCancelled(index, errorMessage(err));
          } else {
            if (!json) status.log(`${failMark(p)} #${index} ${errorMessage(err)}`);
            if (!isAvdmLike(err)) debugLog(`#${index}`, err);
          }
          render();
          throw err;
        }
      },
      { concurrency: opts.concurrency },
    );
  } finally {
    if (timer) clearInterval(timer);
    status.done();
  }

  const failed = results.filter((r) => !r.ok && !cancelled.has(r.index)).length;
  if (failed > 0) markFailed();
  if (cancelled.size > 0) process.exitCode = 130;
  if (json) {
    if (opts.printJsonResult !== false) {
      printJson(
        results.map((r) =>
          r.ok
            ? { index: r.index, name: name(r.index), ok: true, value: opts.toJson ? opts.toJson(r.value, r.index) : r.value }
            : {
                index: r.index,
                name: name(r.index),
                ok: false,
                ...(cancelled.has(r.index) ? { cancelled: true } : {}),
                error: { code: isCodedError(r.error) ? r.error.code : undefined, message: errorMessage(r.error) },
              },
        ),
      );
    }
  } else if (indices.length > 1 || cancelled.size > 0) {
    const ok = results.length - failed - cancelled.size;
    const summary =
      `完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个` : ''}${cancelled.size ? `，已中断 ${cancelled.size} 个` : ''}` +
      `（用时 ${formatDuration(Date.now() - startedAt)}）`;
    out(failed || cancelled.size ? p.yellow(summary) : p.gray(summary));
  }
  return results;
}
