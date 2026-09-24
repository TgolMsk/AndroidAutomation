import {
  defaultVision, encodeTraceShot, ExecutionGuardError, loadTemplateSet, readTemplatePng, ScriptContext, ScriptEngine, warmUpVision,
  type PreparedTemplate, type RawFrame, type ScriptDevicePort, type VisionPort,
} from '@avdm/automation';
import { referencedTemplateIds, type AiAssistResult, type AiConsultRequest } from '@avdm/automation/script';
import {
  AI_CONSULT_TIMEOUT_MS, type ScriptDeviceRequest, type ScriptMainToWorker, type ScriptWorkerInput, type ScriptWorkerPort,
  type ScriptWorkerToMain,
} from './script-protocol';

/** Template / frame down-sampling when the app settings give none (the vision package default). */
const SHRINK = 2;

/** The run's downsampling factor: the app settings' `shrink` (1–4), else the vision default. */
function runShrink(input: ScriptWorkerInput): number {
  const value = input.matchDefaults?.shrink;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4 ? value : SHRINK;
}

/** Threshold for templates that set none (app settings `matchThreshold`); undefined keeps the vision default. */
function defaultThreshold(input: ScriptWorkerInput): number | undefined {
  const value = input.matchDefaults?.threshold;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : undefined;
}

export interface ScriptWorkerDeps {
  vision?: Pick<VisionPort, 'prepareFrame' | 'prepareTemplate' | 'match'>;
  encodeShot?: (raw: RawFrame) => Promise<Uint8Array>;
  /** Skip the OpenCV warm-up (tests with a fake vision port). */
  warmUp?: () => Promise<void>;
  echoLogs?: boolean;
}

interface PreparedSet { templates: Map<string, PreparedTemplate>; refWidth: number; refHeight: number }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Load and compile exactly the templates the script references; fail early with the full list of problems. */
async function prepareTemplates(input: ScriptWorkerInput, vision: ScriptWorkerDeps['vision'] & object, shrink: number): Promise<PreparedSet> {
  const ids = referencedTemplateIds(input.script);
  if (!ids.length) return { templates: new Map(), refWidth: input.script.refWidth, refHeight: input.script.refHeight };
  if (!input.templateDir) throw new Error('脚本用到了模板匹配，但该实例还没有选择模板集。请先到「模板库」为这个实例选择或新建模板集。');
  const set = await loadTemplateSet(input.templateDir);
  if (input.script.templateSetId && set.id !== input.script.templateSetId) {
    throw new Error(`脚本需要模板集「${input.script.templateSetId}」，但实例当前使用的是「${set.id}」。请切换模板集或修改脚本的 templateSetId。`);
  }
  if (set.packageName && input.script.packageName && set.packageName !== input.script.packageName) {
    throw new Error(`模板集属于 ${set.packageName}，与脚本的游戏包名 ${input.script.packageName} 不一致。`);
  }
  const templates = new Map<string, PreparedTemplate>();
  const threshold = defaultThreshold(input);
  const missing: string[] = [];
  const broken: string[] = [];
  for (const id of ids) {
    const stored = set.templates.find((item) => item.id === id);
    if (!stored) { missing.push(id); continue; }
    // Original matchOnce: the settings threshold only fills in for templates without their own.
    const definition = threshold !== undefined && stored.threshold === undefined ? { ...stored, threshold } : stored;
    try { templates.set(id, await vision.prepareTemplate(await readTemplatePng(set, id), definition, set, shrink)); }
    catch (error) { broken.push(`${id}（${message(error)}）`); }
  }
  if (missing.length || broken.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`模板集「${set.id}」里没有 ${missing.join('、')}`);
    if (broken.length) parts.push(`无法编译 ${broken.join('、')}（纯色、渐变这类低方差模板会被拒绝，请换一块有图标或文字的区域重新截取）`);
    throw new Error(`脚本引用的模板无法使用：${parts.join('；')}。`);
  }
  return { templates, refWidth: set.refWidth, refHeight: set.refHeight };
}

/**
 * The script executor thread (wanlong-panel `src/worker/runner.ts`): compiles templates, runs the engine, and
 * turns every device operation into a request to the main process, which owns adb, files and the leases.
 * Kept separate from the thread entry so tests can run it in-process over a fake channel.
 */
export function attachScriptWorker(port: ScriptWorkerPort, deps: ScriptWorkerDeps = {}): void {
  const vision = deps.vision ?? defaultVision;
  const encodeShot = deps.encodeShot ?? ((raw: RawFrame) => encodeTraceShot(raw));
  const warmUp = deps.warmUp ?? warmUpVision;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const aiPending = new Map<string, (result: AiAssistResult) => void>();
  let nextId = 1;
  let aiSeq = 0;
  let aborted: Error | null = null;
  let started = false;
  let ran = false;
  let stopRequested = false;
  let context: ScriptContext | null = null;
  let engine: ScriptEngine | null = null;
  const queuedControls: ScriptMainToWorker[] = [];

  const send = (message: ScriptWorkerToMain, transfer?: ArrayBuffer[]): void => {
    try { port.postMessage(message, transfer); }
    catch (error) { console.error(`[script-worker] 向主进程发送消息失败：${String(error)}`); }
  };

  function request<T>(op: ScriptDeviceRequest['op'], args: unknown[], transfer?: ArrayBuffer[]): Promise<T> {
    if (aborted) return Promise.reject(aborted);
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      send({ type: 'request', id, op, args } as ScriptDeviceRequest, transfer);
    });
  }

  const device: ScriptDevicePort = {
    capture: () => request<RawFrame>('capture', []),
    foregroundPackage: () => request<string | null>('foregroundPackage', []),
    tap: (x, y) => request<void>('tap', [x, y]),
    swipe: (x1, y1, x2, y2, durationMs) => request<void>('swipe', [x1, y1, x2, y2, durationMs]),
    longPress: (x, y, durationMs) => request<void>('longPress', [x, y, durationMs]),
    inputText: (text) => request<void>('text', [text]),
    key: (key) => request<void>('key', [key]),
    launchApp: (packageName, cold) => request<void>('launchApp', [packageName, cold]),
    stopApp: (packageName) => request<void>('stopApp', [packageName]),
  };

  /** ★ Never throws: the advisor is a fallback; its own problems must not fail the script. */
  const consultAi = (req: AiConsultRequest): Promise<AiAssistResult> => new Promise((resolve) => {
    const requestId = `ai-${++aiSeq}`;
    let done = false;
    const finish = (result: AiAssistResult): void => {
      if (done) return;
      done = true;
      aiPending.delete(requestId);
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ handled: false, message: 'AI 顾问超时没有回应，按未处理继续。' }), AI_CONSULT_TIMEOUT_MS);
    timer.unref?.();
    aiPending.set(requestId, finish);
    send({ type: 'aiConsult', requestId, stepId: req.stepId, reason: req.reason, expectTemplateIds: req.expectTemplateIds });
  });

  function control(message: ScriptMainToWorker): void {
    if (!engine || !context) { queuedControls.push(message); return; }
    switch (message.type) {
      case 'pause': engine.pause(); break;
      case 'resume': engine.resume(); break;
      case 'stop': engine.stop(message.reason); break;
      case 'debugMatches': context.setDebugMatches(message.enabled); break;
      default: break;
    }
  }

  async function execute(): Promise<void> {
    if (ran || !engine || !context) return;
    ran = true;
    try {
      const snapshot = await engine.run();
      context.dispose();
      send({ type: 'finished', snapshot });
    } catch (error) {
      context.dispose();
      send({ type: 'failed', error: `脚本执行意外中断：${message(error)}` });
    }
  }

  async function start(input: ScriptWorkerInput): Promise<void> {
    try {
      const shrink = runShrink(input);
      const prepared = await prepareTemplates(input, vision, shrink);
      if (prepared.templates.size) await warmUp();
      context = new ScriptContext({
        runId: input.runId,
        instanceIndex: input.instanceIndex,
        script: input.script,
        params: input.params,
        accountId: input.accountId,
        accountName: input.accountName,
        templates: prepared.templates,
        refWidth: prepared.refWidth,
        refHeight: prepared.refHeight,
        shrink,
        shotPolicy: input.shotPolicy,
        device,
        vision,
        shots: {
          encode: encodeShot,
          save: async (file, jpeg) => request<string>('shot', [file, jpeg], [jpeg.buffer as ArrayBuffer]),
        },
        consultAi: input.consultAi ? consultAi : undefined,
        onLogs: (entries) => send({ type: 'logs', entries }),
        onStatus: (snapshot) => send({ type: 'status', snapshot }),
        onMatches: (results) => send({ type: 'matches', results }),
        debugMatches: input.debugMatches,
        shotSeqStart: input.shotSeqStart,
        minCaptureIntervalMs: input.minCaptureIntervalMs,
        captureJitterMs: input.captureJitterMs,
        echoLogs: deps.echoLogs ?? true,
      });
      engine = new ScriptEngine(context, {
        maxRunMs: input.maxRunMs,
        restartGapMs: input.restartGapMs,
        restartSettleMs: input.restartSettleMs,
      });
      context.log('info', `执行器就绪：模板 ${prepared.templates.size} 张，参考分辨率 ${prepared.refWidth}x${prepared.refHeight}，降采样 1/${shrink}。`,
        undefined, { scope: 'runner' });
      for (const queued of queuedControls.splice(0)) control(queued);
      send({ type: 'ready', templates: prepared.templates.size, refWidth: prepared.refWidth, refHeight: prepared.refHeight, shrink });
      // Stopped before the gate opened: finish as aborted without touching the device.
      if (stopRequested) void execute();
    } catch (error) {
      send({ type: 'failed', error: message(error) });
    }
  }

  port.on('message', (msg: ScriptMainToWorker) => {
    switch (msg.type) {
      case 'response': {
        const item = pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id);
        if (msg.ok) item.resolve(msg.value);
        else item.reject(msg.guard ? new ExecutionGuardError(msg.error) : new Error(msg.error));
        return;
      }
      case 'start':
        if (started) return;
        started = true;
        void start(msg.input);
        return;
      case 'go':
        void execute();
        return;
      case 'aiResult':
        // Unknown id = already timed out: drop it so a late answer cannot change the screen again.
        aiPending.get(msg.requestId)?.(msg.result);
        return;
      case 'abort': {
        const error = new Error(msg.reason);
        aborted = error;
        stopRequested = true;
        for (const item of pending.values()) item.reject(error);
        pending.clear();
        for (const finish of [...aiPending.values()]) finish({ handled: false, message: '执行已停止，不再等待 AI 顾问。' });
        control({ type: 'stop', reason: msg.reason });
        if (engine && !ran) void execute();
        return;
      }
      case 'stop':
        stopRequested = true;
        // The engine stops waiting on its own; settle the entries too so a late answer is dropped.
        for (const finish of [...aiPending.values()]) finish({ handled: false, message: '执行已停止，不再等待 AI 顾问。' });
        control(msg);
        if (engine && !ran) void execute();
        return;
      default:
        control(msg);
    }
  });
}
