import type { AccountPlan, PlanConfig, ScriptDef } from './types';

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
    next.loop = false;
    warnings.push('旧版无限循环已改为单轮。请在任务计划中设置间隔触发，避免无上限占用实例。');
  }
  return { script: next, warnings };
}

export function legacyPlanChoices(raw: unknown): Array<{ accountId: string; tasks: number }> {
  if (!record(raw) || !Array.isArray(raw.plans)) throw new Error('旧计划文件应包含 plans 数组');
  return raw.plans.filter(record).filter((item) => typeof item.accountId === 'string')
    .map((item) => ({ accountId: item.accountId as string, tasks: Array.isArray(item.tasks) ? item.tasks.length : 0 }));
}

/** Keep compatible timing knobs but require an explicit enable in the new Assistant. */
export function convertLegacyConfig(raw: unknown): Partial<PlanConfig> {
  if (!record(raw) || !record(raw.config)) return { enabled: false };
  const old = raw.config;
  const patch: Partial<PlanConfig> = { enabled: false };
  const ranges = { catchUpMs: [0, 12 * 3_600_000], queueWaitMs: [60_000, 12 * 3_600_000],
    retry: [0, 5], retryDelayMs: [0, 30 * 60_000] } as const;
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const value = old[key];
    const [min, max] = ranges[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) patch[key] = value;
  }
  return patch;
}

/** Account IDs and run counters are intentionally not reused across products. */
export function convertLegacyAccountPlan(raw: unknown, oldAccountId: string, newAccountId: string): { plan: AccountPlan; warnings: string[] } {
  if (!record(raw) || !Array.isArray(raw.plans)) throw new Error('旧计划文件应包含 plans 数组');
  const old = raw.plans.find((item: unknown) => record(item) && item.accountId === oldAccountId);
  if (!record(old) || !Array.isArray(old.tasks)) throw new Error('找不到所选旧账号计划');
  const warnings = ['已映射到当前账号；自动计划默认关闭，旧运行次数和触发记账不导入。旧版抢占采集与 AI 自动介入配置不迁移。请核对后再启用。'];
  const tasks = old.tasks.map((rawTask: unknown) => {
    if (!record(rawTask)) throw new Error('旧计划存在无效任务');
    if (rawTask.maxRunMinutes === 0) {
      warnings.push(`任务 ${String(rawTask.id)} 的无限运行时长已限制为 120 分钟。`);
    }
    return { ...rawTask, maxRunMinutes: rawTask.maxRunMinutes === 0 ? 120 : rawTask.maxRunMinutes };
  });
  const plan = { accountId: newAccountId, enabled: false, tasks, updatedAt: 0 } as AccountPlan;
  return { plan, warnings };
}
