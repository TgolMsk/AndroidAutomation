import type { MatchResult, PreparedFrame, PreparedTemplate, RawFrame } from '../src/index.js';
import { ScriptContext, ScriptEngine, type ScriptContextInit, type ScriptDevicePort, type ScriptEngineOptions } from '../src/index.js';
import type { AiAssistResult, AiConsultRequest, LogEntry, RunSnapshot, ScriptDef, ScriptStep } from '../src/script/index.js';

export const PKG = 'org.example.game';

export function script(steps: ScriptStep[], extra: Partial<ScriptDef> = {}): ScriptDef {
  return { id: 'test', name: '测试', version: '1.0.0', packageName: PKG, refWidth: 100, refHeight: 100, updatedAt: 0, steps, ...extra };
}

export function frame(width = 200, height = 100): RawFrame {
  return { width, height, data: new Uint8Array(width * height * 4), capturedAt: Date.now() };
}

export function template(id: string): PreparedTemplate {
  return {
    id, name: id, gray: new Uint8Array(9), width: 3, height: 3, w: 3, h: 3, refWidth: 6, refHeight: 6, refW: 6, refH: 6,
    shrink: 2, threshold: 0.85, std: 40,
  };
}

export interface FakeDevice extends ScriptDevicePort {
  actions: string[];
  captures: number;
  foreground: string | null;
}

export function fakeDevice(overrides: Partial<ScriptDevicePort> = {}): FakeDevice {
  const device: FakeDevice = {
    actions: [],
    captures: 0,
    foreground: PKG,
    async capture() { device.captures++; return frame(); },
    async foregroundPackage() { return device.foreground; },
    async tap(x, y) { device.actions.push(`tap:${x},${y}`); },
    async swipe(x1, y1, x2, y2, ms) { device.actions.push(`swipe:${x1},${y1},${x2},${y2},${ms}`); },
    async longPress(x, y, ms) { device.actions.push(`long:${x},${y},${ms}`); },
    async inputText(text) { device.actions.push(`text:${text}`); },
    async key(key) { device.actions.push(`key:${key}`); },
    async launchApp(pkg, cold) { device.actions.push(`launch:${pkg}:${cold}`); },
    async stopApp(pkg) { device.actions.push(`stop:${pkg}`); },
    ...overrides,
  };
  return device;
}

/** A vision port whose verdict per template is decided by the test. */
export function fakeVision(found: (templateId: string, call: number) => boolean | number = () => false) {
  let calls = 0;
  const seen: Array<{ templateId: string; roi?: unknown }> = [];
  return {
    seen,
    get calls() { return calls; },
    async prepareFrame(raw: RawFrame, options: { refWidth: number; refHeight: number; shrink?: number }): Promise<PreparedFrame> {
      return {
        gray: new Uint8Array(1), width: 1, height: 1, w: 1, h: 1, shrink: options.shrink ?? 2,
        refWidth: options.refWidth, refHeight: options.refHeight, deviceWidth: raw.width, deviceHeight: raw.height, capturedAt: raw.capturedAt,
      };
    },
    async match(_frame: PreparedFrame, tpl: PreparedTemplate, options?: { roi?: unknown; threshold?: number }): Promise<MatchResult> {
      calls++;
      seen.push({ templateId: tpl.id, roi: options?.roi });
      const verdict = found(tpl.id, calls);
      const hit = verdict === true || typeof verdict === 'number';
      const score = typeof verdict === 'number' ? verdict : hit ? 0.97 : 0.31;
      return {
        templateId: tpl.id, found: hit, score, x: hit ? 40 : -1, y: hit ? 20 : -1, w: 6, h: 6,
        centerX: hit ? 43 : -1, centerY: hit ? 23 : -1, threshold: options?.threshold ?? 0.85, elapsedMs: 1,
        ...(hit ? {} : { reason: '低于阈值' }),
      };
    },
  };
}

export interface Harness {
  ctx: ScriptContext;
  engine: ScriptEngine;
  device: FakeDevice;
  logs: LogEntry[];
  statuses: RunSnapshot[];
  shots: string[];
  consults: AiConsultRequest[];
  run(): Promise<RunSnapshot>;
}

export function harness(
  def: ScriptDef,
  options: {
    device?: FakeDevice;
    vision?: ReturnType<typeof fakeVision>;
    templates?: string[];
    engine?: ScriptEngineOptions;
    context?: Partial<ScriptContextInit>;
    consult?: (request: AiConsultRequest) => Promise<AiAssistResult>;
    shotSave?: (file: string) => Promise<string>;
  } = {},
): Harness {
  const device = options.device ?? fakeDevice();
  const logs: LogEntry[] = [];
  const statuses: RunSnapshot[] = [];
  const shots: string[] = [];
  const consults: AiConsultRequest[] = [];
  const ctx = new ScriptContext({
    runId: 'run-1',
    instanceIndex: 3,
    script: def,
    params: {},
    templates: new Map((options.templates ?? []).map((id) => [id, template(id)])),
    device,
    vision: options.vision ?? fakeVision(),
    shots: {
      encode: async () => new Uint8Array([0xff, 0xd8]),
      save: options.shotSave ?? (async (file) => { shots.push(file); return `run-1/${file}`; }),
    },
    consultAi: options.consult ? async (request) => { consults.push(request); return options.consult!(request); } : undefined,
    onLogs: (entries) => logs.push(...entries),
    onStatus: (snapshot) => statuses.push(snapshot),
    minCaptureIntervalMs: 0,
    captureJitterMs: 0,
    statusIntervalMs: 0,
    logFlushMs: 5,
    ...options.context,
  });
  const engine = new ScriptEngine(ctx, { restartGapMs: 0, restartSettleMs: 0, ...options.engine });
  return {
    ctx, engine, device, logs, statuses, shots, consults,
    async run() { const result = await engine.run(); ctx.dispose(); return result; },
  };
}
