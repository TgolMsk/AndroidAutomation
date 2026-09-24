import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { Rect, TemplateDefinition, TemplateSet } from './contracts.js';
import { AppError } from './errors.js';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const MAX_TEMPLATES = 1_000;
const MAX_NOTE = 2_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Template and set ids: path segments, so no separators, no leading dot. */
export const SAFE_TEMPLATE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_FILE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.png$/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_ARGUMENT', `${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('INVALID_ARGUMENT', `${label} 无效`);
  return value;
}

function positiveInteger(value: unknown, label: string, max = 16_384): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new AppError('INVALID_ARGUMENT', `${label} 无效`);
  return value as number;
}

function rect(value: unknown, label: string): Rect {
  const data = object(value, label);
  const result = { x: data.x, y: data.y, w: data.w, h: data.h };
  if (Object.values(result).some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
      (result.w as number) <= 0 || (result.h as number) <= 0) throw new AppError('INVALID_ARGUMENT', `${label} 无效`);
  return result as Rect;
}

/** Optional metadata is informational: a bad value is dropped instead of failing the whole set. */
function finiteOrUndefined(value: unknown, min = -Infinity, max = Infinity): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Validate one manifest entry (safe id and file name, sizes, rects) and keep the optional metadata the template page
 * shows: std, maskCoverage, note, createdAt, updatedAt.
 */
export function parseTemplateDefinition(value: unknown): TemplateDefinition {
  const data = object(value, '模板定义');
  const id = string(data.id, '模板 id', 128);
  const file = string(data.file, `模板 ${id} 文件名`, 132);
  if (!SAFE_TEMPLATE_ID.test(id) || !SAFE_FILE.test(file) || basename(file) !== file) {
    throw new AppError('INVALID_ARGUMENT', `模板 ${id} 的 id 或文件名不安全`);
  }
  const threshold = data.threshold == null ? undefined : Number(data.threshold);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new AppError('INVALID_ARGUMENT', `模板 ${id} 阈值无效`);
  }
  const std = finiteOrUndefined(data.std, 0);
  const maskCoverage = finiteOrUndefined(data.maskCoverage, 0, 1);
  const createdAt = finiteOrUndefined(data.createdAt, 0);
  const updatedAt = finiteOrUndefined(data.updatedAt, 0);
  const note = typeof data.note === 'string' && data.note.trim() ? data.note.slice(0, MAX_NOTE) : undefined;
  const tags = Array.isArray(data.tags) ? data.tags.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    id,
    name: string(data.name, `模板 ${id} 名称`),
    file,
    authoredWidth: positiveInteger(data.authoredWidth, `模板 ${id} 原画面宽度`),
    authoredHeight: positiveInteger(data.authoredHeight, `模板 ${id} 原画面高度`),
    bounds: rect(data.bounds, `模板 ${id} 裁剪范围`),
    defaultRoi: data.defaultRoi == null ? undefined : rect(data.defaultRoi, `模板 ${id} 搜索范围`),
    threshold,
    tags,
    ...(std !== undefined ? { std } : {}),
    ...(maskCoverage !== undefined ? { maskCoverage } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** Set-level manifest fields (everything except the template list). */
export function parseTemplateSetHeader(value: unknown): Omit<TemplateSet, 'templates' | 'directory'> & { templates: unknown[] } {
  const data = object(value, '模板清单');
  const id = string(data.id, '模板集 id', 128);
  if (!SAFE_TEMPLATE_ID.test(id)) throw new AppError('INVALID_ARGUMENT', '模板集 id 不安全');
  if (!Array.isArray(data.templates) || data.templates.length > MAX_TEMPLATES) {
    throw new AppError('INVALID_ARGUMENT', `模板集应包含不超过 ${MAX_TEMPLATES} 张模板`);
  }
  const updatedAt = finiteOrUndefined(data.updatedAt, 0);
  return {
    id,
    name: string(data.name, '模板集名称'),
    packageName: data.packageName == null ? undefined : string(data.packageName, '游戏包名'),
    refWidth: positiveInteger(data.refWidth, '参考画面宽度'),
    refHeight: positiveInteger(data.refHeight, '参考画面高度'),
    templates: data.templates,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/** Read only a caller-selected manifest. Nothing is searched under the repository or app bundle. */
export async function loadTemplateSet(directory: string): Promise<TemplateSet> {
  let root: string;
  try { root = await realpath(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', `模板集目录不存在：${directory}`);
    throw new AppError('IO_ERROR', `无法访问模板集目录：${directory}`);
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new AppError('INVALID_ARGUMENT', '模板集路径必须是目录');
  const file = join(root, 'manifest.json');
  let fileStat;
  try { fileStat = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', `模板集不存在（缺少 manifest.json）：${root}`);
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_MANIFEST_BYTES) {
    throw new AppError('IO_ERROR', '模板清单不是常规文件，或超过 2 MiB');
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch { throw new AppError('IO_ERROR', `模板集的 manifest.json 不是合法 JSON：${root}`); }
  const header = parseTemplateSetHeader(raw);
  const templates = header.templates.map(parseTemplateDefinition);
  if (new Set(templates.map((item) => item.id)).size !== templates.length) throw new AppError('INVALID_ARGUMENT', '模板 id 重复');
  return { ...header, templates, directory: root };
}

/** Read a PNG named by the validated manifest, rejecting symlinks and path escapes. */
export async function readTemplatePng(set: TemplateSet, id: string): Promise<Uint8Array> {
  const item = set.templates.find((entry) => entry.id === id);
  if (!item) throw new AppError('TEMPLATE_NOT_FOUND', `模板集「${set.name}」里没有 id 为 ${id} 的模板`, { templateId: id });
  const file = join(set.directory, item.file);
  let fileStat;
  try { fileStat = await lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('TEMPLATE_NOT_FOUND', `模板「${item.name}」的图片文件丢失：${item.file}（manifest 里还有记录，建议重新截取）`,
        { templateId: id });
    }
    throw new AppError('IO_ERROR', `读取模板「${item.name}」图片失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_TEMPLATE_BYTES) {
    throw new AppError('IO_ERROR', `模板 ${id} 不是常规 PNG 文件，或超过 10 MiB`);
  }
  const resolved = await realpath(file);
  if (!resolved.startsWith(set.directory + sep)) throw new AppError('INVALID_ARGUMENT', `模板 ${id} 路径越界`);
  const bytes = await readFile(resolved);
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new AppError('TEMPLATE_DECODE_FAILED', `模板 ${id} 不是 PNG 文件`);
  return bytes;
}
