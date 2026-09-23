import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawFrame } from '@avdm/automation';
import { normalizeGatherConfig, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationGameSummary, AutomationProbeReport, AutomationRun, AutomationSchedule, AutomationSettings } from '../../shared/ipc';
import { broadcast } from '../events';
import type { ManagerHost } from '../manager-host';
import { asIndex, errorMessage } from '../util';
import { WanlongGatherRunner, type GatherManager } from './gather-runner';
import { inspectGatherProbe } from './gather-probe-guard';
import { gamePlugin, gameSummaries, gameTask } from './games';
import type { ProbeWorkerInput, ProbeWorkerOutput } from './probe-worker';
import { AutomationScheduler, type ScheduledRunContext } from './scheduler';
import { AutomationSettingsStore } from './store';

const PROBE_TIMEOUT_MS = 120_000;
const MAX_RUN_HISTORY = 100;
const RUN_HISTORY_VERSION = 1;
const MAX_RUN_HISTORY_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRun(value: unknown): value is AutomationRun {
  if (!isRecord(value)) return false;
  const status = value['status'];
  return typeof value['runId'] === 'string' && typeof value['gameId'] === 'string' &&
    typeof value['taskId'] === 'string' && typeof value['index'] === 'number' &&
    Number.isInteger(value['index']) && value['index'] >= 0 && value['index'] <= 63 &&
    typeof status === 'string' && ['running', 'stopping', 'succeeded', 'failed', 'cancelled'].includes(status) &&
    typeof value['startedAt'] === 'number' && Number.isFinite(value['startedAt']) &&
    (value['endedAt'] === null || (typeof value['endedAt'] === 'number' && Number.isFinite(value['endedAt']))) &&
    typeof value['message'] === 'string' &&
    (value['nextWakeAt'] === undefined || value['nextWakeAt'] === null ||
      (typeof value['nextWakeAt'] === 'number' && Number.isFinite(value['nextWakeAt'])));
}

type GatherRunnerPort = Pick<WanlongGatherRunner, 'runOnce' | 'stop' | 'dispose' | 'isRunning'>;

/** A future durable scheduler may consume a completed cycle and return only a wake it actually stored. */
export type CycleCompletionSink = (run: AutomationRun, result: GatherCycleResult) => Promise<number | null>;

interface ActiveAutomationRun {
  index: number;
  controller: AbortController;
  source: 'manual' | 'scheduled';
  result: Promise<GatherCycleResult>;
  done: Promise<void>;
}

/** Host-owned bridge from AVD instances to isolated game-vision workers. */
export class AutomationHost {
  private readonly store: AutomationSettingsStore;
  private readonly gatherRunner: GatherRunnerPort;
  private readonly scheduler: AutomationScheduler;
  private readonly workers = new Set<Worker>();
  private readonly runHistory = new Map<string, AutomationRun>();
  private readonly activeRuns = new Map<string, ActiveAutomationRun>();
  private readonly activeByIndex = new Map<number, string>();
  private readonly controlQueues = new Map<number, Promise<void>>();
  private readonly historyFile: string;
  private readonly historyReady: Promise<void>;
  private historyWrite: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly host: ManagerHost, home: string, gatherRunner?: GatherRunnerPort, private readonly cycleSink?: CycleCompletionSink) {
    this.store = new AutomationSettingsStore(home);
    this.historyFile = join(home, 'automation', 'runs.json');
    this.historyReady = this.loadHistory();
    // Initialization is eager, but callers receive the error through the relevant IPC method.
    void this.historyReady.catch(() => undefined);
    const manager: GatherManager = {
      getState: async (index) => (await this.host.get()).getState(index),
      device: async (index) => (await this.host.get()).device(index),
    };
    this.gatherRunner = gatherRunner ?? new WanlongGatherRunner(manager, home);
    this.scheduler = new AutomationScheduler(home, (context) => this.runScheduledCycle(context), {
      onStateChange: (state) => broadcast('automation-schedule', state),
      onError: ({ gameId, index }, error) => broadcast('log', {
        level: 'warn', message: `自动化调度 ${gameId} #${index}：${errorMessage(error)}`, at: new Date().toISOString(),
      }),
    });
  }

  games(): AutomationGameSummary[] {
    return gameSummaries();
  }

  settings(gameId: string, index: number): Promise<AutomationSettings> {
    gamePlugin(gameId);
    return this.store.get(gameId, asIndex(index));
  }

  async saveSettings(gameId: string, index: number, patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    gamePlugin(gameId);
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      if (patch && 'config' in patch && gameId === 'wanlong') {
        const config = patch.config;
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('自动化参数无效');
        if ('version' in config && config.version !== 2) throw new Error('万龙觉醒配置版本不兼容');
        // The game package owns its schema and defaults; preserve its full normalized document.
        patch = { ...patch, config: normalizeGatherConfig(config as Parameters<typeof normalizeGatherConfig>[0]) as unknown as Record<string, unknown> };
      }
      // A changed template or policy needs a fresh scene probe before the next automatic write.
      if ((patch.templateDir !== undefined || patch.config !== undefined) && (await this.scheduler.get(gameId, i)).enabled) {
        await this.scheduler.disable(gameId, i);
      }
      return this.store.save(gameId, i, patch);
    });
  }

  async restoreSchedules(): Promise<void> {
    await this.scheduler.restore();
  }

  async schedules(): Promise<AutomationSchedule[]> {
    return this.scheduler.list();
  }

  async setSchedule(gameId: string, index: number, enabled: boolean): Promise<AutomationSchedule> {
    if (this.disposed) throw new Error('应用正在退出');
    const plugin = gamePlugin(gameId);
    if (gameId !== 'wanlong') throw new Error('该游戏尚未接入自动续跑');
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      if (!enabled) return this.scheduler.disable(gameId, i);
      if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);
      const manager = await this.host.get();
      const [instance, settings] = await Promise.all([manager.getState(i), this.store.get(gameId, i)]);
      if (instance.status !== 'running') throw new Error(`实例 #${i} 尚未就绪`);
      if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
      const config = normalizeGatherConfig(settings.config as Parameters<typeof normalizeGatherConfig>[0]);
      if (!config.enabled) throw new Error('请先启用并保存自动采集配置');
      const foreground = await (await manager.device(i)).foregroundPackage();
      if (foreground !== plugin.packageName) throw new Error(`${plugin.name}未处于前台`);
      const probe = await this.probe(gameId, i);
      if (!probe.launchReady) throw new Error(`画面未通过采集校准：${probe.launchReason}`);
      if (this.disposed) throw new Error('应用正在退出');
      if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);
      return this.scheduler.enable(gameId, i);
    });
  }

  async probe(gameId: string, index: number): Promise<AutomationProbeReport> {
    const startedAt = performance.now();
    if (this.disposed) throw new Error('应用正在退出');
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    const manager = await this.host.get();
    const [state, settings] = await Promise.all([manager.getState(i), this.store.get(gameId, i)]);
    if (state.status !== 'running') throw new Error(`实例 #${i} 尚未就绪，请先启动并等待 Android 启动完成`);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const device = await manager.device(i);
    const adbStartedAt = performance.now();
    const foregroundBefore = await device.foregroundPackage();
    const frame = await device.screencapRaw();
    const foregroundPackage = await device.foregroundPackage();
    if (foregroundBefore !== foregroundPackage) throw new Error('截图时前台应用发生切换，请重新探测');
    const adbMs = performance.now() - adbStartedAt;
    if (this.disposed) throw new Error('应用正在退出');
    const workerStartedAt = performance.now();
    const report = await this.runProbeWorker({
      gameId: plugin.id,
      templateDir: settings.templateDir,
      foregroundPackage: foregroundPackage ?? null,
      frame,
    });
    const decision = gameId === 'wanlong' ? inspectGatherProbe(report) : { ok: false as const, reason: '游戏包尚无安全启动条件' };
    return {
      gameId: report.gameId,
      packageName: report.packageName,
      foregroundPackage: report.foregroundPackage,
      deviceWidth: report.frame.width,
      deviceHeight: report.frame.height,
      capturedAt: report.frame.capturedAt,
      matches: report.matches.map(({ templateId, found, score, threshold, x, y, w, h, reason }) =>
        ({ templateId, found, score, threshold, x, y, w, h, ...(reason ? { reason } : {}) })),
      launchReady: decision.ok,
      launchReason: decision.ok ? `已确认${decision.scene}画面，匹配分数 ${decision.score.toFixed(3)}` : decision.reason,
      timingsMs: {
        adb: Math.round(adbMs),
        prepare: report.timingMs.prepare,
        match: report.timingMs.match,
        worker: Math.round(performance.now() - workerStartedAt),
        total: Math.round(performance.now() - startedAt),
      },
    };
  }

  /** Start one cycle and return its run record immediately; the result arrives over automation-run. */
  async run(gameId: string, taskId: string, index: number): Promise<AutomationRun> {
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      if ((await this.scheduler.get(gameId, i)).enabled) throw new Error(`实例 #${i} 已启用自动续跑，请先停止后再手动运行`);
      const { run } = await this.startRun(gameId, taskId, i, 'manual');
      return run;
    });
  }

  /** Serialize policy changes and manual start for one instance across IPC requests. */
  private async withControlLock<T>(index: number, action: () => Promise<T>): Promise<T> {
    const previous = this.controlQueues.get(index) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.controlQueues.set(index, current);
    await previous;
    try { return await action(); }
    finally {
      if (this.controlQueues.get(index) === current) this.controlQueues.delete(index);
      release();
    }
  }

  private async runScheduledCycle({ gameId, index, signal }: ScheduledRunContext): Promise<{ nextWakeAt: number | null }> {
    const { run, active } = await this.startRun(gameId, 'gather-once', index, 'scheduled', signal);
    try {
      const result = await active.result;
      await active.done;
      if (result.outcome === 'error' || result.outcome === 'cancelled') throw new Error(result.message);
      // A wake must not be armed when the corresponding run record was not durably written.
      await this.historyWrite;
      const recorded = this.runHistory.get(run.runId);
      if (recorded?.status !== 'succeeded') throw new Error(recorded?.message ?? '采集运行记录未保存');
      return { nextWakeAt: result.nextWakeAt };
    } catch (error) {
      await active.done;
      throw error;
    }
  }

  private async startRun(
    gameId: string, taskId: string, index: number, source: 'manual' | 'scheduled', externalSignal?: AbortSignal,
  ): Promise<{ run: AutomationRun; active: ActiveAutomationRun }> {
    if (this.disposed) throw new Error('应用正在退出');
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error('调度已停止');
    await this.historyReady;
    const plugin = gamePlugin(gameId);
    const task = gameTask(gameId, taskId);
    if (gameId !== 'wanlong' || task.id !== 'gather-once') throw new Error('该自动化任务尚未接入');
    const i = asIndex(index);
    if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);

    const manager = await this.host.get();
    const [instance, settings] = await Promise.all([manager.getState(i), this.store.get(gameId, i)]);
    if (instance.status !== 'running') throw new Error(`实例 #${i} 尚未就绪，请先启动并等待 Android 启动完成`);
    if (!settings.templateDir) throw new Error('请先选择本地模板集目录');
    const config = normalizeGatherConfig(settings.config as Parameters<typeof normalizeGatherConfig>[0]);
    if (!config.enabled) throw new Error('请先启用并保存自动采集配置');
    const foreground = await (await manager.device(i)).foregroundPackage();
    if (foreground !== plugin.packageName) throw new Error(`${plugin.name}未处于前台（当前：${foreground ?? '未知'}）`);
    if (this.disposed) throw new Error('应用正在退出');
    if (externalSignal?.aborted) throw externalSignal.reason ?? new Error('调度已停止');
    // The check and reservation are synchronous after the last await, so two IPC calls cannot claim one device.
    if (this.activeByIndex.has(i) || this.gatherRunner.isRunning(i)) throw new Error(`实例 #${i} 已有自动化任务在运行`);

    const runId = randomUUID();
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal?.reason ?? new Error('调度已停止'));
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const run: AutomationRun = {
      runId, gameId, taskId, index: i, status: 'running', startedAt: Date.now(), endedAt: null,
      message: source === 'scheduled' ? '自动续跑：正在执行采集一轮' : '正在执行采集一轮', nextWakeAt: null,
    };
    this.activeByIndex.set(i, runId);
    try {
      await this.publishRun(run);
    } catch (error) {
      externalSignal?.removeEventListener('abort', onExternalAbort);
      this.activeByIndex.delete(i);
      this.runHistory.delete(runId);
      throw error;
    }
    const result = Promise.resolve().then(() => this.gatherRunner.runOnce(i, { templateDir: settings.templateDir, config, signal: controller.signal }));
    const done = result
      .then((result) => this.completeCycle(runId, result))
      .catch(async (error: unknown) => {
        const cancelled = controller.signal.aborted;
        try {
          await this.finishRun(runId, cancelled ? 'cancelled' : 'failed', errorMessage(error));
        } catch (persistError) {
          console.error('[avdm] 自动化运行记录无法保存', persistError);
        }
      })
      .finally(() => {
        externalSignal?.removeEventListener('abort', onExternalAbort);
        this.activeRuns.delete(runId);
        if (this.activeByIndex.get(i) === runId) this.activeByIndex.delete(i);
      });
    const active: ActiveAutomationRun = { index: i, controller, source, result, done };
    this.activeRuns.set(runId, active);
    return { run: { ...run }, active };
  }

  async stop(runId: string): Promise<void> {
    await this.historyReady;
    const run = this.runHistory.get(runId);
    if (!run) throw new Error('找不到自动化任务');
    if (run.endedAt !== null) return;
    const active = this.activeRuns.get(runId);
    if (!active) return;
    if (active.source === 'scheduled') {
      await this.scheduler.disable(run.gameId, active.index);
      return;
    }
    active.controller.abort(new Error('采集已取消'));
    if (run.status !== 'stopping') {
      try { await this.publishRun({ ...run, status: 'stopping', message: '正在停止采集' }); }
      catch (error) { console.error('[avdm] 自动化停止状态无法保存', error); }
    }
    await this.gatherRunner.stop(active.index);
    await active.done;
  }

  async runs(): Promise<AutomationRun[]> {
    await this.historyReady;
    return [...this.runHistory.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => ({ ...run }));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.scheduler.dispose();
    for (const run of this.activeRuns.values()) run.controller.abort(new Error('采集已取消'));
    await this.gatherRunner.dispose();
    await Promise.allSettled([...this.activeRuns.values()].map((run) => run.done));
    await Promise.allSettled([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
    await this.historyReady.catch(() => undefined);
    await this.historyWrite.catch(() => undefined);
  }

  private async completeCycle(runId: string, result: GatherCycleResult): Promise<void> {
    const status: AutomationRun['status'] = result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'error' ? 'failed' : 'succeeded';
    const run = this.runHistory.get(runId);
    // The Runner has already persisted its state. A future scheduler must durably store a wake
    // before returning it here; without that service, the engine's nextWakeAt is only advice.
    const scheduledWakeAt = run && this.cycleSink ? await this.cycleSink({ ...run }, result) : null;
    if (scheduledWakeAt !== null && (!Number.isFinite(scheduledWakeAt) || scheduledWakeAt < 0)) {
      throw new Error('自动化唤醒时间无效');
    }
    await this.finishRun(runId, status, result.message, scheduledWakeAt);
  }

  private async finishRun(runId: string, status: AutomationRun['status'], message: string, nextWakeAt: number | null = null): Promise<void> {
    const run = this.runHistory.get(runId);
    if (!run) return;
    await this.publishRun({ ...run, status, endedAt: Date.now(), message, nextWakeAt });
  }

  private async publishRun(run: AutomationRun): Promise<void> {
    this.runHistory.set(run.runId, run);
    this.trimHistory();
    await this.persistHistory();
    broadcast('automation-run', { ...run });
  }

  private trimHistory(): void {
    while (this.runHistory.size > MAX_RUN_HISTORY) {
      const old = [...this.runHistory].find(([, run]) => run.endedAt !== null);
      if (!old) break;
      this.runHistory.delete(old[0]);
    }
  }

  private async loadHistory(): Promise<void> {
    let value: unknown;
    try {
      const size = (await stat(this.historyFile)).size;
      if (size > MAX_RUN_HISTORY_BYTES) throw new Error('自动化运行记录超过 256 KB');
      value = JSON.parse(await readFile(this.historyFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`自动化运行记录无法读取：${this.historyFile}`, { cause: error });
    }
    if (!isRecord(value) || value['version'] !== RUN_HISTORY_VERSION || !Array.isArray(value['runs']) ||
      value['runs'].length > MAX_RUN_HISTORY || !value['runs'].every(isRun)) {
      throw new Error(`自动化运行记录格式不兼容：${this.historyFile}`);
    }
    let recovered = false;
    for (const stored of value['runs'] as AutomationRun[]) {
      const interrupted = stored.endedAt === null || stored.status === 'running' || stored.status === 'stopping';
      const run = interrupted ? {
        ...stored, status: 'failed' as const, endedAt: Date.now(), nextWakeAt: null,
        message: '上次运行因应用退出或中断而结束',
      } : stored;
      this.runHistory.set(run.runId, run);
      recovered ||= interrupted;
    }
    if (recovered) await this.persistHistory();
  }

  private persistHistory(): Promise<void> {
    const json = JSON.stringify({ version: RUN_HISTORY_VERSION, runs: [...this.runHistory.values()] }, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_RUN_HISTORY_BYTES) return Promise.reject(new Error('自动化运行记录超过 256 KB'));
    const previous = this.historyWrite;
    const next = previous.catch(() => undefined).then(() => this.writePrivateHistory(json));
    this.historyWrite = next;
    return next;
  }

  private async writePrivateHistory(json: string): Promise<void> {
    await mkdir(dirname(this.historyFile), { recursive: true, mode: 0o700 });
    const temp = `${this.historyFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(json); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.historyFile);
      await chmod(this.historyFile, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runProbeWorker(input: ProbeWorkerInput): Promise<import('@avdm/automation').ProbeReport> {
    // electron-vite emits this sibling entry for both dev and packaged builds.
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'probe-worker.js');
    const worker = new Worker(entry);
    this.workers.add(worker);
    // A screencap may be a view into a larger Buffer. Copy exactly the pixels once,
    // then transfer ownership so the main process need not clone a multi-MB frame again.
    const pixels = Uint8Array.from(input.frame.data);
    const transferred: RawFrame = { ...input.frame, data: pixels };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, report?: import('@avdm/automation').ProbeReport) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (error) reject(error);
        else if (report) resolve(report);
        else reject(new Error('图像识别未返回结果'));
      };
      const timer = setTimeout(() => finish(new Error('图像识别超时')), PROBE_TIMEOUT_MS);
      worker.once('message', (result: ProbeWorkerOutput) => {
        if (result.ok) finish(undefined, result.report);
        else finish(new Error(result.error));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`图像识别工作线程已退出 (${code})`)));
      worker.postMessage({ ...input, frame: transferred } satisfies ProbeWorkerInput, [pixels.buffer]);
    });
  }
}
