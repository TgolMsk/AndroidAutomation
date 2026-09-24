import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AppPathEntry, AppPathKey, AppTemplateSetEntry } from '../../shared/ipc';

interface PathSpec {
  key: AppPathKey;
  label: string;
  kind: 'dir' | 'file';
  description: string;
  /** Segments below AVDM_HOME; `{game}` is replaced with the game id. */
  segments: readonly string[];
  /** Nothing writes here yet: shown next to the entry so an empty folder is not mistaken for a fault. */
  pending?: string;
}

/**
 * Where each assistant store keeps its data (the services' own constructor conventions; see
 * docs in `src/main/app/README.md`). The renderer only ever sends one of these keys, never a path.
 */
const PATH_SPECS: readonly PathSpec[] = [
  { key: 'home', label: '数据根目录', kind: 'dir', segments: [], description: 'AVDM_HOME，与多开管理器和命令行共用；要更换请设置 AVDM_HOME 环境变量后重启三个入口' },
  { key: 'automation', label: '助手数据', kind: 'dir', segments: ['automation'], description: '助手的全部数据都在这个目录下' },
  { key: 'appSettings', label: '应用设置', kind: 'file', segments: ['automation', 'app-settings.json'], description: '截图留痕策略、截图间隔等面板设置' },
  { key: 'logs', label: '运行日志', kind: 'dir', segments: ['automation', 'logs'], description: 'app.ndjson：警告与错误的持久记录（按大小轮换）' },
  { key: 'gatherSettings', label: '采集配置', kind: 'dir', segments: ['automation', '{game}'], description: '每个实例的模板集与采集配置' },
  { key: 'gatherState', label: '采集运行状态', kind: 'dir', segments: ['automation', '{game}', 'state'], description: '搜索等级记忆、放弃冷却等跨轮状态' },
  {
    key: 'gatherShots', label: '采集现场截图', kind: 'dir', segments: ['automation', '{game}', 'shots'],
    description: '采集失败时的现场截图（跟随截图留痕策略；保留 14 天、最多 300 张）',
  },
  { key: 'templates', label: '模板库', kind: 'dir', segments: ['automation', 'templates', '{game}'], description: '在助手里新建的模板集（各实例选用的模板集见下方列表）' },
  { key: 'scripts', label: '脚本库', kind: 'dir', segments: ['automation', 'games', '{game}', 'scripts'], description: '每个脚本一个 JSON 文件' },
  { key: 'plans', label: '任务计划', kind: 'file', segments: ['automation', 'games', '{game}', 'plans.json'], description: '计划表、运行记账与最近的执行记录' },
  { key: 'scriptRuns', label: '脚本执行记录', kind: 'dir', segments: ['automation', 'games', '{game}', 'runs'], description: '每次执行的事件日志与步骤截图' },
  { key: 'monitoringShots', label: '告警现场截图', kind: 'dir', segments: ['automation', 'monitoring', 'shots'], description: '掉线、卡死等告警的现场截图（保留 14 天）' },
  { key: 'accounts', label: '账号', kind: 'file', segments: ['automation', 'accounts.json'], description: '账号与实例绑定（不保存手机号与验证码）' },
  { key: 'insights', label: '数据统计与通知', kind: 'dir', segments: ['automation', 'insights'], description: '按北京日期分的统计日账与推送配置' },
  { key: 'advisor', label: 'AI 顾问', kind: 'file', segments: ['automation', 'advisor.json'], description: 'AI 顾问配置与处理记录' },
  { key: 'scheduler', label: '自动续跑', kind: 'dir', segments: ['automation', 'scheduler'], description: '每个实例的自动续跑开关与下次唤醒时间' },
  { key: 'leases', label: '设备租约', kind: 'dir', segments: ['run'], description: '跨进程的实例占用锁（助手正在操作某个实例时存在）' },
];

export const APP_PATH_KEYS: readonly AppPathKey[] = PATH_SPECS.map((spec) => spec.key);

export function isAppPathKey(value: unknown): value is AppPathKey {
  return typeof value === 'string' && (APP_PATH_KEYS as readonly string[]).includes(value);
}

/** Absolute location of one key for one game (pure). */
export function resolveAppPath(home: string, gameId: string, key: AppPathKey): { path: string; kind: 'dir' | 'file' } {
  const spec = PATH_SPECS.find((item) => item.key === key);
  if (!spec) throw new Error(`没有名为 ${key} 的数据目录`);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId)) throw new Error('游戏 ID无效');
  return { path: path.join(home, ...spec.segments.map((segment) => segment.replace('{game}', gameId))), kind: spec.kind };
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; }
  catch { return false; }
}

/** Every known location with whether it exists yet. */
export async function listAppPaths(home: string, gameId: string): Promise<AppPathEntry[]> {
  return Promise.all(PATH_SPECS.map(async (spec) => {
    const { path: target } = resolveAppPath(home, gameId, spec.key);
    return {
      key: spec.key, label: spec.label, path: target, kind: spec.kind, description: spec.description, exists: await exists(target),
      ...(spec.pending ? { pending: spec.pending } : {}),
    };
  }));
}

export interface TemplateSetPorts {
  /** Instances known to the manager. */
  instances(): Promise<Array<{ index: number; name: string }>>;
  /** Indices that have an assistant settings file for the game (a deleted instance may still have one). */
  configuredIndices(): Promise<number[]>;
  /** The configured template directory of an instance ('' when none). */
  templateDir(index: number): Promise<string>;
  /** Manifest name and template count of the instance's set (throws when unreadable). */
  describe(index: number): Promise<{ name: string; templates: number } | null>;
}

/**
 * Each instance's template set (they live wherever the user picked them, not under AVDM_HOME). One unreadable
 * instance becomes an entry with `error`, never a failed list.
 */
export async function listInstanceTemplateSets(ports: TemplateSetPorts): Promise<AppTemplateSetEntry[]> {
  const [instances, configured] = await Promise.all([ports.instances(), ports.configuredIndices().catch(() => [])]);
  const names = new Map(instances.map((instance) => [instance.index, instance.name]));
  const indices = [...new Set([...instances.map((instance) => instance.index), ...configured])].sort((a, b) => a - b);
  const entries = await Promise.all(indices.map(async (index): Promise<AppTemplateSetEntry | null> => {
    const instanceName = names.get(index) ?? null;
    let dir: string;
    try { dir = await ports.templateDir(index); }
    catch (error) {
      return { index, instanceName, path: '', exists: false, name: null, templates: null, error: messageOf(error) };
    }
    if (!dir) return null;
    const entry: AppTemplateSetEntry = { index, instanceName, path: dir, exists: await exists(dir), name: null, templates: null };
    try {
      const set = await ports.describe(index);
      if (set) { entry.name = set.name; entry.templates = set.templates; }
    } catch (error) {
      entry.error = messageOf(error);
    }
    return entry;
  }));
  return entries.filter((entry): entry is AppTemplateSetEntry => entry !== null);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

/** Settings files of one game (`automation/<game>/<index>.json`), for template sets of deleted instances. */
export async function configuredSettingsIndices(home: string, gameId: string): Promise<number[]> {
  const names = await readdir(path.join(home, 'automation', gameId)).catch(() => [] as string[]);
  return names.map((name) => /^(\d{1,2})\.json$/.exec(name)).filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1])).filter((index) => index <= 63);
}

export const MAX_COPY_CHARS = 4096;

/** Put `text` on the system clipboard (Electron's clipboard in main; a fake in tests). */
export async function copyText(text: unknown, writer?: { writeText(text: string): void }): Promise<void> {
  if (typeof text !== 'string' || !text || text.length > MAX_COPY_CHARS || text.includes('\0')) throw new Error('复制内容无效');
  const clipboard = writer ?? (await import('electron')).clipboard;
  clipboard.writeText(text);
}

/** Electron's shell, or a fake in tests. */
export interface PathOpener {
  openPath(target: string): Promise<string>;
  showItemInFolder(target: string): void;
}

async function electronOpener(): Promise<PathOpener> {
  const { shell } = await import('electron');
  return shell;
}

/**
 * Open a directory in Finder (created first, so a store that has not written yet still opens), or reveal a file.
 * Files are never opened directly: that could launch them. A missing file reveals its directory instead.
 */
export async function openAppPath(home: string, gameId: string, key: AppPathKey, opener?: PathOpener): Promise<void> {
  const { path: target, kind } = resolveAppPath(home, gameId, key);
  const shell = opener ?? await electronOpener();
  if (kind === 'file') {
    if (await exists(target)) { shell.showItemInFolder(target); return; }
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const failure = await shell.openPath(dir);
    if (failure) throw new Error(`无法打开目录 ${dir}：${failure}`);
    return;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  const failure = await shell.openPath(target);
  if (failure) throw new Error(`无法打开目录 ${target}：${failure}`);
}
