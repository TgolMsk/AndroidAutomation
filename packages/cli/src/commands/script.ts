import { AvdmError } from '@avdm/core';
import type { ScriptManifest, ScriptRunInfo } from '@avdm/core';
import type { Command } from 'commander';
import { c, ce, failMark, okMark, warnMark } from '../ui/colors.js';
import { formatDuration } from '../ui/progress.js';
import { renderTable } from '../ui/table.js';
import type { Column } from '../ui/table.js';
import {
  instanceNames,
  markFailed,
  note,
  out,
  printJson,
  resolveSelector,
  waitForAbort,
  withManager,
} from '../runtime.js';
import type { CommandContext } from '../runtime.js';

/**
 * `avdm script list | run | example`.
 * Manager methods: listScripts, runScript (+ 'script-run' / 'script-output' / 'log' events), scripts.listRuns,
 * scripts.stop, scripts.createExample, paths.scriptsDir, indices, registry.list.
 */
export function registerScriptCommands(program: Command): void {
  const script = program.command('script').description('脚本插件：list | run | example');

  script
    .command('list')
    .description(`列出脚本（目录 ~/.avdm/scripts/<id>/script.json）`)
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const scripts = await ctx.manager.listScripts();
        if (ctx.json) {
          printJson(scripts);
          return;
        }
        const p = c();
        if (scripts.length === 0) {
          out(`暂无脚本（目录: ${ctx.manager.paths.scriptsDir}）。运行 \`avdm script example\` 生成示例`);
          return;
        }
        const cols: Array<Column<ScriptManifest>> = [
          { header: 'ID', get: (s) => s.id },
          { header: '名称', get: (s) => s.name, maxWidth: 24 },
          { header: '命令', get: (s) => s.command.join(' '), maxWidth: 32 },
          { header: '说明', get: (s) => s.description ?? '', maxWidth: 40 },
        ];
        out(renderTable(scripts, cols, { headerStyle: p.bold }));
        out(p.gray(`脚本目录: ${ctx.manager.paths.scriptsDir}`));
      });
    });

  script
    .command('run <id> <sel> [args...]')
    .description('在运行中的实例上执行脚本（-- 之后的参数传给脚本），输出按 [#编号] 前缀显示')
    .option('--json', '结束后输出各运行结果的 JSON')
    .action(async (id: string, sel: string, args: string[], opts: { json?: boolean }) => {
      await withManager({ json: opts.json, interruptible: true }, (ctx) => runScript(ctx, id, sel, args));
    });

  script
    .command('example')
    .description('生成示例脚本 hello-adb（Python，打印设备信息并点击屏幕中心）')
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const manifest = await ctx.manager.scripts.createExample();
        if (ctx.json) {
          printJson(manifest);
          return;
        }
        out(`${okMark()} 已生成示例脚本 ${c().bold(manifest.id)}: ${manifest.dir}`);
        out(c().gray(`运行: avdm script run ${manifest.id} <实例>，例如 avdm script run ${manifest.id} all`));
      });
    });
}

const FINAL = new Set(['exited', 'failed', 'stopped']);

async function runScript(ctx: CommandContext, id: string, sel: string, args: string[]): Promise<void> {
  const { manager } = ctx;
  const p = c();
  const indices = await resolveSelector(manager, sel);
  if (indices.length === 0) {
    if (ctx.json) printJson([]);
    else out(p.yellow('没有匹配的实例'));
    return;
  }
  const names = await instanceNames(manager).catch(() => new Map<number, string>());

  const runIndex = new Map<string, number>();
  const buffered = new Map<string, string[]>();
  const final = new Map<string, ScriptRunInfo>();
  let runIds: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const check = () => {
    if (runIds.length > 0 && runIds.every((r) => final.has(r))) resolveDone();
  };

  const printLine = (index: number, line: string) => {
    if (!ctx.json) out(`${p.cyan(`[#${index}]`)} ${line}`);
  };
  const onOutput = (runId: string, line: string) => {
    const index = runIndex.get(runId);
    if (index === undefined) {
      // Output can arrive before runScript() resolves; hold it until we know the run's instance.
      const list = buffered.get(runId) ?? [];
      list.push(line);
      buffered.set(runId, list);
      return;
    }
    printLine(index, line);
  };
  const onRun = (run: ScriptRunInfo) => {
    if (FINAL.has(run.status)) {
      final.set(run.runId, run);
      check();
    }
  };
  const onLog = (entry: { level: 'info' | 'warn' | 'error'; message: string; index?: number }) => {
    if (ctx.json || entry.level === 'info') return;
    const mark = entry.level === 'error' ? failMark(ce()) : warnMark(ce());
    process.stderr.write(`${mark} ${entry.index !== undefined ? `#${entry.index} ` : ''}${entry.message}\n`);
  };

  manager.on('script-output', onOutput);
  manager.on('script-run', onRun);
  manager.on('log', onLog);
  const poll = setInterval(() => {
    // Safety net in case a final 'script-run' event was missed.
    try {
      for (const run of manager.scripts.listRuns()) if (runIndex.has(run.runId)) onRun(run);
    } catch {
      // ignore
    }
  }, 1000);
  const startedAt = Date.now();

  try {
    const runs = await manager.runScript(id, indices, args);
    if (runs.length === 0) {
      throw new AvdmError('INSTANCE_NOT_RUNNING', '所选实例均未运行，脚本未执行');
    }
    runIds = runs.map((r) => r.runId);
    for (const run of runs) {
      runIndex.set(run.runId, run.index);
      for (const line of buffered.get(run.runId) ?? []) printLine(run.index, line);
      buffered.delete(run.runId);
      onRun(run);
    }
    note(ctx, `脚本 ${id} 已在 ${runs.length} 个实例上运行（Ctrl-C 停止）`);
    check();

    await Promise.race([done, waitForAbort(ctx.signal)]);
    if (ctx.signal.aborted && !runIds.every((r) => final.has(r))) {
      process.stderr.write(ce().yellow('\n正在停止脚本…') + '\n');
      await Promise.all(runIds.filter((r) => !final.has(r)).map((r) => manager.scripts.stop(r).catch(() => {})));
      for (const run of manager.scripts.listRuns()) if (runIndex.has(run.runId)) onRun(run);
    }
  } finally {
    clearInterval(poll);
    manager.off('script-output', onOutput);
    manager.off('script-run', onRun);
    manager.off('log', onLog);
  }

  const results = runIds.map((r) => final.get(r) ?? manager.scripts.listRuns().find((x) => x.runId === r)).filter(
    (r): r is ScriptRunInfo => Boolean(r),
  );
  results.sort((a, b) => a.index - b.index);
  const okRun = (r: ScriptRunInfo) => r.status === 'exited' && (r.exitCode === 0 || r.exitCode === undefined);
  const failed = results.filter((r) => !okRun(r)).length;
  if (ctx.signal.aborted) process.exitCode = 130;
  else if (failed) markFailed();

  if (ctx.json) {
    printJson(results);
    return;
  }
  out('');
  for (const r of results) {
    const name = names.get(r.index) ?? '';
    if (okRun(r)) {
      out(`${okMark(p)} #${r.index} ${name} ${p.gray(`退出码 0`)}`);
    } else {
      const why =
        r.status === 'stopped' ? '已停止' : r.status === 'running' ? '仍在运行' : `退出码 ${r.exitCode ?? '未知'}`;
      out(`${failMark(p)} #${r.index} ${why} ${p.gray(`（日志: ${r.logFile}）`)}`);
    }
  }
  const summary = `完成：成功 ${results.length - failed} 个${failed ? `，失败 ${failed} 个` : ''}（用时 ${formatDuration(Date.now() - startedAt)}）`;
  out(failed ? p.yellow(summary) : p.gray(summary));
}
