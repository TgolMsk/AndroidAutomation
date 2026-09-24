import { normalizeScriptParamSet, type LegacyAccountRow } from './store';
import { GATHER_PARAM_SCOPE, type LegacyAccountPreview, type ScriptParams } from './types';

const SCRIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const MAX_LEGACY_ACCOUNTS = 512;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\0\r\n]+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Old script id → id the legacy script importer saved it under (ids that collided get a new one). Validated up
 * front: a bad map is a caller bug, not something to half-apply.
 */
export function checkScriptIdMap(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!record(value) || Object.keys(value).length > 4096) throw new Error('脚本编号对照表无效');
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(value)) {
    if (!SCRIPT_ID_RE.test(from) || typeof to !== 'string' || !SCRIPT_ID_RE.test(to)) throw new Error('脚本编号对照表无效');
    out[from] = to;
  }
  return out;
}

function mapScriptId(id: string, map: Record<string, string>): string {
  return Object.hasOwn(map, id) ? map[id]! : id;
}

function legacyParams(value: unknown, map: Record<string, string>): ScriptParams | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('invalid');
  const out: ScriptParams = {};
  const mappedKey = new Map<string, boolean>();
  for (const [id, params] of Object.entries(value)) {
    if (!SCRIPT_ID_RE.test(id)) throw new Error('invalid');
    // The gather namespace is not a script id and never follows the script map.
    const key = id === GATHER_PARAM_SCOPE ? id : mapScriptId(id, map);
    const mapped = key !== id;
    // Two old keys landing on one id: the renamed script wins over an old id that happens to equal its new id.
    if (mappedKey.has(key) && (mappedKey.get(key) || !mapped)) continue;
    out[key] = normalizeScriptParamSet(params);
    mappedKey.set(key, mapped);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Preview a wanlong-panel `accounts/accounts.json` ({version:1, accounts:[{id:'acc_…', name, packageName?,
 * instanceIndex, note?, defaultScriptId?, scriptParams?, enabled, setup?}]}). Only names, notes, the default
 * script and script parameters are carried over: MuMu instance indices do not map to AVDs and the old login
 * check proves nothing about a new device, so every imported account starts unbound, 「待登录」 and disabled.
 * With `scriptIdMap` (from importing the old scripts first), the default script and the parameter keys follow
 * the ids the scripts were saved under.
 */
export function previewLegacyAccounts(
  raw: unknown, packageName: string, scriptIdMap?: Record<string, string>,
): { entries: LegacyAccountPreview[]; rows: LegacyAccountRow[] } {
  const map = checkScriptIdMap(scriptIdMap);
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
      row.defaultScriptId = entry.defaultScriptId = mapScriptId(item.defaultScriptId, map);
    }
    try {
      const params = legacyParams(item.scriptParams, map);
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
