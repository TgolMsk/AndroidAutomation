import os from 'node:os';
import path from 'node:path';
import { AvdmError } from '@avdm/core';
import type { InstanceSpec, Settings } from '@avdm/core';
import type { Command } from 'commander';
import { c, okMark } from '../ui/colors.js';
import { renderTable } from '../ui/table.js';
import type { Column } from '../ui/table.js';
import { out, printJson, withManager } from '../runtime.js';
import { parseSettingValue } from '../util/parse.js';

/**
 * `avdm settings [get [key] | set <key> <value>]`.
 * Manager methods: getSettings, updateSettings (validates), paths.settingsFile.
 */

const DESCRIPTIONS: Record<string, string> = {
  sdkRoot: 'Android SDK 路径',
  defaultImage: '新建实例的默认系统镜像',
  defaultSpec: '新建实例的默认规格',
  'defaultSpec.cpuCores': 'CPU 核数',
  'defaultSpec.ramMb': '内存（MB）',
  'defaultSpec.width': '屏幕宽（像素）',
  'defaultSpec.height': '屏幕高（像素）',
  'defaultSpec.dpi': '屏幕密度',
  'defaultSpec.dataPartitionGb': '数据分区（GB）',
  'defaultSpec.gpuMode': 'GPU 模式 host|software|auto',
  'defaultSpec.glDriver': 'GLES 驱动 angle|translator',
  'defaultSpec.headless': '无窗口运行',
  'defaultSpec.bootMode': '启动方式 quick|cold',
  'defaultSpec.extraArgs': '该规格附加的模拟器参数',
  maxRunning: '最多同时运行的实例数',
  memoryReserveMb: '为 macOS 保留的内存（MB）',
  bootTimeoutSec: '开机超时（秒）',
  healthIntervalSec: '健康检查间隔（秒）',
  proxy: '模拟器网络代理：direct | inherit | host:port',
  emulatorExtraArgs: '所有实例附加的模拟器参数',
  scrcpyPath: 'scrcpy 路径（空 = 自动查找）',
};

const PATH_KEYS = new Set(['sdkRoot', 'scrcpyPath']);

/** Flatten settings into [key, value] rows, expanding defaultSpec.* */
function flatten(settings: Settings): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(settings)) {
    if (k === 'defaultSpec' && v && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v as InstanceSpec)) rows.push([`defaultSpec.${sk}`, sv]);
    } else {
      rows.push([k, v]);
    }
  }
  return rows;
}

function display(v: unknown): string {
  if (typeof v === 'string') return v === '' ? '""' : v;
  return JSON.stringify(v);
}

function lookup(settings: Settings, key: string): { found: boolean; value: unknown } {
  const parts = key.split('.');
  let cur: unknown = settings;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, part)) {
      return { found: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return { found: true, value: cur };
}

function unknownKey(key: string, settings: Settings): AvdmError {
  const keys = flatten(settings).map(([k]) => k);
  return new AvdmError('INVALID_ARGUMENT', `未知设置项 "${key}"。可用: ${keys.join(', ')}`);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Coerce the parsed value to the type of the current setting (with a Chinese error when impossible). */
export function coerceSettingValue(key: string, current: unknown, raw: string): unknown {
  const parsed = parseSettingValue(raw);
  if (typeof current === 'string') {
    const s = typeof parsed === 'string' ? parsed : raw;
    return PATH_KEYS.has(key.split('.').pop()!) ? expandHome(s) : s;
  }
  if (typeof current === 'number') {
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) throw new AvdmError('INVALID_ARGUMENT', `${key} 需为数字（收到 ${raw}）`);
    return parsed;
  }
  if (typeof current === 'boolean') {
    if (typeof parsed === 'boolean') return parsed;
    const t = raw.trim().toLowerCase();
    if (['yes', 'on', '1', '是'].includes(t)) return true;
    if (['no', 'off', '0', '否'].includes(t)) return false;
    throw new AvdmError('INVALID_ARGUMENT', `${key} 需为 true 或 false（收到 ${raw}）`);
  }
  if (Array.isArray(current)) {
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new AvdmError('INVALID_ARGUMENT', `${key} 需为字符串 JSON 数组，例如 '["-no-audio"]'（收到 ${raw}）`);
    }
    return parsed;
  }
  if (current && typeof current === 'object') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AvdmError('INVALID_ARGUMENT', `${key} 需为 JSON 对象（收到 ${raw}）`);
    }
    return parsed;
  }
  return parsed;
}

/** Build the patch passed to manager.updateSettings for `key = value`. */
export function buildSettingsPatch(settings: Settings, key: string, raw: string): Partial<Settings> {
  const { found, value: current } = lookup(settings, key);
  const parts = key.split('.');
  if (!found || parts.length > 2 || (parts.length === 2 && parts[0] !== 'defaultSpec')) throw unknownKey(key, settings);
  const value = coerceSettingValue(key, current, raw);
  if (parts.length === 2) {
    return { defaultSpec: { ...settings.defaultSpec, [parts[1]!]: value } as InstanceSpec };
  }
  if (key === 'defaultSpec') {
    return { defaultSpec: { ...settings.defaultSpec, ...(value as Partial<InstanceSpec>) } };
  }
  return { [key]: value } as Partial<Settings>;
}

export function registerSettingsCommands(program: Command): void {
  const settings = program.command('settings').description('查看或修改设置：get [key] | set <key> <value>');

  settings
    .command('get [key]', { isDefault: true })
    .description('查看设置（可用 defaultSpec.ramMb 形式访问子项）')
    .option('--json', '输出 JSON')
    .action(async (key: string | undefined, opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const current = ctx.manager.getSettings();
        if (key) {
          const { found, value } = lookup(current, key);
          if (!found) throw unknownKey(key, current);
          if (ctx.json) printJson(value);
          else out(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
          return;
        }
        if (ctx.json) {
          printJson(current);
          return;
        }
        const p = c();
        const cols: Array<Column<[string, unknown]>> = [
          { header: '键', get: ([k]) => k },
          { header: '值', get: ([, v]) => display(v), maxWidth: 60, style: (t) => p.cyan(t) },
          { header: '说明', get: ([k]) => DESCRIPTIONS[k] ?? '', style: (t) => p.gray(t) },
        ];
        out(renderTable(flatten(current), cols, { headerStyle: p.bold }));
        out(p.gray(`设置文件: ${ctx.manager.paths.settingsFile}；修改: avdm settings set <键> <值>`));
      });
    });

  settings
    .command('set <key> <value>')
    .description('修改设置；值按 JSON 解析（数字/布尔/数组），解析失败则作为字符串')
    .option('--json', '输出 JSON')
    .action(async (key: string, raw: string, opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const patch = buildSettingsPatch(ctx.manager.getSettings(), key, raw);
        const next = await ctx.manager.updateSettings(patch);
        const { value } = lookup(next, key);
        if (ctx.json) {
          printJson(next);
          return;
        }
        out(`${okMark()} ${key} = ${c().cyan(display(value))}`);
      });
    });
}
