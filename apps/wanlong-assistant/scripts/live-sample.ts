/**
 * Live troop-panel sampler (port of wanlong-panel `npm run live:sample`), for checking templates on a real AVD.
 *
 *   packages/cli/node_modules/.bin/tsx apps/wanlong-assistant/scripts/live-sample.ts <实例序号> [选项]
 *
 *   (默认)          只看不点：截一帧，报告前台包名与是否认得出界面。不发任何输入。
 *   --sample        打开「部队管理」面板读一次再关掉（会点击界面，但绝不派兵）。
 *   --cold-start    允许游戏不在前台时用 monkey 拉起（只允许万龙觉醒的包名）。
 *   --template-dir  模板集目录（默认取助手里为该实例保存的模板集）。
 *   --home          助手数据目录（默认 $AVDM_HOME 或 ~/.avdm）。
 *
 * It uses the same code path as the app: the long-lived vision worker, the probe gate before any formal input and the
 * cross-process instance lease (so it refuses to run while the assistant is using the instance). The worker is the
 * built bundle (`out/main/vision-worker.js`; run `pnpm build:wanlong` first): tsx's loader does not reach worker threads.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AvdManager, defaultHome } from '@avdm/core';
import {
  applySample, defaultSchedulerConfig, deriveMarchView, emptyInstanceState, formatDuration, MARCH_STATUS_TEXT,
} from '@avdm/automation/wanlong/pure';
import { WanlongGatherRunner } from '../src/main/automation/gather-runner';
import { AutomationSettingsStore } from '../src/main/automation/store';
import { VisionWorkerPool } from '../src/main/scheduler/vision-pool';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Args {
  index: number;
  sample: boolean;
  coldStart: boolean;
  templateDir: string | null;
  home: string;
}

function usage(message?: string): never {
  if (message) console.error(`错误：${message}\n`);
  console.error('用法：tsx apps/wanlong-assistant/scripts/live-sample.ts <实例序号> [--sample] [--cold-start] [--template-dir 目录] [--home 目录]');
  process.exit(message ? 2 : 0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { index: -1, sample: false, coldStart: false, templateDir: null, home: defaultHome() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--sample') args.sample = true;
    else if (arg === '--cold-start') args.coldStart = true;
    else if (arg === '--template-dir') args.templateDir = path.resolve(argv[++i] ?? usage('--template-dir 需要一个目录'));
    else if (arg === '--home') args.home = path.resolve(argv[++i] ?? usage('--home 需要一个目录'));
    else if (/^\d{1,2}$/.test(arg) && args.index < 0) args.index = Number(arg);
    else usage(`无法识别的参数：${arg}`);
  }
  if (args.index < 0 || args.index > 63) usage('请给出 0~63 的实例序号');
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const templateDir = args.templateDir ?? (await new AutomationSettingsStore(args.home).get('wanlong', args.index)).templateDir;
  if (!templateDir) usage(`实例 #${args.index} 还没有选择模板集，请用 --template-dir 指定`);

  const entry = path.join(here, '..', 'out', 'main', 'vision-worker.js');
  if (!existsSync(entry)) usage('找不到构建好的视觉工作线程，请先在仓库根目录运行 pnpm build:wanlong');
  const manager = await AvdManager.open({ home: args.home });
  const pool = new VisionWorkerPool({ entry });
  const runner = new WanlongGatherRunner(manager, args.home, { pool });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('已按 Ctrl+C 中止')));
  try {
    const state = await manager.getState(args.index);
    if (state.status !== 'running') throw new Error(`实例 #${args.index} 未运行（${state.status}）`);
    const health = await runner.healthFrame(args.index, controller.signal);
    console.log(`实例 #${args.index}：截图 ${health.raw.width}x${health.raw.height}，前台 ${health.foreground ?? '未知'}，` +
      `游戏进程 ${health.running === null ? '未知' : health.running ? '在' : '不在'}`);
    const recognized = await runner.recognize(args.index, templateDir, health.raw, controller.signal);
    console.log(`界面：${recognized ? '认得出（世界地图 / 城内 / 已知面板之一）' : '认不出'}`);
    if (!args.sample) {
      console.log('只看不点模式结束。要真的打开部队管理面板读一次，请加 --sample。');
      return;
    }
    const config = defaultSchedulerConfig();
    const sample = await runner.sample(args.index, {
      templateDir, config, deadlineAt: Date.now() + config.sampleTimeoutMs, signal: controller.signal,
      allowColdStart: args.coldStart,
      log: (level, message) => { if (level !== 'debug') console.log(`  [${level}] ${message}`); },
    });
    console.log(`队列 ${sample.queueUsed ?? '?'}/${sample.queueTotal ?? '?'}`);
    for (const warning of sample.warnings) console.log(`  警告：${warning}`);
    const queue = applySample({ ...emptyInstanceState(args.index), auto: true }, sample, [], config);
    for (const march of queue.marches) {
      const view = deriveMarchView(march);
      console.log(`  第 ${march.slot} 队 ${MARCH_STATUS_TEXT[march.status]} 目标 ${march.targetCoord ?? '?'} ` +
        `资源 ${march.resourceType ?? '?'} 剩余 ${formatDuration(view.remainingMs)} 释放 ${formatDuration(march.freeAt === null ? null : march.freeAt - Date.now())}` +
        `${march.warning ? `（${march.warning}）` : ''}`);
    }
  } finally {
    await runner.dispose();
    await manager.dispose?.();
  }
}

main().catch((error: unknown) => {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
