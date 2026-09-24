/** Pure helpers of the settings forms (tested without a DOM). */
import { APP_SETTINGS_KEYS, appSettingProblem, type AppSettings } from '../../../shared/app-settings';

/** Chinese problems of a draft, one per invalid field (empty when it can be saved). */
export function appSettingsProblems(draft: AppSettings): string[] {
  return APP_SETTINGS_KEYS.map((key) => appSettingProblem(key, draft[key])).filter((problem): problem is string => problem !== null);
}

/** Fields that differ from the saved settings (only these are sent, so a concurrent change elsewhere survives). */
export function appSettingsPatch(saved: AppSettings, draft: AppSettings): Partial<AppSettings> {
  const patch: Record<string, unknown> = {};
  for (const key of APP_SETTINGS_KEYS) if (!Object.is(saved[key], draft[key])) patch[key] = draft[key];
  return patch as Partial<AppSettings>;
}

/** A number input's value: an empty or partial entry becomes NaN, which the problem list then reports. */
export function numberInput(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

/** The emulator settings the assistant may edit; they are shared with the desktop manager and the CLI. */
export interface EmulatorSettingsDraft {
  maxRunning: number;
  healthIntervalSec: number;
  bootTimeoutSec: number;
}

export const EMULATOR_SETTINGS_RANGE = {
  maxRunning: { min: 1, max: 64 },
  healthIntervalSec: { min: 1, max: 60 },
  bootTimeoutSec: { min: 30, max: 1800 },
} as const;

export function emulatorSettingsProblems(draft: EmulatorSettingsDraft): string[] {
  const problems: string[] = [];
  const check = (key: keyof EmulatorSettingsDraft, label: string, unit: string) => {
    const value = draft[key];
    const range = EMULATOR_SETTINGS_RANGE[key];
    if (!Number.isInteger(value) || value < range.min || value > range.max) problems.push(`${label}必须是 ${range.min} 到 ${range.max}${unit}的整数`);
  };
  check('maxRunning', '同时运行实例上限', ' 个');
  check('healthIntervalSec', '实例状态轮询间隔', ' 秒');
  check('bootTimeoutSec', '开机等待上限', ' 秒');
  return problems;
}
