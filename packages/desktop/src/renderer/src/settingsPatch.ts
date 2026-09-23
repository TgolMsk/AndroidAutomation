import type { InstanceSpec, Settings } from '@avdm/core';
import type { SettingsPatch } from '../../shared/ipc';

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Only what the user changed relative to the snapshot the dialog was opened with. Core merges the patch
 * over settings.json (defaultSpec field by field), so keys changed meanwhile by someone else — e.g.
 * `avdm settings set maxRunning 12` while the dialog is open — are kept instead of being written back.
 */
export function settingsPatch(base: Settings, next: Settings): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (key === 'defaultSpec') continue;
    if (!same(base[key], next[key])) patch[key] = next[key];
  }
  const spec: Partial<Record<keyof InstanceSpec, unknown>> = {};
  for (const key of Object.keys(next.defaultSpec) as (keyof InstanceSpec)[]) {
    if (!same(base.defaultSpec?.[key], next.defaultSpec[key])) spec[key] = next.defaultSpec[key];
  }
  if (Object.keys(spec).length > 0) patch['defaultSpec'] = spec;
  return patch as SettingsPatch;
}
