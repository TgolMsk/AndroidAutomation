import { defaultVision, loadTemplateSet, readTemplatePng, type PreparedTemplate, type TemplateSet } from '@avdm/automation';
import type { Condition, ScriptDef, ScriptDevice, ScriptStep } from './types';

const MAX_EXECUTED_STEPS = 10_000;
const MAX_GOTO = 1_000;
const MAX_RESTARTS = 3;
type Jump = { label: string } | null;

/** An execution precondition that retries and onFail rules must never bypass. */
export class ExecutionGuardError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecutionGuardError'; }
}

class ForegroundChangedError extends ExecutionGuardError {
  constructor(expected: string, actual: string | undefined) {
    super(`目标游戏已离开前台（预期 ${expected}，当前 ${actual ?? '未知'}），脚本已停止`);
    this.name = 'ForegroundChangedError';
  }
}

export interface ScriptExecution {
  script: ScriptDef;
  device: ScriptDevice;
  templateDir: string;
  signal: AbortSignal;
  params?: Record<string, string | number | boolean>;
  maxRunMs: number;
  /** Re-read the bound account and AVD identity before any device interaction. */
  assertAccount?: () => Promise<void>;
  onStep?: (step: ScriptStep, executed: number) => void;
  onLog?: (level: string, message: string, stepId?: string) => void;
  onScreenshot?: (label: string, png: Uint8Array) => Promise<void>;
}

/** Interprets legacy JSON steps; all physical input goes through the emulator's device API. */
export async function executeScript(options: ScriptExecution): Promise<{ executed: number }> {
  const { script, device, signal } = options;
  const targetPackage = script.packageName;
  if (!targetPackage) throw new Error('脚本缺少目标游戏包名');
  const deadline = Date.now() + options.maxRunMs;
  const params = Object.fromEntries((script.params ?? []).filter((p) => p.default !== undefined).map((p) => [p.key, p.default!])) as Record<string, string | number | boolean>;
  Object.assign(params, options.params ?? {});
  const interpolate = (text: string): string => text.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_all, key: string) => {
    if (!(key in params)) throw new Error(`未提供脚本参数 ${key}`);
    return String(params[key]);
  });
  const check = (): void => {
    if (signal.aborted) throw signal.reason ?? new Error('脚本已取消');
    if (Date.now() > deadline) throw new Error('脚本超过本次时间上限');
  };
  const assertOwnership = async (): Promise<void> => {
    check();
    await options.assertAccount?.();
    check();
  };
  /** Check immediately before each input; a stale startup check is insufficient. */
  const assertForeground = async (): Promise<void> => {
    await assertOwnership();
    const current = await device.foregroundPackage();
    check();
    if (current !== targetPackage) throw new ForegroundChangedError(targetPackage, current);
  };
  const pause = async (ms: number): Promise<void> => {
    check();
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
      const aborted = (): void => { clearTimeout(timer); reject(signal.reason ?? new Error('脚本已取消')); };
      signal.addEventListener('abort', aborted, { once: true });
    });
    check();
  };
  await assertForeground();
  const image = await device.screencapRaw();
  const scale = (x: number, y: number): [number, number] => [Math.round(x * image.width / script.refWidth), Math.round(y * image.height / script.refHeight)];
  await assertForeground();
  let set: TemplateSet | null = null;
  const prepared = new Map<string, PreparedTemplate>();
  const template = async (id: string): Promise<PreparedTemplate> => {
    if (!set) {
      if (!options.templateDir) throw new Error('脚本需要模板集，请先配置模板');
      set = await loadTemplateSet(options.templateDir);
      if (script.templateSetId && set.id !== script.templateSetId) throw new Error(`模板集不匹配：需要 ${script.templateSetId}`);
      if (set.packageName && set.packageName !== script.packageName) throw new Error('模板集包名与脚本不一致');
    }
    const existing = prepared.get(id);
    if (existing) return existing;
    const def = set.templates.find((entry) => entry.id === id);
    if (!def) throw new Error(`模板 ${id} 不存在`);
    const next = await defaultVision.prepareTemplate(await readTemplatePng(set, id), def, set);
    prepared.set(id, next);
    return next;
  };
  const match = async (id: string, roi?: { x: number; y: number; w: number; h: number }, threshold?: number) => {
    check();
    await assertForeground();
    const tpl = await template(id);
    const current = await device.screencapRaw();
    await assertForeground();
    const loadedSet = set!;
    const frame = await defaultVision.prepareFrame(current, { refWidth: loadedSet.refWidth, refHeight: loadedSet.refHeight });
    const converted = roi ? { x: roi.x * loadedSet.refWidth / script.refWidth, y: roi.y * loadedSet.refHeight / script.refHeight,
      w: roi.w * loadedSet.refWidth / script.refWidth, h: roi.h * loadedSet.refHeight / script.refHeight } : undefined;
    const result = await defaultVision.match(frame, tpl, { roi: converted, threshold });
    return { ...result, centerX: result.centerX * script.refWidth / loadedSet.refWidth, centerY: result.centerY * script.refHeight / loadedSet.refHeight };
  };
  const condition = async (value: Condition): Promise<boolean> => {
    check();
    switch (value.kind) {
      case 'always': return true;
      case 'never': return false;
      case 'foreground': {
        const found = (await device.foregroundPackage()) === value.packageName;
        return value.equals === false ? !found : found;
      }
      case 'template': {
        const found = (await match(value.templateId, value.roi, value.threshold)).found;
        return value.present === false ? !found : found;
      }
      case 'anyTemplate':
        for (const id of value.templateIds) if ((await match(id, value.roi, value.threshold)).found) return true;
        return false;
      case 'and':
        for (const one of value.all) if (!(await condition(one))) return false;
        return true;
      case 'or':
        for (const one of value.any) if (await condition(one)) return true;
        return false;
      case 'not': return !(await condition(value.of));
    }
  };
  const waitFor = async (test: () => Promise<boolean>, waitMs: number, pollMs = 500): Promise<void> => {
    const until = Date.now() + waitMs;
    for (;;) {
      check();
      if (await test()) return;
      if (Date.now() >= until) throw new Error('等待条件超时');
      await pause(Math.min(Math.max(100, pollMs), until - Date.now()));
    }
  };
  let executed = 0;
  let restarts = 0;
  const gotoCounts = new Map<string, number>();
  const action = async (step: ScriptStep): Promise<void> => {
    switch (step.kind) {
      case 'tap': { const [x, y] = scale(step.at.x, step.at.y); await assertForeground(); await device.tap(x, y); break; }
      case 'tapTemplate': {
        let found: { centerX: number; centerY: number } | null = null;
        await waitFor(async () => {
          const result = await match(step.templateId, step.roi, step.threshold);
          if (result.found) found = result;
          return result.found;
        }, step.waitMs ?? 0, step.pollMs);
        if (!found) throw new Error(`模板 ${step.templateId} 未命中`);
        const hit = found as { centerX: number; centerY: number };
        const [x, y] = scale(hit.centerX + (step.offset?.x ?? 0), hit.centerY + (step.offset?.y ?? 0));
        await assertForeground();
        await device.tap(x, y);
        break;
      }
      case 'waitFor': await waitFor(() => condition(step.cond), step.waitMs, step.pollMs); break;
      case 'swipe': {
        const [x1, y1] = scale(step.from.x, step.from.y);
        const [x2, y2] = scale(step.to.x, step.to.y);
        await assertForeground();
        await device.swipe(x1, y1, x2, y2, step.durationMs ?? 300);
        break;
      }
      case 'longPress': {
        const [x, y] = scale(step.at.x, step.at.y);
        // One adb shell command keeps DOWN/UP paired even while other commands wait in the host.
        await assertForeground();
        await device.shell(`input motionevent DOWN ${x} ${y}; sleep ${(step.durationMs / 1000).toFixed(3)}; input motionevent UP ${x} ${y}`, { timeoutMs: step.durationMs + 10_000 });
        break;
      }
      case 'text': { const value = interpolate(step.text); await assertForeground(); await device.text(value, assertForeground); break; }
      case 'key': await assertForeground(); await device.keyevent(step.key); break;
      case 'sleep': await pause(step.ms); break;
      case 'launchApp':
        await assertOwnership();
        if (step.cold) await device.stopApp(script.packageName!);
        await assertOwnership();
        await device.startApp(script.packageName!);
        break;
      case 'stopApp': await assertOwnership(); await device.stopApp(script.packageName!); break;
      case 'screenshot': {
        await assertForeground();
        const png = await device.screencapPng();
        await assertForeground();
        await options.onScreenshot?.(step.label ?? step.id, png);
        break;
      }
      case 'log': options.onLog?.(step.level, interpolate(step.message), step.id); break;
      default: throw new Error(`未实现步骤 ${step.kind}`);
    }
  };
  const block = async (steps: ScriptStep[]): Promise<Jump> => {
    const labels = new Map(steps.flatMap((step, index) => step.kind === 'label' ? [[step.label, index] as const] : []));
    for (let i = 0; i < steps.length; i++) {
      check();
      const step = steps[i]!;
      if (++executed > MAX_EXECUTED_STEPS) throw new Error('脚本超过步骤执行硬上限');
      options.onStep?.(step, executed);
      if (step.when && !(await condition(step.when))) continue;
      let jump: Jump = null;
      let succeeded = false;
      for (let attempt = 0; attempt <= (step.retry ?? 0); attempt++) {
        try {
          check();
          if (step.kind === 'label') undefined;
          else if (step.kind === 'goto') {
            const count = (gotoCounts.get(step.id) ?? 0) + 1;
            if (count > Math.min(step.maxTimes ?? MAX_GOTO, MAX_GOTO)) throw new Error('goto 超过次数上限');
            gotoCounts.set(step.id, count);
            jump = { label: step.label };
          } else if (step.kind === 'if') jump = await block((await condition(step.cond)) ? step.then : (step.else ?? []));
          else if (step.kind === 'loop') {
            for (let n = 0; n < Math.min(step.maxIterations ?? 1000, step.repeat ?? 1000); n++) {
              check();
              if (step.while && !(await condition(step.while))) break;
              jump = await block(step.steps);
              if (jump) break;
            }
          } else await action(step);
          check();
          succeeded = true;
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof ExecutionGuardError) throw error;
          if (attempt < (step.retry ?? 0)) { options.onLog?.('warn', `步骤 ${step.id} 重试：${String(error)}`, step.id); await pause(step.retryDelayMs ?? 800); continue; }
          if (step.onFail?.kind === 'continue') { options.onLog?.('warn', `跳过失败步骤 ${step.id}：${String(error)}`, step.id); succeeded = true; break; }
          if (step.onFail?.kind === 'goto') { jump = { label: step.onFail.label }; succeeded = true; break; }
          if (step.onFail?.kind === 'restartApp') {
            if (++restarts > MAX_RESTARTS) throw new Error('应用重启次数超过安全上限');
            await assertOwnership();
            await device.stopApp(script.packageName!);
            await assertOwnership();
            await device.startApp(script.packageName!);
            jump = { label: '__restart__' };
            succeeded = true;
            break;
          }
          throw new Error(`步骤 ${step.id} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!succeeded) throw new Error(`步骤 ${step.id} 未完成`);
      if (step.capture) {
        await assertForeground();
        const png = await device.screencapPng();
        await assertForeground();
        await options.onScreenshot?.(step.id, png);
      }
      if (step.afterDelayMs) await pause(step.afterDelayMs);
      if (jump) {
        const target = labels.get(jump.label);
        if (target !== undefined) { i = target; continue; }
        return jump;
      }
    }
    return null;
  };
  for (;;) {
    const jump = await block(script.steps);
    if (jump?.label === '__restart__') continue;
    if (jump) throw new Error(`goto 目标 ${jump.label} 不在可见作用域`);
    return { executed };
  }
}
