import { normalizeScriptParamSet, type LegacyAccountRow } from './store';
import type { LegacyAccountPreview, ScriptParams } from './types';

const SCRIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const MAX_LEGACY_ACCOUNTS = 512;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\0\r\n]+/g, ' ').trim().slice(0, max) : '';
}

function legacyParams(value: unknown): ScriptParams | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('invalid');
  const out: ScriptParams = {};
  for (const [id, params] of Object.entries(value)) {
    if (!SCRIPT_ID_RE.test(id)) throw new Error('invalid');
    out[id] = normalizeScriptParamSet(params);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Preview a wanlong-panel `accounts/accounts.json` ({version:1, accounts:[{id:'acc_…', name, packageName?,
 * instanceIndex, note?, defaultScriptId?, scriptParams?, enabled, setup?}]}). Only names, notes, the default
 * script and script parameters are carried over: MuMu instance indices do not map to AVDs and the old login
 * check proves nothing about a new device, so every imported account starts unbound, 「待登录」 and disabled.
 */
export function previewLegacyAccounts(raw: unknown, packageName: string): { entries: LegacyAccountPreview[]; rows: LegacyAccountRow[] } {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.accounts)) {
    throw new Error('不是旧版万龙面板的账号文件（accounts.json，version 1）');
  }
  if (raw.accounts.length > MAX_LEGACY_ACCOUNTS) throw new Error(`旧账号文件超过 ${MAX_LEGACY_ACCOUNTS} 个账号，未导入`);
  const entries: LegacyAccountPreview[] = [];
  const rows: LegacyAccountRow[] = [];
  const seen = new Set<string>();
  for (const item of raw.accounts) {
    const oldId = record(item) && typeof item.id === 'string' ? item.id.slice(0, 120) : '';
    const name = record(item) ? oneLine(item.name, 100) : '';
    const note = record(item) ? oneLine(item.note, 1000) : '';
    const entry: LegacyAccountPreview = { oldId, name, note, importable: false, scriptParamCount: 0 };
    entries.push(entry);
    if (!record(item) || !oldId || !name) { entry.reason = '缺少账号编号或名称'; continue; }
    if (seen.has(oldId)) { entry.reason = '账号编号重复'; continue; }
    seen.add(oldId);
    if (typeof item.packageName === 'string' && item.packageName.trim() && item.packageName.trim() !== packageName) {
      entry.reason = `属于其他游戏（${oneLine(item.packageName, 80)}）`;
      continue;
    }
    const row: LegacyAccountRow = { oldId, details: { name, note } };
    if (typeof item.defaultScriptId === 'string' && SCRIPT_ID_RE.test(item.defaultScriptId)) {
      row.defaultScriptId = entry.defaultScriptId = item.defaultScriptId;
    }
    try {
      const params = legacyParams(item.scriptParams);
      if (params) {
        row.scriptParams = params;
        entry.scriptParamCount = Object.keys(params).length;
      }
    } catch {
      entry.reason = '脚本参数格式不兼容，已忽略（账号本身会导入）';
    }
    entry.importable = true;
    rows.push(row);
  }
  return { entries, rows };
}
