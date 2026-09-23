import type { InstanceState, StartOptions, StopOptions } from '@avdm/core';
import type { Command } from 'commander';
import { c, colorStatus, statusLabel } from '../ui/colors.js';
import { abortable, CancelledError, isCancelled, out, resolveSelector, runBatch, withManager } from '../runtime.js';
import type { CommandContext } from '../runtime.js';
import { publicState } from '../util/format.js';
import { intInRange, secondsToMs } from '../util/parse.js';

/**
 * Lifecycle: start, stop, restart.
 * Manager methods: indices, start, stop, waitForBoot, batch, registry.list.
 *
 * All three are "mutating" (see withManager): the first Ctrl-C lets launches/stops already under way
 * finish — a launch holds `run/launch.lock` — and skips the remaining instances; waiting for boot is
 * abandoned right away (the emulator keeps booting).
 */

function describeState(st: InstanceState): string {
  const p = c();
  const pid = st.pid ? `, pid ${st.pid}` : '';
  return `→ ${colorStatus(st.status, statusLabel(st.status), p)} ${p.gray(`(${st.ports.serial}${pid})`)}`;
}

/**
 * Launch (no wait inside core, so Ctrl-C can abandon just the waiting part), then optionally wait for
 * boot. Interrupted while waiting → CancelledError "已启动，未等待开机完成" (reported as ⚠, not ✗).
 */
async function startInstance(
  ctx: CommandContext,
  index: number,
  opts: StartOptions,
): Promise<InstanceState> {
  const { wait, timeoutMs, ...launchOpts } = opts;
  const state = await ctx.manager.start(index, { ...launchOpts, wait: false });
  if (!wait) return state;
  try {
    return await abortable(ctx.manager.waitForBoot(index, timeoutMs), ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted && isCancelled(err)) throw new CancelledError('已启动，未等待开机完成（已中断）');
    throw err;
  }
}

export function registerLifecycleCommands(program: Command): void {
  program
    .command('start <sel>')
    .description('启动实例（sel: all | 0 | 0,2,5 | 1-4）')
    .option('--wait', '等待 Android 开机完成')
    .option('--timeout <秒>', '配合 --wait 的超时（默认取设置 bootTimeoutSec）', secondsToMs)
    .option('--window', '本次启动显示模拟器窗口')
    .option('--force', '跳过最大运行数/内存准入检查')
    .option('-j, --jobs <n>', '并发数', intInRange(1, 64), 3)
    .option('--json', '输出 JSON')
    .action(
      async (
        sel: string,
        opts: { wait?: boolean; timeout?: number; window?: boolean; force?: boolean; jobs: number; json?: boolean },
      ) => {
        await withManager({ json: opts.json, mutating: true }, async (ctx) => {
          const indices = await resolveSelector(ctx.manager, sel);
          const startOpts: StartOptions = { wait: Boolean(opts.wait), force: Boolean(opts.force) };
          if (opts.window) startOpts.headless = false;
          if (opts.timeout !== undefined) startOpts.timeoutMs = opts.timeout;
          const results = await runBatch(ctx, indices, (i) => startInstance(ctx, i, startOpts), {
            label: opts.wait ? '启动并等待开机' : '启动',
            concurrency: opts.jobs,
            describe: describeState,
            toJson: publicState,
          });
          if (!ctx.json && !opts.wait && results.some((r) => r.ok)) {
            out(c().gray('提示: 使用 `avdm list` 查看状态，或加 --wait 等待开机完成'));
          }
        });
      },
    );

  program
    .command('stop <sel>')
    .description('停止实例（默认经控制台优雅关机并保存快照）')
    .option('--force', '直接强制结束进程（不保存快照）')
    .option('--timeout <秒>', '优雅关机超时（默认 60 秒）', secondsToMs)
    .option('-j, --jobs <n>', '并发数', intInRange(1, 64), 8)
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: { force?: boolean; timeout?: number; jobs: number; json?: boolean }) => {
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const indices = await resolveSelector(ctx.manager, sel);
        const stopOpts: StopOptions = { force: Boolean(opts.force) };
        if (opts.timeout !== undefined) stopOpts.timeoutMs = opts.timeout;
        await runBatch(ctx, indices, (i) => ctx.manager.stop(i, stopOpts), {
          label: '停止',
          concurrency: opts.jobs,
          describe: () => `→ ${colorStatus('stopped', statusLabel('stopped'))}`,
          toJson: () => null,
        });
      });
    });

  program
    .command('restart <sel>')
    .description('重启实例')
    .option('--wait', '等待 Android 开机完成')
    .option('--force', '跳过准入检查')
    .option('-j, --jobs <n>', '并发数', intInRange(1, 64), 3)
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: { wait?: boolean; force?: boolean; jobs: number; json?: boolean }) => {
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const indices = await resolveSelector(ctx.manager, sel);
        await runBatch(
          ctx,
          indices,
          async (i) => {
            // manager.restart() = stop + start; split so a Ctrl-C during the stop does not start it again.
            await ctx.manager.stop(i);
            if (ctx.signal.aborted) throw new CancelledError('已停止，未重新启动（已中断）');
            return startInstance(ctx, i, { wait: Boolean(opts.wait), force: Boolean(opts.force) });
          },
          {
            label: '重启',
            concurrency: opts.jobs,
            describe: describeState,
            toJson: publicState,
          },
        );
      });
    });
}
