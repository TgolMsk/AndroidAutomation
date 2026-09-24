/**
 * Live check of the frozen-emulator recovery chain (port of wanlong-panel `npm run live:freeze`).
 * ★ It REALLY restarts the AVD: force stop → cold start → wait for Android → reconnect adb → wait for boot →
 *   monkey-launch the game → wait for a known screen. Never run by the tests.
 *
 *   packages/cli/node_modules/.bin/tsx apps/wanlong-assistant/scripts/freeze-live.ts <实例序号> [选项]
 *
 *   --template-dir  模板集目录（默认取助手里为该实例保存的模板集；没有就跳过「认主界面」，只等游戏到前台）。
 *   --home          助手数据目录（默认 $AVDM_HOME 或 ~/.avdm）。
 *
 * A 5-second countdown comes first (Ctrl+C cancels; Ctrl+C later aborts the flow at its next step). It holds the same
 * cross-process instance lease as the assistant, so it refuses to run while the assistant (scheduler, script run,
 * login) is using the instance. Recognition uses the built vision worker (`out/main/vision-worker.js`; run
 * `pnpm build:wanlong` first) like `live-sample.ts`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AvdManager, defaultHome } from '@avdm/core';
import { FREEZE_STAGE_TEXT, recoverFrozenInstance, wanlongPlugin } from '@avdm/automation/wanlong';
import { createAvdFreezeRecoveryIo } from '../src/main/alerts/freeze-io';
import { WanlongGatherRunner } from '../src/main/automation/gather-runner';
import { AutomationSettingsStore } from '../src/main/automation/store';
import { InstanceLocks } from '../src/main/scheduler/instance-lock';
import { VisionWorkerPool } from '../src/main/scheduler/vision-pool';

const here = path.dirname(fileURLToPath(import.meta.url));
const COUNTDOWN_S = 5;

interface Args {
  index: number;
  templateDir: string | null;
  home: string;
}

function usage(message?: string): never {
  if (message) console.error(`错误：${message}\n`);
  console.error('用法：tsx apps/wanlong-assistant/scripts/freeze-live.ts <实例序号> [--template-dir 目录] [--home 目录]');
  console.error('★ 会真的强制重启这个实例（冷启动）并重新拉起游戏。');
  process.exit(message ? 2 : 0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { index: -1, templateDir: null, home: defaultHome() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--template-dir') args.templateDir = path.resolve(argv[++i] ?? usage('--template-dir 需要一个目录'));
    else if (arg === '--home') args.home = path.resolve(argv[++i] ?? usage('--home 需要一个目录'));
    else if (/^\d{1,2}$/.test(arg) && args.index < 0) args.index = Number(arg);
    else usage(`无法识别的参数：${arg}`);
  }
  if (args.index < 0 || args.index > 63) usage('请给出 0~63 的实例序号');
  return args;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const templateDir = args.templateDir ?? (await new AutomationSettingsStore(args.home).get('wanlong', args.index)).templateDir ?? null;
  const entry = path.join(here, '..', 'out', 'main', 'vision-worker.js');
  if (templateDir && !existsSync(entry)) usage('找不到构建好的视觉工作线程，请先在仓库根目录运行 pnpm build:wanlong（或不带模板集运行，只等游戏到前台）');

  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    console.log('\n收到 Ctrl+C，正在中止（再按一次强制退出）……');
    controller.abort(new Error('已按 Ctrl+C 中止'));
  });

  const manager = await AvdManager.open({ home: args.home });
  const runner = templateDir ? new WanlongGatherRunner(manager, args.home, { pool: new VisionWorkerPool({ entry }) }) : null;
  try {
    const state = await manager.getState(args.index);
    if (state.status !== 'running' && state.status !== 'booting') {
      throw new Error(`实例 #${args.index} 当前是「${state.status}」，卡死恢复只针对还在运行的实例。请先启动它。`);
    }
    console.log(`实例 #${args.index}（${state.record.name}）当前「${state.status}」，模板集：${templateDir ?? '无（跳过认主界面）'}`);
    console.log(`★ ${COUNTDOWN_S} 秒后强制重启该实例并重新拉起游戏，按 Ctrl+C 取消。`);
    for (let left = COUNTDOWN_S; left > 0; left--) {
      process.stdout.write(`  ${left}…`);
      await sleep(1_000, controller.signal);
    }
    process.stdout.write('\n');

    const locks = new InstanceLocks(args.home);
    const startedAt = Date.now();
    const result = await locks.run(args.index, '卡死恢复实测', () => recoverFrozenInstance(createAvdFreezeRecoveryIo({
      manager: async () => manager,
      index: args.index,
      signal: controller.signal,
      gamePackage: wanlongPlugin.packageName,
      recognize: async (raw, signal) => (runner && templateDir ? runner.recognize(args.index, templateDir, raw, signal) : false),
      log: (level, message) => console.log(`  [${level}] ${message}`),
    }), { gamePackage: wanlongPlugin.packageName }), { signal: controller.signal });

    console.log(`\n步骤：${result.steps.join(' → ') || '（无）'}`);
    console.log(`耗时：${Math.round((Date.now() - startedAt) / 1000)} 秒`);
    if (result.ok) {
      console.log(result.loaded ? '结果：成功，主界面已认出。' : '结果：成功，游戏已在前台但主界面还没认出（多半压着活动弹窗，调度器采样时会处理）。');
      return;
    }
    const stage = result.stage === 'done' ? '收尾' : FREEZE_STAGE_TEXT[result.stage];
    console.log(`结果：失败，卡在「${stage}」：${result.reason ?? '原因未知'}`);
    process.exitCode = 1;
  } finally {
    await runner?.dispose();
    await manager.dispose?.();
  }
}

main().catch((error: unknown) => {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
