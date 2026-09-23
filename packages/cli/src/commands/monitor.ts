import type { InstanceState, InstanceStatus } from '@avdm/core';
import type { Command } from 'commander';
import { c, colorStatus, statusLabel } from '../ui/colors.js';
import { out, printJsonLine, waitForAbort, withManager } from '../runtime.js';
import { cleanLogMessage, clockTime, errorSummary, publicState } from '../util/format.js';
import { printStateTable } from './instances.js';

/**
 * `avdm monitor`: foreground health monitor with auto-restart; prints events until Ctrl-C.
 * Manager methods: list, getSettings, startMonitor, stopMonitor, events 'instance-state' / 'log' / 'instances-changed'.
 */
export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('前台健康监控：打印状态变化，自动重启开启了“崩溃自动重启”的实例（Ctrl-C 退出）')
    .option('--json', '每个事件输出一行 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json, interruptible: true }, async (ctx) => {
        const { manager } = ctx;
        const p = c();
        const last = new Map<number, InstanceStatus>();
        const names = new Map<number, string>();
        const remember = (st: InstanceState) => {
          last.set(st.record.index, st.status);
          names.set(st.record.index, st.record.name);
        };

        const initial = await manager.list();
        initial.forEach(remember);
        const settings = manager.getSettings();
        if (ctx.json) {
          printJsonLine({ type: 'snapshot', at: new Date().toISOString(), instances: initial.map(publicState) });
        } else {
          printStateTable(initial, settings.maxRunning);
          const auto = initial.filter((s) => s.record.autoRestart).map((s) => `#${s.record.index}`);
          out(
            p.gray(
              `[${clockTime()}] 健康监控已启动（每 ${settings.healthIntervalSec} 秒检查；自动重启: ${auto.length ? auto.join(' ') : '无'}；Ctrl-C 退出）`,
            ),
          );
        }

        const onState = (st: InstanceState) => {
          const index = st.record.index;
          const prev = last.get(index);
          remember(st);
          if (prev === st.status) return;
          if (ctx.json) {
            printJsonLine({ type: 'instance-state', at: new Date().toISOString(), previous: prev ?? null, state: publicState(st) });
            return;
          }
          const from = prev ? `${colorStatus(prev, statusLabel(prev), p)} → ` : '';
          const detail =
            st.status === 'error' && st.error ? p.red(`  ${errorSummary(st.error)}`) + p.gray(`（详见 avdm logs ${index}）`) : '';
          out(`${p.gray(`[${clockTime()}]`)} #${index} ${st.record.name}  ${from}${colorStatus(st.status, statusLabel(st.status), p)}${detail}`);
        };
        const onLog = (entry: { level: 'info' | 'warn' | 'error'; message: string; index?: number; at: string }) => {
          if (ctx.json) {
            printJsonLine({ type: 'log', ...entry });
            return;
          }
          const tag = entry.level === 'error' ? p.red('错误') : entry.level === 'warn' ? p.yellow('警告') : p.cyan('信息');
          const who = entry.index !== undefined ? ` #${entry.index}${names.has(entry.index) ? ` ${names.get(entry.index)}` : ''}` : '';
          const at = new Date(entry.at);
          out(`${p.gray(`[${clockTime(Number.isNaN(at.getTime()) ? new Date() : at)}]`)} ${tag}${who} ${cleanLogMessage(entry.message)}`);
        };
        const onChanged = () => {
          if (ctx.json) {
            printJsonLine({ type: 'instances-changed', at: new Date().toISOString() });
            return;
          }
          out(p.gray(`[${clockTime()}] 实例列表已变化`));
        };

        manager.on('instance-state', onState);
        manager.on('log', onLog);
        manager.on('instances-changed', onChanged);
        manager.startMonitor();
        try {
          await waitForAbort(ctx.signal);
        } finally {
          manager.stopMonitor();
          manager.off('instance-state', onState);
          manager.off('log', onLog);
          manager.off('instances-changed', onChanged);
        }
        if (!ctx.json) out(p.gray(`\n[${clockTime()}] 监控已停止（模拟器保持运行）`));
      });
    });
}
