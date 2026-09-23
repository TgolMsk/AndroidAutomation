import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AvdmError } from '@avdm/core';
import type { Command } from 'commander';
import { c, ce } from '../ui/colors.js';
import type { Palette } from '../ui/colors.js';
import {
  assertRunning,
  CancelledError,
  instanceStates,
  note,
  out,
  printJson,
  printJsonLine,
  resolveSelector,
  runBatch,
  withManager,
} from '../runtime.js';
import type { BatchOptions, CommandContext } from '../runtime.js';
import { fileSize, followFile, LineSplitter, readTail } from '../util/files.js';
import { fileTimestamp } from '../util/format.js';
import {
  coordinate,
  intInRange,
  nonNegativeInt,
  nonNegativeSecondsToMs,
  parseSingleIndex,
  positiveInt,
} from '../util/parse.js';

/**
 * Device operations on running instances: shell, install, app, screenshot, tap, swipe, key, text, view, logs.
 * Manager methods: indices, list, device (AdbDevice.shell/startApp/stopApp/listPackages/tap/swipe/keyevent/text),
 * installApk, screenshot, openScrcpy, instanceLog, paths.logsDir, batch, registry.list.
 */

/**
 * `adb -s <serial> shell <command>` with output streamed as it arrives: raw for a single instance,
 * line by line with a "[#i] " prefix when several instances are targeted. stdout is also collected
 * for `--json`. `timeoutMs` 0 = no limit. Rejects with a readable message on a non-zero exit status,
 * on timeout ("超时（N 秒）") and — as CancelledError — when `signal` aborts (the adb child is killed).
 */
function streamShell(opts: {
  bin: string;
  serial: string;
  command: string;
  index: number;
  prefixed: boolean;
  json: boolean;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<string> {
  const { index, prefixed, json } = opts;
  return new Promise<string>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new CancelledError('已中断，未执行'));
      return;
    }
    const child = spawn(opts.bin, ['-s', opts.serial, 'shell', opts.command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = (p: Palette) => p.cyan(`[#${index}]`);
    let collected = '';
    let errTail = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const sink = (stream: NodeJS.WriteStream, palette: () => Palette) => {
      const decoder = new StringDecoder('utf8');
      const lines = new LineSplitter();
      let openLine = false; // raw mode: the last text written did not end with a newline
      const emit = (text: string) => {
        if (json || !text) return;
        if (!prefixed) {
          stream.write(text);
          openLine = !text.endsWith('\n');
          return;
        }
        for (const line of lines.push(text)) stream.write(`${prefix(palette())} ${line}\n`);
      };
      return {
        write: (chunk: Buffer) => {
          const text = decoder.write(chunk);
          emit(text);
          return text;
        },
        end: () => {
          emit(decoder.end());
          if (json) return;
          if (prefixed) for (const line of lines.flush()) stream.write(`${prefix(palette())} ${line}\n`);
          else if (openLine) stream.write('\n');
        },
      };
    };
    const outSink = sink(process.stdout, c);
    const errSink = sink(process.stderr, ce);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = outSink.write(chunk);
      if (json && collected.length < MAX_COLLECT) collected += text;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errTail = (errTail + errSink.write(chunk)).slice(-4096);
    });
    const timer = opts.timeoutMs > 0 ? setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs) : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
    };
    child.once('error', (err) => {
      cleanup();
      reject(new AvdmError('COMMAND_FAILED', `无法运行 adb（${opts.bin}）: ${err.message}`));
    });
    const settle = (code: number | null, sig: NodeJS.Signals | null) => {
      outSink.end();
      errSink.end();
      if (timedOut) {
        reject(
          new AvdmError(
            'COMMAND_FAILED',
            `超时（${formatSeconds(opts.timeoutMs)} 秒），已终止命令（可用 --timeout 调整，0 为不限时）`,
            { stdout: collected, stderr: errTail },
          ),
        );
      } else if (aborted || opts.signal.aborted) {
        reject(new CancelledError('已中断'));
      } else if (code === 0) {
        resolve(collected);
      } else {
        const why = errTail.trim().split(/\r?\n/).pop()?.trim();
        const status = code !== null ? `退出码 ${code}` : `被信号 ${sig ?? '未知'} 终止`;
        reject(new AvdmError('COMMAND_FAILED', `命令失败（${status}）${why ? `: ${why}` : ''}`, { stdout: collected, stderr: errTail }));
      }
    };
    child.once('close', (code, sig) => {
      cleanup();
      // adb killed by the terminal's Ctrl-C, which reaches us as well: give our own handler a moment to
      // abort first, so this is reported as interrupted rather than as a failure.
      if (sig && sig !== 'SIGKILL' && !aborted && !timedOut && !opts.signal.aborted) setTimeout(() => settle(code, sig), 200);
      else settle(code, sig);
    });
  });
}

/** Cap for stdout kept in memory for `shell --json` (the old execFile maxBuffer). */
const MAX_COLLECT = 64 * 1024 * 1024;

function formatSeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/** Run `fn` on each selected, running instance (non-running ones fail with INSTANCE_NOT_RUNNING). */
async function onRunning<T>(
  ctx: CommandContext,
  sel: string | number[],
  fn: (index: number) => Promise<T>,
  opts: BatchOptions<T>,
) {
  const indices = typeof sel === 'string' ? await resolveSelector(ctx.manager, sel) : sel;
  const states = indices.length ? await instanceStates(ctx.manager) : new Map();
  return runBatch(
    ctx,
    indices,
    async (i) => {
      assertRunning(states, i);
      return fn(i);
    },
    opts,
  );
}

function jobsOption(cmd: Command, def: number): Command {
  return cmd.option('-j, --jobs <n>', '并发数', intInRange(1, 64), def);
}

export function registerDeviceCommands(program: Command): void {
  // ── shell ──
  jobsOption(
    program
      .command('shell <sel> <cmd...>')
      .description('在实例上并发执行 adb shell 命令并实时输出，例如: avdm shell all -- getprop ro.product.model')
      .option('--timeout <秒>', '单个实例的超时，超时后终止命令（默认 0 = 不限时）', nonNegativeSecondsToMs, 0),
    8,
  )
    .option('--json', '输出 JSON')
    .action(async (sel: string, cmd: string[], opts: { jobs: number; timeout: number; json?: boolean }) => {
      const command = cmd.join(' ');
      // Interruptible: Ctrl-C (or SIGTERM/SIGHUP) kills the adb children instead of leaving them running.
      await withManager({ json: opts.json, interruptible: true }, async (ctx) => {
        const indices = await resolveSelector(ctx.manager, sel);
        const prefixed = indices.length > 1;
        await onRunning(
          ctx,
          indices,
          async (i) => {
            const dev = await ctx.manager.device(i);
            return streamShell({
              bin: dev.adb.bin,
              serial: dev.serial,
              command,
              index: i,
              prefixed,
              json: ctx.json,
              timeoutMs: opts.timeout,
              signal: ctx.signal,
            });
          },
          { label: '执行', concurrency: opts.jobs, quietSuccess: true, noProgress: true },
        );
      });
    });

  // ── install ──
  jobsOption(program.command('install <sel> <apk...>').description('安装 APK（多个文件按拆分 APK 一起安装）'), 3)
    .option('--json', '输出 JSON')
    .action(async (sel: string, apks: string[], opts: { jobs: number; json?: boolean }) => {
      const files = apks.map((f) => path.resolve(f));
      for (const f of files) {
        const size = await fileSize(f);
        if (size === undefined) throw new AvdmError('INVALID_ARGUMENT', `文件不存在: ${f}`);
      }
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, (i) => ctx.manager.installApk(i, files), {
          label: '安装',
          concurrency: opts.jobs,
          describe: (output) => c().gray(lastLine(output)),
        });
      });
    });

  // ── app ──
  const app = program.command('app').description('应用管理：start | stop | list');
  jobsOption(app.command('start <sel> <package>').description('启动应用（可写作 包名/Activity）'), 8)
    .option('--json', '输出 JSON')
    .action(async (sel: string, pkg: string, opts: { jobs: number; json?: boolean }) => {
      const [name, activity] = splitComponent(pkg);
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).startApp(name, activity), {
          label: '启动应用',
          concurrency: opts.jobs,
          describe: () => c().gray(`已启动 ${pkg}`),
          toJson: () => null,
        });
      });
    });
  jobsOption(app.command('stop <sel> <package>').description('强制停止应用'), 8)
    .option('--json', '输出 JSON')
    .action(async (sel: string, pkg: string, opts: { jobs: number; json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).stopApp(pkg), {
          label: '停止应用',
          concurrency: opts.jobs,
          describe: () => c().gray(`已停止 ${pkg}`),
          toJson: () => null,
        });
      });
    });
  app
    .command('list <index>')
    .description('列出已安装应用（默认仅第三方应用）')
    .option('-a, --all', '包含系统应用')
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: { all?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const index = parseSingleIndex(sel, await ctx.manager.indices());
        assertRunning(await instanceStates(ctx.manager), index);
        const pkgs = await (await ctx.manager.device(index)).listPackages({ thirdPartyOnly: !opts.all });
        if (ctx.json) {
          printJson(pkgs);
          return;
        }
        if (pkgs.length === 0) out(c().gray(opts.all ? '（没有已安装的应用）' : '（没有第三方应用，加 -a 查看系统应用）'));
        for (const p of pkgs) out(p);
      });
    });

  // ── screenshot ──
  jobsOption(
    program
      .command('screenshot <sel>')
      .description('截图保存为 PNG：<目录>/avdm-<编号>-<时间>.png')
      .option('-o, --output <dir>', '保存目录', '.')
      .option('--width <n>', '缩放到指定宽度（像素）', positiveInt),
    4,
  )
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: { output: string; width?: number; jobs: number; json?: boolean }) => {
      const dir = path.resolve(opts.output);
      const stamp = fileTimestamp();
      await withManager({ json: opts.json }, async (ctx) => {
        await fsp.mkdir(dir, { recursive: true });
        await onRunning(
          ctx,
          sel,
          async (i) => {
            const png = await ctx.manager.screenshot(i, opts.width ? { width: opts.width } : {});
            const file = path.join(dir, `avdm-${i}-${stamp}.png`);
            await fsp.writeFile(file, png);
            return file;
          },
          { label: '截图', concurrency: opts.jobs, describe: (file) => c().gray(`→ ${file}`) },
        );
      });
    });

  // ── input ──
  program
    .command('tap')
    .description('点击屏幕坐标（设备像素）')
    .argument('<sel>', '实例选择器')
    .argument('<x>', 'X 坐标', coordinate)
    .argument('<y>', 'Y 坐标', coordinate)
    .option('--json', '输出 JSON')
    .action(async (sel: string, x: number, y: number, opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).tap(x, y), {
          label: '点击',
          concurrency: 8,
          describe: () => c().gray(`tap ${x},${y}`),
          toJson: () => null,
        });
      });
    });

  program
    .command('swipe')
    .description('滑动')
    .argument('<sel>', '实例选择器')
    .argument('<x1>', '起点 X', coordinate)
    .argument('<y1>', '起点 Y', coordinate)
    .argument('<x2>', '终点 X', coordinate)
    .argument('<y2>', '终点 Y', coordinate)
    .argument('[ms]', '持续时间（毫秒）', nonNegativeInt, 300)
    .option('--json', '输出 JSON')
    .action(
      async (sel: string, x1: number, y1: number, x2: number, y2: number, ms: number, opts: { json?: boolean }) => {
        await withManager({ json: opts.json }, async (ctx) => {
          await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).swipe(x1, y1, x2, y2, ms), {
            label: '滑动',
            concurrency: 8,
            describe: () => c().gray(`swipe ${x1},${y1} → ${x2},${y2} ${ms}ms`),
            toJson: () => null,
          });
        });
      },
    );

  program
    .command('key <sel> <code>')
    .description('发送按键：键码数字或名称，如 4、BACK、HOME、KEYCODE_ENTER')
    .option('--json', '输出 JSON')
    .action(async (sel: string, code: string, opts: { json?: boolean }) => {
      const key: number | string = /^\d+$/.test(code) ? Number(code) : code.toUpperCase();
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).keyevent(key), {
          label: '按键',
          concurrency: 8,
          describe: () => c().gray(`key ${key}`),
          toJson: () => null,
        });
      });
    });

  program
    .command('text <sel> <text...>')
    .description('输入文本（多个参数以空格连接）')
    .option('--json', '输出 JSON')
    .action(async (sel: string, words: string[], opts: { json?: boolean }) => {
      const value = words.join(' ');
      await withManager({ json: opts.json }, async (ctx) => {
        await onRunning(ctx, sel, async (i) => (await ctx.manager.device(i)).text(value), {
          label: '输入',
          concurrency: 8,
          describe: () => c().gray(`已输入 ${value.length} 个字符`),
          toJson: () => null,
        });
      });
    });

  // ── view (scrcpy) ──
  program
    .command('view <index> [args...]')
    .description('用 scrcpy 打开实例画面（-- 之后的参数传给 scrcpy）')
    .option('--json', '输出 JSON')
    .action(async (sel: string, args: string[], opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const index = parseSingleIndex(sel, await ctx.manager.indices());
        assertRunning(await instanceStates(ctx.manager), index);
        const { pid } = await ctx.manager.openScrcpy(index, args);
        if (ctx.json) printJson({ index, pid });
        else out(`${c().green('✓')} 已打开 scrcpy 窗口 #${index}（pid ${pid}）`);
      });
    });

  // ── logs ──
  program
    .command('logs <index>')
    .description('查看实例的模拟器日志')
    .option('-n, --lines <n>', '显示最后 N 行', positiveInt, 200)
    .option('-f, --follow', '持续输出新日志（Ctrl-C 退出）')
    .option('--json', '输出 JSON（配合 -f 时每行一个 JSON 对象）')
    .action(async (sel: string, opts: { lines: number; follow?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json, interruptible: Boolean(opts.follow) }, async (ctx) => {
        const index = parseSingleIndex(sel, await ctx.manager.indices());
        const file = path.join(ctx.manager.paths.logsDir, `instance-${index}.log`);
        // -f: read the tail from the same open file that the follow position and identity come from, so
        // lines written meanwhile are neither lost nor printed twice.
        const tail = opts.follow ? await readTail(file, opts.lines) : undefined;
        const lines = tail ? tail.lines : await ctx.manager.instanceLog(index, opts.lines);
        if (ctx.json && !opts.follow) {
          printJson({ index, file, lines });
          return;
        }
        if (ctx.json) for (const line of lines) printJsonLine({ index, line });
        else if (lines.length) out(lines.join('\n'));
        else note(ctx, `（暂无日志: ${file}）`);
        if (!opts.follow) return;

        note(ctx, `—— 正在跟踪 ${file}（Ctrl-C 退出）——`);
        const splitter = new LineSplitter();
        await followFile(file, {
          from: tail?.offset ?? 0,
          ...(tail?.identity ? { identity: tail.identity } : {}),
          signal: ctx.signal,
          onData: (text) => {
            if (!ctx.json) {
              process.stdout.write(text);
              return;
            }
            for (const line of splitter.push(text)) printJsonLine({ index, line });
          },
          onTruncate: () => note(ctx, '（日志文件已被截断或重建，从头读取）'),
        });
        if (ctx.json) for (const line of splitter.flush()) printJsonLine({ index, line });
      });
    });
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** "com.foo/.MainActivity" → ["com.foo", ".MainActivity"] */
function splitComponent(pkg: string): [string, string | undefined] {
  const slash = pkg.indexOf('/');
  if (slash < 0) return [pkg, undefined];
  return [pkg.slice(0, slash), pkg.slice(slash + 1) || undefined];
}
