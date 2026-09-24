/**
 * The app settings' default trace-shot policy (DECISIONS C): `<AVDM_HOME>/automation/app-settings.json`, field
 * `shotPolicy`, the one setting that also governs gather failure scenes and alert evidence. The settings service
 * owns writing that file; this reader only looks up the default for script runs that did not choose a policy.
 *
 * Read per run and tolerant like the settings loader: a missing, oversized, broken or invalid file means the
 * default 「仅失败时留痕」. Once the settings service is wired into the composition root, its in-memory value
 * (`() => appSettings.get().shotPolicy`) can replace this reader; both read the same file.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SHOT_POLICIES, type ShotPolicy } from '@avdm/automation/script';

export const DEFAULT_SHOT_POLICY: ShotPolicy = 'onFail';
/** The settings file is a few hundred bytes; anything much larger is not ours to parse. */
const MAX_SETTINGS_BYTES = 64 * 1024;

export function appSettingsFile(home: string): string {
  return path.join(home, 'automation', 'app-settings.json');
}

export async function readAppShotPolicy(home: string): Promise<ShotPolicy> {
  try {
    const file = appSettingsFile(home);
    if ((await stat(file)).size > MAX_SETTINGS_BYTES) return DEFAULT_SHOT_POLICY;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const value = parsed !== null && typeof parsed === 'object' ? (parsed as { shotPolicy?: unknown }).shotPolicy : undefined;
    return SHOT_POLICIES.includes(value as ShotPolicy) ? value as ShotPolicy : DEFAULT_SHOT_POLICY;
  } catch {
    return DEFAULT_SHOT_POLICY;
  }
}
