import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { matchTemplate, prepareFrame, type DevicePort, type MatchResult, type ProbeReport, type RawFrame } from '@avdm/automation';
import {
  AppError, FAILURE_SHOT_LABELS, GameUpdateRecovery, POPUP_CLOSE_ROI, TPL, assertGatherTemplatesComplete, buildSchedulerTemplates,
  closePopupTemplates, createGatherIo, isRecognizableScreen, loadGatherTemplates, runGatherCycle, sampleTroopPanel,
  serializeError, wanlongPlugin, type GamePresence, type GatherTemplates, type SampleIo, type SchedulerTemplates,
  type UnknownScreenAdvisor,
} from '@avdm/automation/wanlong';
import { localFrameComparer } from '../automation/ai-recover/frame-diff';
import { GATHER_PROBE_TEMPLATE_IDS, inspectGatherProbe } from '../automation/gather-probe-guard';
import { CompiledSetCache } from './compiled-cache';
import type {
  MainToWorker, VisionJobResult, VisionJobSpec, VisionQuery, VisionQueryResult, VisionRequest, WorkerToMain,
} from './vision-protocol';

if (!parentPort) throw new Error('视觉工作线程缺少通信端口');
const port = parentPort;
const PACKAGE = wanlongPlugin.packageName;
/** Cold start: a monkey launch reaches the foreground in ~10 s; the city / world map appears 90 s+ later. */
const GAME_LOAD_WAIT_MS = 150_000;
const GAME_LOAD_POLL_MS = 2_500;
/** Advisor consults (AI / game update) offered before the probe gate; main enforces the same budget. */
const PRE_GATE_ADVISE = 2;

interface CompiledSet {
  dir: string;
  stamp: string;
  gather: GatherTemplates;
  scheduler: SchedulerTemplates | null;
  schedulerError: Error | null;
}

interface ActiveJob {
  jobId: number;
  controller: AbortController;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  approval?: { resolve: () => void; reject: (error: Error) => void };
  approved: boolean;
  lastFrame: RawFrame | null;
}

/**
 * Compiled sets by directory (a few side by side: the instance's own set and a script run's set, so an AI query during
 * a script never evicts the set the next sample needs); `invalidate` clears it.
 */
const compiled = new CompiledSetCache<CompiledSet>();
let active: ActiveJob | null = null;
let nextRequestId = 1;
/** Game-update detectors per template directory (ai module 'update' queries); each caches its own compiled crops. */
const updaters = new Map<string, GameUpdateRecovery>();

function post(message: WorkerToMain, transfer?: ArrayBuffer[]): void {
  port.postMessage(message, transfer);
}

function revive(error: { code?: string; message?: string } | undefined, fallback: string): AppError {
  return new AppError(error?.code ?? 'UNKNOWN', error?.message || fallback);
}

function aborted(job: ActiveJob): AppError {
  const reason = job.controller.signal.reason;
  const code = (reason as { code?: unknown } | null)?.code;
  return new AppError(typeof code === 'string' ? code : 'RUN_ABORTED', reason instanceof Error ? reason.message : '自动调度已停止。');
}

function checkAbort(job: ActiveJob): void {
  if (job.controller.signal.aborted) throw aborted(job);
}

function request<T>(job: ActiveJob, req: VisionRequest, transfer?: ArrayBuffer[]): Promise<T> {
  checkAbort(job);
  const id = nextRequestId++;
  return new Promise<T>((resolve, reject) => {
    job.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    post({ type: 'request', jobId: job.jobId, id, ...req } as WorkerToMain, transfer);
  });
}

function log(job: ActiveJob, level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  post({ type: 'log', jobId: job.jobId, level, message });
}

function sleep(job: ActiveJob, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.controller.signal.aborted) { reject(aborted(job)); return; }
    const timer = setTimeout(() => { job.controller.signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    function onAbort(): void { clearTimeout(timer); reject(aborted(job)); }
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function copyFrame(raw: RawFrame): { frame: RawFrame; transfer: ArrayBuffer[] } {
  const data = Uint8Array.from(raw.data);
  return { frame: { ...raw, data }, transfer: [data.buffer] };
}

type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** Compile logs go to the running job (a query outside any job has nobody to tell). */
function compileLog(): Logger {
  return (level, message) => { if (active) log(active, level, message); };
}

/**
 * Compile once per (template directory, manifest content). Every save or delete through the template library
 * rewrites manifest.json, so the stamp check also picks up edits made outside this app; main can still force a
 * recompile with `invalidate`. A job and queries asking at the same time share one compile.
 */
async function templates(templateDir: string, logTo: Logger = compileLog()): Promise<CompiledSet> {
  let dir: string;
  let manifest: Buffer;
  try {
    dir = await realpath(templateDir);
    manifest = await readFile(join(dir, 'manifest.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new AppError('TEMPLATE_NOT_FOUND', `模板集目录里找不到 manifest.json，请在「模板」页重新选择或创建模板集：${templateDir}`);
  }
  const stamp = createHash('sha1').update(manifest).digest('hex');
  return compiled.get(dir, stamp, () => compile(dir, stamp, logTo));
}

async function compile(dir: string, stamp: string, logTo: Logger): Promise<CompiledSet> {
  const started = Date.now();
  const gather = await loadGatherTemplates({
    templateDir: dir,
    requireCritical: false,
    onWarn: (message) => logTo('warn', `模板：${message}`),
  });
  let scheduler: SchedulerTemplates | null = null;
  let schedulerError: Error | null = null;
  try { scheduler = buildSchedulerTemplates(gather); }
  catch (error) { schedulerError = error instanceof Error ? error : new Error(String(error)); }
  logTo('info', `模板集 ${gather.setId} 已编译（${Date.now() - started}ms）：界面模板 ${gather.ui.size} 张，字形集 ${gather.glyphSets.size} 套` +
    (gather.missing.length > 0 ? `，缺 ${gather.missing.length} 张（${gather.missing.slice(0, 12).join('、')}${gather.missing.length > 12 ? '…' : ''}）` : ''));
  return { dir, stamp, gather, scheduler, schedulerError };
}

/** The probe gate report, built on a frame already captured with the cached anchors (no recompiling per job). */
async function probeOf(job: ActiveJob, set: CompiledSet, raw: RawFrame): Promise<ProbeReport> {
  const started = performance.now();
  const foreground = await request<string | null>(job, { op: 'foregroundPackage', args: [] });
  const g = set.gather;
  const frame = await prepareFrame(raw, { refWidth: g.refWidth, refHeight: g.refHeight, shrink: 2 });
  const prepared = performance.now();
  const matches: MatchResult[] = [];
  for (const id of GATHER_PROBE_TEMPLATE_IDS) {
    const tpl = g.get(id);
    if (tpl && tpl.shrink === 2) matches.push(await matchTemplate(frame, tpl));
    else {
      matches.push({
        templateId: id, found: false, score: 0, x: -1, y: -1, w: 0, h: 0, centerX: -1, centerY: -1,
        threshold: 0.85, elapsedMs: 0, reason: '模板缺失',
      });
    }
  }
  const ended = performance.now();
  return {
    gameId: wanlongPlugin.id,
    packageName: PACKAGE,
    foregroundPackage: foreground,
    foregroundMatches: foreground === PACKAGE,
    templateSet: { id: g.setId, name: g.setId, refWidth: g.refWidth, refHeight: g.refHeight },
    frame: { width: raw.width, height: raw.height, capturedAt: raw.capturedAt },
    matches,
    timingMs: { capture: 0, prepare: Math.round(prepared - started), match: Math.round(ended - prepared), total: Math.round(ended - started) },
  };
}

/** Ask main to approve formal input for this job (the probe gate). Rejects with main's Chinese reason. */
async function approve(job: ActiveJob, set: CompiledSet): Promise<void> {
  if (job.approved) return;
  const frame = job.lastFrame ?? await capture(job);
  const probe = await probeOf(job, set, frame);
  checkAbort(job);
  const decision = new Promise<void>((resolve, reject) => { job.approval = { resolve, reject }; });
  post({ type: 'ready', jobId: job.jobId, probe });
  await decision;
  job.approved = true;
}

async function capture(job: ActiveJob): Promise<RawFrame> {
  const frame = await request<RawFrame>(job, { op: 'capture', args: [] });
  job.lastFrame = frame;
  return frame;
}

function devicePort(job: ActiveJob): DevicePort {
  return {
    capture: () => capture(job),
    foregroundPackage: () => request<string | null>(job, { op: 'foregroundPackage', args: [] }),
    tap: (x, y) => request<void>(job, { op: 'tap', args: [x, y] }),
    tapMany: (points, gapMs) => request<void>(job, { op: 'tapMany', args: [points, gapMs ?? 0] }),
    swipe: (x1, y1, x2, y2, ms) => request<void>(job, { op: 'swipe', args: [x1, y1, x2, y2, ms] }),
    key: (key) => request<void>(job, { op: 'key', args: [key] }),
    launchApp: (pkg, cold) => request<void>(job, { op: 'launchApp', args: [pkg, cold] }),
    stopApp: (pkg) => request<void>(job, { op: 'stopApp', args: [pkg] }),
    isAppRunning: async () => Boolean(await request<boolean | null>(job, { op: 'isAppRunning', args: [] })),
  };
}

// ── sample job ─────────────────────────────────────────────────────────────

async function runSample(job: ActiveJob, spec: Extract<VisionJobSpec, { kind: 'sample' }>): Promise<VisionJobResult> {
  const set = await templates(spec.templateDir);
  if (!set.scheduler) throw set.schedulerError ?? new AppError('TEMPLATE_NOT_FOUND', '模板集缺少部队管理面板所需的字形');
  const t = set.scheduler;
  if (spec.config.templateSetId && spec.config.templateSetId !== t.setId) {
    throw new AppError('TEMPLATE_NOT_FOUND', `调度配置指定的模板集「${spec.config.templateSetId}」与当前实例所选模板集「${t.setId}」不一致；请清空调度配置里的模板集 ID 或改选模板集。`);
  }
  const toDevice = (x: number, y: number): [number, number] => {
    const frame = job.lastFrame;
    if (!frame) throw new AppError('INVALID_ARGUMENT', '还没有截图，无法换算点击坐标');
    return [Math.round(x * frame.width / t.refWidth), Math.round(y * frame.height / t.refHeight)];
  };
  const io: SampleIo = {
    serial: `实例 #${spec.instanceIndex}`,
    capture: () => capture(job),
    async tapRef(x, y, intent) {
      if (!intent) await approve(job, set);
      const [dx, dy] = toDevice(x, y);
      await request<void>(job, { op: 'tap', args: intent ? [dx, dy, intent] : [dx, dy] });
    },
    async key(key, intent) {
      if (!intent) await approve(job, set);
      await request<void>(job, { op: 'key', args: intent ? [key, intent] : [key] });
    },
    log: (level, message) => log(job, level, message),
    onUnrecognized: async (raw) => {
      const { frame, transfer } = copyFrame(raw);
      return request<boolean | 'recovered' | 'updated'>(job, { op: 'unrecognized', args: [frame] }, transfer);
    },
    ...(spec.allowColdStart ? { ensureGameForeground: () => request<GamePresence>(job, { op: 'ensureGame', args: [] }) } : {}),
    sleep: (ms) => sleep(job, ms),
  };
  const sample = await sampleTroopPanel(io, t, {
    refWidth: t.refWidth,
    refHeight: t.refHeight,
    maxRows: spec.config.maxRows,
    readOptionalFields: spec.config.readOptionalFields,
    closePanelAfterSample: spec.config.closePanelAfterSample,
    deadlineAt: spec.deadlineAt,
  });
  return { kind: 'sample', sample };
}

// ── gather job ─────────────────────────────────────────────────────────────

/** Recognisable (probe gate would pass) or at least loaded (a popup's close button is visible). */
async function gateOk(job: ActiveJob, set: CompiledSet, raw: RawFrame): Promise<boolean> {
  return inspectGatherProbe(await probeOf(job, set, raw)).ok;
}

async function findClosePopup(set: CompiledSet, raw: RawFrame): Promise<MatchResult | null> {
  const g = set.gather;
  const frame = await prepareFrame(raw, { refWidth: g.refWidth, refHeight: g.refHeight, shrink: 2 });
  for (const tpl of closePopupTemplates(g)) {
    if (tpl.shrink !== 2) continue;
    let m = await matchTemplate(frame, tpl, { roi: POPUP_CLOSE_ROI });
    if (!m.found && tpl.defaultRoi) m = await matchTemplate(frame, tpl, { roi: tpl.defaultRoi });
    if (m.found) return m;
  }
  return null;
}

/** Ask main's unknown-screen advisor (AI / game update) about a frame; true = it acted and the screen changed. */
async function advise(job: ActiveJob, raw: RawFrame, attempt: number): Promise<boolean> {
  const { frame, transfer } = copyFrame(raw);
  return (await request<boolean>(job, { op: 'advise', args: [frame, attempt] }, transfer)) === true;
}

/**
 * Pre-approval recovery for a gather cycle (DECISIONS C whitelist): monkey-launch the game when it is not in front
 * and wait (look only) for a known screen; then the original G0 ladder in miniature — at most one popup ×, the
 * unknown-screen advisor (AI / update, when main offers it), one blind BACK and an exit-dialog「取消」(never「确定」).
 * Everything else waits for the probe gate.
 * @returns the last frame and whether it passes the gate locally (main re-checks at approval)
 */
async function recoverBeforeGate(
  job: ActiveJob, set: CompiledSet, spec: Extract<VisionJobSpec, { kind: 'gather' }>,
): Promise<{ raw: RawFrame; ok: boolean }> {
  const g = set.gather;
  const foreground = await request<string | null>(job, { op: 'foregroundPackage', args: [] });
  if (foreground !== PACKAGE && spec.allowColdStart) {
    log(job, 'info', `当前前台是「${foreground ?? '未知'}」，不是万龙觉醒，先用 monkey 拉起游戏。`);
    const presence = await request<GamePresence>(job, { op: 'ensureGame', args: [] });
    if (presence === 'launched') {
      const until = Date.now() + GAME_LOAD_WAIT_MS;
      for (;;) {
        await sleep(job, GAME_LOAD_POLL_MS);
        const raw = await capture(job);
        if (await gateOk(job, set, raw) || await findClosePopup(set, raw) ||
            await isRecognizableScreen(g, raw, { refWidth: g.refWidth, refHeight: g.refHeight })) {
          log(job, 'info', '游戏已经加载出已知界面。');
          break;
        }
        if (Date.now() >= until) {
          log(job, 'warn', `等了 ${Math.round(GAME_LOAD_WAIT_MS / 1000)}s 仍然认不出界面，交给弹窗 / BACK 恢复。`);
          break;
        }
      }
    }
  }
  let raw = await capture(job);
  if (await gateOk(job, set, raw)) return { raw, ok: true };
  // A known screen that still fails the gate (e.g. two anchors close): the gate's reason is the answer, and a
  // blind BACK on the world map would only raise the exit dialog.
  if (await isRecognizableScreen(g, raw, { refWidth: g.refWidth, refHeight: g.refHeight })) return { raw, ok: false };
  const popup = await findClosePopup(set, raw);
  if (popup) {
    log(job, 'info', `找到弹窗关闭按钮（${popup.templateId} ${popup.score}），点它关掉活动弹窗。`);
    await request<void>(job, { op: 'tap', args: [Math.round(popup.centerX * raw.width / g.refWidth), Math.round(popup.centerY * raw.height / g.refHeight), 'closePopup'] });
    await sleep(job, 900);
    raw = await capture(job);
    if (await gateOk(job, set, raw)) return { raw, ok: true };
  }
  // Original order: popup × → advisor → blind BACK (the advisor never presses BACK itself).
  if (spec.advisor) {
    for (let attempt = 1; attempt <= PRE_GATE_ADVISE; attempt++) {
      let handled = false;
      try { handled = await advise(job, raw, attempt); }
      catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'GAME_UPDATE_REQUIRED' || code === 'AI_RISK_BLOCKED' || job.controller.signal.aborted) throw error;
        log(job, 'warn', `AI 顾问出错，按未处理继续：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!handled) break;
      log(job, 'info', 'AI 顾问处理了认不出的界面，重新判断。');
      raw = await capture(job);
      if (await gateOk(job, set, raw)) return { raw, ok: true };
    }
  }
  log(job, 'warn', '认不出当前界面，按一次 BACK 试探（若弹出退出确认框会立刻点「取消」）。');
  await request<void>(job, { op: 'key', args: ['BACK', 'probeBack'] });
  await sleep(job, 1200);
  raw = await capture(job);
  const notice = g.get(TPL.dlgTitleNotice);
  const cancel = g.get(TPL.btnCancel);
  if (notice && notice.shrink === 2) {
    const frame = await prepareFrame(raw, { refWidth: g.refWidth, refHeight: g.refHeight, shrink: 2 });
    if ((await matchTemplate(frame, notice)).found) {
      const btn = cancel && cancel.shrink === 2 ? await matchTemplate(frame, cancel) : null;
      if (btn?.found) {
        log(job, 'warn', '弹出了退出游戏确认框，立刻点「取消」（绝不会点确定）。');
        await request<void>(job, { op: 'tap', args: [Math.round(btn.centerX * raw.width / g.refWidth), Math.round(btn.centerY * raw.height / g.refHeight), 'exitCancel'] });
        await sleep(job, 600);
        raw = await capture(job);
      } else {
        log(job, 'warn', '弹出了退出游戏确认框，但没定位到「取消」按钮，请手动关掉它。');
      }
    }
  }
  return { raw, ok: await gateOk(job, set, raw) };
}

/**
 * The pre-gate ladder is exhausted and the screen still fails the gate: end the cycle like the original G0 does —
 * a「g0-failed」scene shot (main saves it and runs the kicked probe on it) and STEP_FAILED with step 'G0', so alerts
 * see "recovery ladder exhausted" instead of a generic start-up failure.
 */
async function failG0(job: ActiveJob, set: CompiledSet, raw: RawFrame): Promise<never> {
  const decision = inspectGatherProbe(await probeOf(job, set, raw));
  const { frame, transfer } = copyFrame(raw);
  post({ type: 'shot', jobId: job.jobId, label: 'g0-failed', raw: frame }, transfer);
  const reason = decision.ok ? '' : decision.reason;
  throw new AppError('STEP_FAILED',
    `开跑前的恢复阶梯（拉起游戏 / 关弹窗 / AI / BACK）跑完仍回不到可识别的界面${reason ? `：${reason}` : ''}。` +
    '请手动把游戏切到城内或世界地图，或检查城内 / 世界地图的模板是否仍然有效。', { step: 'G0' });
}

async function runGather(job: ActiveJob, spec: Extract<VisionJobSpec, { kind: 'gather' }>): Promise<VisionJobResult> {
  const set = await templates(spec.templateDir);
  assertGatherTemplatesComplete(set.gather);
  checkAbort(job);
  const gate = await recoverBeforeGate(job, set, spec);
  checkAbort(job);
  if (!gate.ok) await failG0(job, set, gate.raw);
  await approve(job, set);
  checkAbort(job);
  const g = set.gather;
  const io = createGatherIo(devicePort(job), {
    refWidth: g.refWidth, refHeight: g.refHeight, signal: job.controller.signal,
    log: (level, message) => log(job, level, message),
  });
  const advisor: UnknownScreenAdvisor | undefined = spec.advisor ? {
    async handleUnknownScreen(ctx) {
      const { frame, transfer } = copyFrame(ctx.raw);
      return (await request<boolean>(job, { op: 'advise', args: [frame, ctx.attempt] }, transfer)) === true;
    },
  } : undefined;
  const result = await runGatherCycle({
    io,
    templates: g,
    config: spec.config,
    state: spec.state,
    signal: job.controller.signal,
    instanceIndex: spec.instanceIndex,
    log: (level, message) => log(job, level, message),
    // Failure scenes always go to main (kicked probe + fact); other labels only when every shot is kept.
    onShot: (label, raw) => {
      if (!FAILURE_SHOT_LABELS.has(label) && spec.shotPolicy !== 'always') return;
      const { frame, transfer } = copyFrame(raw);
      post({ type: 'shot', jobId: job.jobId, label, raw: frame }, transfer);
    },
    ...(advisor ? { advisor } : {}),
  });
  return { kind: 'gather', result };
}

// ── read-only queries (any time, also during a job) ──────────────────────

/** The calibrated update prompt and progress texts on a frame (game-data `GameUpdateRecovery`, silent without templates). */
async function answerUpdate(templateDir: string, frame: RawFrame): Promise<VisionQueryResult> {
  const dir = await realpath(templateDir);
  let updater = updaters.get(dir);
  if (!updater) {
    updater = new GameUpdateRecovery({ templateDir: () => dir });
    updaters.set(dir, updater);
  }
  const target = await updater.detect(frame);
  const downloading = await updater.progress(frame, false);
  const progress = downloading || await updater.progress(frame, true);
  return { kind: 'update', target, downloading, progress };
}

async function answer(query: VisionQuery): Promise<VisionQueryResult> {
  if (query.kind === 'update') return answerUpdate(query.templateDir, query.frame);
  if (query.kind === 'frameDiff') {
    return query.box
      ? { kind: 'frameDiff', mean: null, stable: await localFrameComparer.stableTarget(query.frame, query.other, query.box, query.refWidth, query.refHeight) }
      : { kind: 'frameDiff', mean: await localFrameComparer.meanAbsDiff(query.frame, query.other, query.refWidth, query.refHeight), stable: null };
  }
  const set = await templates(query.templateDir);
  const g = set.gather;
  if (query.kind === 'recognize') {
    return { kind: 'recognize', recognized: await isRecognizableScreen(g, query.frame, { refWidth: g.refWidth, refHeight: g.refHeight }) };
  }
  const frame = await prepareFrame(query.frame, { refWidth: g.refWidth, refHeight: g.refHeight, shrink: 2 });
  const matches: MatchResult[] = [];
  for (const id of query.templateIds) {
    const tpl = g.get(id);
    if (!tpl || tpl.shrink !== 2) {
      matches.push({
        templateId: id, found: false, score: 0, x: -1, y: -1, w: 0, h: 0, centerX: -1, centerY: -1,
        threshold: query.threshold ?? 0, elapsedMs: 0, reason: '模板缺失',
      });
      continue;
    }
    matches.push(await matchTemplate(frame, tpl, {
      ...(query.roi ? { roi: query.roi } : {}),
      ...(query.threshold === undefined ? {} : { threshold: query.threshold }),
    }));
  }
  return { kind: 'match', matches };
}

async function runQuery(queryId: number, query: VisionQuery): Promise<void> {
  try {
    post({ type: 'queryResult', queryId, ok: true, result: await answer(query) });
  } catch (error) {
    post({ type: 'queryResult', queryId, ok: false, error: serializeError(error) });
  }
}

async function run(jobId: number, spec: VisionJobSpec): Promise<void> {
  const job: ActiveJob = { jobId, controller: new AbortController(), pending: new Map(), approved: false, lastFrame: null };
  active = job;
  try {
    const result = spec.kind === 'sample' ? await runSample(job, spec) : await runGather(job, spec);
    post({ type: 'result', jobId, result });
  } catch (error) {
    const err = job.controller.signal.aborted ? aborted(job) : error;
    post({ type: 'failed', jobId, error: serializeError(err) });
  } finally {
    if (active === job) active = null;
  }
}

port.on('message', (message: MainToWorker) => {
  if (message.type === 'invalidate') {
    compiled.clear();
    for (const updater of updaters.values()) updater.invalidate();
    return;
  }
  if (message.type === 'query') { void runQuery(message.queryId, message.query); return; }
  if (message.type === 'job') {
    if (active) {
      post({ type: 'failed', jobId: message.jobId, error: { code: 'CONCURRENCY_LIMIT', message: '视觉工作线程正忙' } });
      return;
    }
    void run(message.jobId, message.spec);
    return;
  }
  const job = active;
  if (!job || message.jobId !== job.jobId) return;
  switch (message.type) {
    case 'response': {
      const item = job.pending.get(message.id);
      if (!item) return;
      job.pending.delete(message.id);
      if (message.ok) item.resolve(message.value);
      else item.reject(revive(message.error, '设备操作失败'));
      return;
    }
    case 'approved':
      job.approval?.resolve();
      job.approval = undefined;
      return;
    case 'denied':
      job.approval?.reject(new AppError('PROBE_REJECTED', message.reason));
      job.approval = undefined;
      return;
    case 'abort': {
      const error = revive(message.error, '自动调度已停止。');
      job.controller.abort(error);
      job.approval?.reject(error);
      job.approval = undefined;
      for (const item of job.pending.values()) item.reject(error);
      job.pending.clear();
      return;
    }
  }
});
