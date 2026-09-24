import { makeTaskId, mergePlanConfig, defaultPlanConfig, sanitizePlan } from '../../shared/plan';
import type { AccountPlan, PlanConfig, ScriptDef } from './types';

/**
 * Explicit, UI-driven import of wanlong-panel scripts and plans. Pure (no Node imports): the renderer imports it.
 * Imported automation always starts disabled; run counters and trigger bookkeeping are not imported.
 */

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Converts one old script document without executing it or importing source data automatically. */
export function convertLegacyScript(raw: unknown, expectedPackage: string): { script: ScriptDef; warnings: string[] } {
  if (!record(raw)) throw new Error('旧脚本文件必须是 JSON 对象');
  const warnings: string[] = [];
  if (raw.packageName && raw.packageName !== expectedPackage) {
    throw new Error(`旧脚本面向 ${raw.packageName}，当前游戏是 ${expectedPackage}`);
  }
  const next = { ...raw, packageName: expectedPackage } as unknown as ScriptDef;
  if (next.loop) {
    // Script-level loop mode is supported again; it only needs a sane gap between rounds.
    if (typeof next.loopIntervalMs !== 'number' || next.loopIntervalMs < 1000) {
      next.loopIntervalMs = 3000;
      warnings.push('旧版循环脚本的每轮间隔小于 1 秒，已改为 3 秒。');
    }
    warnings.push('这是循环模式脚本：会一直运行到手动停止或达到任务的运行时长上限。');
  }
  return { script: next, warnings };
}

export function legacyPlanChoices(raw: unknown): Array<{ accountId: string; tasks: number }> {
  if (!record(raw) || !Array.isArray(raw.plans)) throw new Error('旧计划文件应包含 plans 数组');
  return raw.plans.filter(record).filter((item) => typeof item.accountId === 'string')
    .map((item) => ({ accountId: item.accountId as string, tasks: Array.isArray(item.tasks) ? item.tasks.length : 0 }));
}

const CONFIG_FIELDS = ['preemptGraceMs', 'catchUpMs', 'queueWaitMs', 'retry', 'retryDelayMs', 'aiAssist'] as const;

/**
 * The legacy config's knobs (clamped into today's ranges like the original `mergePlanConfig`), always with the
 * total switch off: the user turns plans on after checking them. Only fields present in the old file are returned.
 */
export function convertLegacyConfig(raw: unknown): Partial<PlanConfig> {
  if (!record(raw) || !record(raw.config)) return { enabled: false };
  const old = raw.config;
  const merged = mergePlanConfig(defaultPlanConfig(), old);
  const patch: Partial<PlanConfig> = { enabled: false };
  for (const key of CONFIG_FIELDS) {
    const value = old[key];
    if (key === 'aiAssist' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value)) {
      (patch as Record<string, unknown>)[key] = merged[key];
    }
  }
  return patch;
}

/**
 * One legacy account plan mapped onto `newAccountId`, sanitized with the original loader's rules: an invalid daily
 * trigger becomes 「仅手动」, intervals / priorities / time limits are clamped (0–720 minutes, 0 = unlimited), bad
 * windows and params are dropped. Tasks whose id does not fit today's rules get a fresh one. Account ids and run
 * counters are intentionally not reused across products; the plan is imported disabled.
 */
export function convertLegacyAccountPlan(
  raw: unknown, oldAccountId: string, newAccountId: string, newId: () => string = () => makeTaskId(),
): { plan: AccountPlan; warnings: string[] } {
  if (!record(raw) || !Array.isArray(raw.plans)) throw new Error('旧计划文件应包含 plans 数组');
  const old = raw.plans.find((item: unknown) => record(item) && item.accountId === oldAccountId);
  if (!record(old) || !Array.isArray(old.tasks)) throw new Error('找不到所选旧账号计划');
  const warnings = ['已映射到当前账号；账号计划默认关闭，旧运行次数和触发记账不导入。请核对后再启用。'];
  const sanitized = sanitizePlan({ ...old, accountId: newAccountId }, (message) => warnings.push(message), { newId });
  if (!sanitized) throw new Error('找不到所选旧账号计划');
  const plan: AccountPlan = { accountId: newAccountId, enabled: false, tasks: sanitized.tasks, updatedAt: 0 };
  return { plan, warnings };
}
