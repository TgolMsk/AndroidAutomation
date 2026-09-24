import { runDoctorChecks, type DoctorCheck, type DoctorLevel } from '@avdm/core';
import type { AvdManager } from '@avdm/core';
import type { Command } from 'commander';
import { c, failMark, okMark, warnMark } from '../ui/colors.js';
import { StatusLine } from '../ui/progress.js';
import { displayWidth, padEnd } from '../ui/table.js';
import { debugLog, markFailed, out, printJson, withManager } from '../runtime.js';
import { findExecutable } from '../util/files.js';

/**
 * `avdm doctor`: environment health check. The checks themselves live in @avdm/core (`runDoctorChecks`) so the
 * Electron apps run the same ones; this command only renders them.
 */

export type CheckLevel = DoctorLevel;

export type CheckResult = DoctorCheck;

async function runChecks(manager: AvdManager, progress: (label: string) => void): Promise<CheckResult[]> {
  return runDoctorChecks(manager, {
    audience: 'cli',
    onProgress: progress,
    onError: (id, err) => debugLog(`doctor ${id}`, err),
    findExecutable,
  });
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('环境体检：SDK / emulator 版本 / adb / HVF / 镜像 / 主机资源 / scrcpy')
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const status = new StatusLine(process.stderr, Boolean(process.stderr.isTTY) && !ctx.json);
        let checks: CheckResult[];
        try {
          checks = await runChecks(ctx.manager, (label) => status.update(c().gray(`正在检查 ${label}…`)));
        } finally {
          status.done();
        }
        const failed = checks.filter((r) => r.level === 'fail').length;
        const warned = checks.filter((r) => r.level === 'warn').length;
        if (failed) markFailed();
        if (ctx.json) {
          printJson({ ok: failed === 0, checks });
          return;
        }
        const p = c();
        const titleWidth = Math.max(...checks.map((r) => displayWidth(r.title)));
        for (const r of checks) {
          const mark = r.level === 'ok' ? okMark(p) : r.level === 'warn' ? warnMark(p) : failMark(p);
          out(`${mark} ${p.bold(padEnd(r.title, titleWidth))}  ${r.detail}`);
          if (r.hint && r.level !== 'ok') out(p.gray(`    → ${r.hint}`));
        }
        out('');
        const passed = checks.length - failed - warned;
        const summary = `体检完成：${passed} 项通过，${warned} 项警告，${failed} 项失败`;
        out(failed ? p.red(summary) : warned ? p.yellow(summary) : p.green(summary));
      });
    });
}
