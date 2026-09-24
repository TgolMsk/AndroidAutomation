import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { withFileLock } from '@avdm/core';
import { AppError, canonicalDirectory, TemplateLibrary, type RawFrame, type Rect, type TemplateDraft, type TemplateSaveResult, type TemplateSet } from '@avdm/automation';
import { normalizeGatherConfig, type GatherCycleResult } from '@avdm/automation/wanlong';
import type { AutomationGameSummary, AutomationProbeReport, AutomationRun, AutomationSchedule, AutomationSettings, TemplateAlphaPreview, TemplateCapture, TemplateCoverage, TemplateImportResult, TemplatesChange, TemplateTestOptions, TemplateTestResult } from '../../shared/ipc';
import { broadcast } from '../events';
import type { ManagerHost } from '../manager-host';
import { asIndex, errorMessage } from '../util';
import { WanlongGatherRunner, type GatherManager } from './gather-runner';
import { inspectGatherProbe } from './gather-probe-guard';
import { gamePlugin, gameSummaries, gameTask } from './games';
import type { ProbeWorkerInput, ProbeWorkerOutput } from './probe-worker';
import { transferableJob, type TemplateJob, type TemplateJobOutput } from './template-jobs';
import { buildTemplateCoverage, rawFrameToPng, TemplateChangeFeed, workerError, type TemplatesChangeListener } from './template-tools';
import { AutomationScheduler, SchedulePauseError, type ScheduledRunContext } from './scheduler';
import { AutomationSettingsStore } from './store';

const PROBE_TIMEOUT_MS = 120_000;
const TEMPLATE_JOB_TIMEOUT_MESSAGES: Record<TemplateJob['kind'], string> = {
  test: '模板测试超时', compile: '模板编译检查超时', alphaPreview: '去底预览超时', diffAlpha: '透明底计算超时',
};
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

export interface AutomationHostHooks {
  onCycle?: (run: AutomationRun, result: GatherCycleResult, source: 'manual' | 'scheduled') => Promise<void>;
  onFailure?: (run: AutomationRun, error: unknown, source: 'manual' | 'scheduled') => Promise<void>;
  onScheduleStop?: (gameId: string, index: number, failureCount: number) => Promise<void>;
}

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
  private readonly home: string;
  private readonly templates: TemplateLibrary;
  private readonly gatherRunner: GatherRunnerPort;
  private readonly scheduler: AutomationScheduler;
  private readonly workers = new Set<Worker>();
  private readonly runHistory = new Map<string, AutomationRun>();
  private readonly activeRuns = new Map<string, ActiveAutomationRun>();
  private readonly activeByIndex = new Map<number, string>();
  private readonly controlQueues = new Map<number, Promise<void>>();
  private readonly templateChanges = new TemplateChangeFeed();
  /** Replaces the one-shot template worker (tests run `runTemplateJob` in-process); unset in the app. */
  templateJobRunner?: (job: TemplateJob) => Promise<TemplateJobOutput>;
  private readonly historyFile: string;
  private readonly historyReady: Promise<void>;
  private historyWrite: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly host: ManagerHost, home: string, gatherRunner?: GatherRunnerPort, private readonly cycleSink?: CycleCompletionSink,
    private readonly hooks: AutomationHostHooks = {}) {
    this.home = home;
    this.store = new AutomationSettingsStore(home);
    this.templates = new TemplateLibrary(home);
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
      onStateChange: (state) => {
        broadcast('automation-schedule', state);
        if (!state.enabled && state.failureCount > 0) {
          void this.hooks.onScheduleStop?.(state.gameId, state.index, state.failureCount).catch((error: unknown) =>
            console.error('[avdm] 调度暂停告警无法保存', error));
        }
      },
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

  templateSets(gameId: string): Promise<TemplateSet[]> {
    gamePlugin(gameId);
    return this.templates.managedSets(gameId);
  }

  async createTemplateSet(gameId: string, index: number, name: string): Promise<TemplateSet> {
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    return this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      return this.withDeviceLease(i, async () => {
      const size = plugin.referenceSize ?? { width: 2560, height: 1440 };
      const set = await this.templates.createSet(gameId, name, plugin.packageName, size.width, size.height);
      await this.store.save(gameId, i, { templateDir: set.directory });
      return set;
      });
    });
  }

  async templateSet(gameId: string, index: number): Promise<TemplateSet | null> {
    const plugin = gamePlugin(gameId);
    const { templateDir } = await this.store.get(gameId, asIndex(index));
    if (!templateDir) return null;
    const set = await this.templates.load(templateDir);
    if (set.packageName && set.packageName !== plugin.packageName) throw new Error('模板集与当前游戏包名不一致');
    return set;
  }

  async templateImage(gameId: string, index: number, id: string): Promise<Uint8Array> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    return this.templates.image(set.directory, id);
  }

  /** Shared read-only capture for template authoring and the opt-in advisor. */
  async captureReadOnly(gameId: string, index: number): Promise<{ frame: RawFrame; foregroundPackage: string | null }> {
    const plugin = gamePlugin(gameId);
    const i = asIndex(index);
    if (this.disposed) throw new Error('应用正在退出');
    const manager = await this.host.get();
    const state = await manager.getState(i);
    if (state.status !== 'running') throw new Error(`实例 #${i} 尚未就绪`);
    const device = await manager.device(i);
    const before = await device.foregroundPackage();
    if (before !== plugin.packageName) throw new Error(`${plugin.name}未处于前台`);
    let frame: RawFrame;
    try { frame = await device.screencapRaw(); }
    catch (error) { throw new Error(`ADB 截图失败: ${errorMessage(error)}`, { cause: error }); }
    const after = await device.foregroundPackage();
    if (before !== after) throw new Error('截图期间前台应用发生切换，请重试');
    return { frame, foregroundPackage: after ?? null };
  }

  async captureTemplate(gameId: string, index: number): Promise<TemplateCapture> {
    const { frame, foregroundPackage } = await this.captureReadOnly(gameId, index);
    const png = await rawFrameToPng(frame);
    return { png, width: frame.width, height: frame.height, capturedAt: frame.capturedAt, foregroundPackage };
  }

  /**
   * `frames`: the main frame plus 1–3 diff frames of the same size. Pure computation in a worker (PNG decodes and
   * per-pixel loops), never touches the device.
   */
  async previewTemplateAlpha(gameId: string, index: number, frames: Uint8Array[], crop: Rect, tolerance: number, previewWidth?: number): Promise<TemplateAlphaPreview> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    const output = await this.runTemplateJob({ kind: 'alphaPreview', frames, crop, tolerance, previewWidth });
    if (output.kind !== 'alphaPreview') throw new Error('去底预览未返回结果');
    return output.preview;
  }

  async saveTemplate(gameId: string, index: number, draft: TemplateDraft): Promise<TemplateSaveResult> {
    const i = asIndex(index);
    // The diff mask is pure computation: done in a worker before any lock is taken.
    const { draft: ready, diffCoverage } = await this.resolveDiffAlpha(draft);
    const result = await this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      const set = await this.templateSet(gameId, i);
      if (!set) throw new Error('请先选择或创建模板集');
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      return this.withDeviceLease(i, () => this.templates.save(set.directory, ready));
    });
    this.emitTemplatesChanged(gameId, result.directory, 'save', [result.definition.id]);
    return diffCoverage === undefined ? result : { ...result, diffCoverage };
  }

  /**
   * A draft with `diffFrames` (and no caller alpha): compute the mask in the template worker with the preview's
   * algorithm and hand it to the library as `alpha`, so the main thread never decodes whole frames.
   */
  private async resolveDiffAlpha(draft: TemplateDraft): Promise<{ draft: TemplateDraft; diffCoverage?: number }> {
    const { diffFrames, diffTolerance, ...rest } = draft;
    if (!diffFrames?.length || (draft.alpha && draft.alpha.byteLength > 0)) return { draft: rest };
    if (!draft.crop) throw new AppError('INVALID_ARGUMENT', `模板「${draft.name}」要做差分去底必须给裁剪区域（差分帧是整帧，得知道裁哪一块）`);
    const output = await this.runTemplateJob({ kind: 'diffAlpha', frames: [draft.image, ...diffFrames], crop: draft.crop, tolerance: diffTolerance });
    if (output.kind !== 'diffAlpha') throw new Error('透明底计算未返回结果');
    return { draft: { ...rest, alpha: output.alphaPng }, diffCoverage: output.coverage };
  }

  async deleteTemplate(gameId: string, index: number, id: string): Promise<void> {
    const i = asIndex(index);
    const directory = await this.withControlLock(i, async () => {
      this.assertTemplateEditable(i);
      const set = await this.templateSet(gameId, i);
      if (!set) throw new Error('请先选择或创建模板集');
      if ((await this.scheduler.get(gameId, i)).enabled) await this.scheduler.disable(gameId, i);
      await this.withDeviceLease(i, () => this.templates.delete(set.directory, id));
      return set.directory;
    });
    this.emitTemplatesChanged(gameId, directory, 'delete', [id]);
  }

  /** 「立即验证」: one fresh read-only capture, matched and previewed on that same frame (in a worker). */
  async testTemplate(gameId: string, index: number, id: string, options: TemplateTestOptions = {}): Promise<TemplateTestResult> {
    const set = await this.templateSet(gameId, index);
    if (!set) throw new Error('请先选择或创建模板集');
    const definition = set.templates.find((item) => item.id === id);
    if (!definition) throw new AppError('TEMPLATE_NOT_FOUND', `模板集「${set.name}」里没有 id 为 ${id} 的模板`);
    const [{ frame, foregroundPackage }, image] = await Promise.all([
      this.captureReadOnly(gameId, index), this.templates.image(set.directory, id),
    ]);
    const output = await this.runTemplateJob({ kind: 'test', frame, set, definition, image, roi: options.roi, threshold: options.threshold });
    if (output.kind !== 'test') throw new Error('模板测试未返回结果');
    const png = await rawFrameToPng(frame);
    return { match: output.match, preview: { png, width: frame.width, height: frame.height, capturedAt: frame.capturedAt, foregroundPackage } };
  }

  /**
   * Missing critical / optional gather templates and glyph digits of the instance's set. `compile` also compiles
   * every template in a worker and reports the ones that fail (missing PNG, low variance after a hand edit, …).
   */
  async templateCoverage(gameId: string, index: number, compile: boolean): Promise<TemplateCoverage | null> {
    const set = await this.templateSet(gameId, index);
    if (!set) return null;
    if (!compile) return buildTemplateCoverage(gameId, set, [], false);
    const output = await this.runTemplateJob({ kind: 'compile', directory: set.directory });
    if (output.kind !== 'compile') throw new Error('模板编译检查未返回结果');
    return buildTemplateCoverage(gameId, set, output.failed, true);
  }

  /**
   * Only-add merge of legacy template sets (e.g. wanlong-panel's `.wl-data/templates` or `<dataDir>/templates`)
   * into this game's managed library. Sets of another game package are skipped; existing ids are never touched.
   *
   * A set that gains templates is a template change for every instance bound to it, so the import follows the same
   * rule as save / delete (a changed template needs a fresh probe before the next automatic write): a dry run finds
   * the sets that would change, then for each bound instance (in index order) no automation may be running, its
   * auto-resume is switched off, and its device lease is held while the sets are written. Sets copied whole are new
   * and bound to no instance. Change events and lock keys use the canonical (realpath) set folders.
   */
  async importTemplateSets(gameId: string, sourceDir: string): Promise<TemplateImportResult> {
    const plugin = gamePlugin(gameId);
    if (this.disposed) throw new Error('应用正在退出');
    const root = await this.templates.canonicalGameRoot(gameId);
    const setDirectories = (ids: string[]) => Promise.all(ids.map((setId) => canonicalDirectory(join(root, setId))));
    const plan = await this.templates.importSets(gameId, sourceDir, { packageName: plugin.packageName, dryRun: true });
    const bound = await this.instancesBoundTo(gameId, await setDirectories(Object.keys(plan.addedTemplates)));
    for (const i of bound) this.assertTemplateEditable(i);
    const paused: number[] = [];
    const result = await this.withTemplateWriters(gameId, bound, paused, () => this.templates.importSets(gameId, sourceDir, {
      packageName: plugin.packageName,
      log: (level, message) => { if (level === 'warn') console.warn('[wanlong] 模板导入：', message); },
    }));

    const addedIds = Object.keys(result.addedTemplates);
    const added = await setDirectories(addedIds);
    const copied = await setDirectories(Object.keys(result.copiedSets));
    // A set that changed between the dry run and the merge (another writer in between): switch those schedules off too.
    for (const i of (await this.instancesBoundTo(gameId, added)).filter((index) => !bound.includes(index))) {
      await this.withControlLock(i, async () => {
        if ((await this.scheduler.get(gameId, i)).enabled) { await this.scheduler.disable(gameId, i); paused.push(i); }
      });
    }
    added.forEach((directory, n) => this.emitTemplatesChanged(gameId, directory, 'import', result.addedTemplates[addedIds[n]!] ?? []));
    for (const directory of copied) this.emitTemplatesChanged(gameId, directory, 'import', []);
    return {
      result, sets: await this.templates.managedSets(gameId),
      changedDirectories: [...added, ...copied], pausedSchedules: [...new Set(paused)].sort((a, b) => a - b),
    };
  }

  /** Instances of this game whose template set is one of `directories` (canonical spellings, as the store keeps them). */
  private async instancesBoundTo(gameId: string, directories: readonly string[]): Promise<number[]> {
    if (directories.length === 0) return [];
    const wanted = new Set(directories);
    const bound: number[] = [];
    for (const index of await this.store.indexes(gameId)) {
      const settings = await this.store.get(gameId, index).catch(() => null);
      if (settings?.templateDir && wanted.has(settings.templateDir)) bound.push(index);
    }
    return bound;
  }

  /**
   * Runs `action` as a template write for every instance in `indexes` (ascending, like the account mutations): no
   * automation running, auto-resume off first (recorded in `paused`), the device lease held for the write.
   */
  private withTemplateWriters<T>(gameId: string, indexes: readonly number[], paused: number[], action: () => Promise<T>): Promise<T> {
    const [first, ...rest] = indexes;
    if (first === undefined) return action();
    return this.withControlLock(first, async () => {
      this.assertTemplateEditable(first);
      if ((await this.scheduler.get(gameId, first)).enabled) {
        await this.scheduler.disable(gameId, first);
        paused.push(first);
      }
      return this.withDeviceLease(first, () => this.withTemplateWriters(gameId, rest, paused, action));
    });
  }

  /**
   * Save into a known set without taking the device lease or touching schedules: for callers that already hold the
   * instance lease (the AI harvest inside a cycle). Same library rules (variance guard, explicit overwrite, atomic
   * writes, per-directory writer) and the same change notification.
   */
  async saveTemplateToSet(gameId: string, directory: string, draft: TemplateDraft): Promise<TemplateSaveResult> {
    gamePlugin(gameId);
    if (this.disposed) throw new Error('应用正在退出');
    const { draft: ready, diffCoverage } = await this.resolveDiffAlpha(draft);
    const result = await this.templates.save(directory, ready);
    this.emitTemplatesChanged(gameId, result.directory, 'save', [result.definition.id]);
    return diffCoverage === undefined ? result : { ...result, diffCoverage };
  }

  /** Subscribe to template-content changes (save / delete / import). Returns the unsubscribe function. */
  onTemplatesChanged(listener: TemplatesChangeListener): () => void {
    return this.templateChanges.on(listener);
  }

  private emitTemplatesChanged(gameId: string, directory: string, reason: TemplatesChange['reason'], templateIds: string[]): void {
    this.templateChanges.emit({ gameId, directory, reason, templateIds, at: Date.now() });
  }

  private assertTemplateEditable(index: number): void {
    if (this.disposed) throw new Error('应用正在退出');
    if (this.activeByIndex.has(index) || this.gatherRunner.isRunning(index)) {
      throw new Error(`实例 #${index} 正在运行自动化，请先停止`);
    }
  }

  private withDeviceLease<T>(index: number, action: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.home, 'run', `automation-instance-${index}.lock`), action, { timeoutMs: 200 });
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
      this.assertTemplateEditable(i);
      return this.withDeviceLease(i, () => this.store.save(gameId, i, patch));
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
      if (result.outcome === 'circuitBroken') throw new SchedulePauseError(result.message);
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
          const terminal = this.runHistory.get(runId);
          if (terminal && !cancelled) await this.hooks.onFailure?.({ ...terminal }, error, source);
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
    const status: AutomationRun['status'] = result.outcome === 'cancelled' ? 'cancelled' :
      result.outcome === 'error' || result.outcome === 'circuitBroken' ? 'failed' : 'succeeded';
    const run = this.runHistory.get(runId);
    // The Runner has already persisted its state. A future scheduler must durably store a wake
    // before returning it here; without that service, the engine's nextWakeAt is only advice.
    const scheduledWakeAt = run && this.cycleSink ? await this.cycleSink({ ...run }, result) : null;
    if (scheduledWakeAt !== null && (!Number.isFinite(scheduledWakeAt) || scheduledWakeAt < 0)) {
      throw new Error('自动化唤醒时间无效');
    }
    await this.finishRun(runId, status, result.message, scheduledWakeAt);
    const terminal = this.runHistory.get(runId);
    const source = this.activeRuns.get(runId)?.source;
    if (terminal && source) {
      try { await this.hooks.onCycle?.({ ...terminal }, result, source); }
      catch (error) { console.error('[avdm] 采集统计无法保存', error); }
    }
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

  /**
   * One template job in a fresh worker (match test, full compile check, 透明底 preview or a save's diff mask);
   * a failure keeps its error code. `templateJobRunner` replaces the worker in tests.
   */
  private runTemplateJob(job: TemplateJob): Promise<Extract<TemplateJobOutput, { ok: true }>> {
    if (this.disposed) return Promise.reject(new Error('应用正在退出'));
    if (this.templateJobRunner) {
      return this.templateJobRunner(job).then((output) => {
        if (output.ok) return output;
        throw workerError(output.error);
      });
    }
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'template-test-worker.js');
    const worker = new Worker(entry);
    this.workers.add(worker);
    const { message, transfer } = transferableJob(job);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, output?: Extract<TemplateJobOutput, { ok: true }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (error) reject(error);
        else if (output) resolve(output);
        else reject(new Error('模板任务未返回结果'));
      };
      const timer = setTimeout(() => finish(new Error(TEMPLATE_JOB_TIMEOUT_MESSAGES[job.kind])), PROBE_TIMEOUT_MS);
      worker.once('message', (output: TemplateJobOutput) => {
        if (output.ok) finish(undefined, output);
        else finish(workerError(output.error));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`模板工作线程已退出 (${code})`)));
      worker.postMessage(message, transfer);
    });
  }
}
