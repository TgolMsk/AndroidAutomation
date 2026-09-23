import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { Rect, TemplateDefinition, TemplateSet } from './contracts.js';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const MAX_TEMPLATES = 1_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.png$/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} 无效`);
  return value;
}

function positiveInteger(value: unknown, label: string, max = 16_384): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`${label} 无效`);
  return value as number;
}

function rect(value: unknown, label: string): Rect {
  const data = object(value, label);
  const result = { x: data.x, y: data.y, w: data.w, h: data.h };
  if (Object.values(result).some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
      (result.w as number) <= 0 || (result.h as number) <= 0) throw new Error(`${label} 无效`);
  return result as Rect;
}

function definition(value: unknown): TemplateDefinition {
  const data = object(value, '模板定义');
  const id = string(data.id, '模板 id', 128);
  const file = string(data.file, `模板 ${id} 文件名`, 132);
  if (!SAFE_ID.test(id) || !SAFE_FILE.test(file) || basename(file) !== file) {
    throw new Error(`模板 ${id} 的 id 或文件名不安全`);
  }
  const threshold = data.threshold === undefined ? undefined : Number(data.threshold);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new Error(`模板 ${id} 阈值无效`);
  }
  return {
    id,
    name: string(data.name, `模板 ${id} 名称`),
    file,
    authoredWidth: positiveInteger(data.authoredWidth, `模板 ${id} 原画面宽度`),
    authoredHeight: positiveInteger(data.authoredHeight, `模板 ${id} 原画面高度`),
    bounds: rect(data.bounds, `模板 ${id} 裁剪范围`),
    defaultRoi: data.defaultRoi == null ? undefined : rect(data.defaultRoi, `模板 ${id} 搜索范围`),
    threshold,
    tags: Array.isArray(data.tags) ? data.tags.filter((x): x is string => typeof x === 'string') : undefined,
  };
}

/** Read only a caller-selected manifest. Nothing is searched under the repository or app bundle. */
export async function loadTemplateSet(directory: string): Promise<TemplateSet> {
  const root = await realpath(directory);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error('模板集路径必须是目录');
  const file = join(root, 'manifest.json');
  const fileStat = await lstat(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('模板清单不是常规文件，或超过 2 MiB');
  }
  const data = object(JSON.parse(await readFile(file, 'utf8')) as unknown, '模板清单');
  const id = string(data.id, '模板集 id', 128);
  if (!SAFE_ID.test(id)) throw new Error('模板集 id 不安全');
  if (!Array.isArray(data.templates) || data.templates.length > MAX_TEMPLATES) {
    throw new Error(`模板集应包含不超过 ${MAX_TEMPLATES} 张模板`);
  }
  const templates = data.templates.map(definition);
  if (new Set(templates.map((item) => item.id)).size !== templates.length) throw new Error('模板 id 重复');
  return {
    id,
    name: string(data.name, '模板集名称'),
    packageName: data.packageName == null ? undefined : string(data.packageName, '游戏包名'),
    refWidth: positiveInteger(data.refWidth, '参考画面宽度'),
    refHeight: positiveInteger(data.refHeight, '参考画面高度'),
    templates,
    directory: root,
  };
}

/** Read a PNG named by the validated manifest, rejecting symlinks and path escapes. */
export async function readTemplatePng(set: TemplateSet, id: string): Promise<Uint8Array> {
  const item = set.templates.find((entry) => entry.id === id);
  if (!item) throw new Error(`模板集 ${set.id} 中没有模板 ${id}`);
  const file = join(set.directory, item.file);
  const fileStat = await lstat(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_TEMPLATE_BYTES) {
    throw new Error(`模板 ${id} 不是常规 PNG 文件，或超过 10 MiB`);
  }
  const resolved = await realpath(file);
  if (!resolved.startsWith(set.directory + sep)) throw new Error(`模板 ${id} 路径越界`);
  const bytes = await readFile(resolved);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`模板 ${id} 不是 PNG 文件`);
  return bytes;
}
