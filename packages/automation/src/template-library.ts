import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Rect, TemplateDefinition, TemplateSet } from './contracts.js';
import { loadTemplateSet, readTemplatePng } from './templates.js';
import { prepareTemplate } from './vision.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const GAME_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TEMPLATES = 1_000;

export interface TemplateDraft {
  id?: string;
  name: string;
  image: Uint8Array;
  authoredWidth: number;
  authoredHeight: number;
  /** Source-image coordinates, before reference-canvas normalization. */
  crop: Rect;
  /** Reference-canvas coordinates. */
  defaultRoi?: Rect;
  threshold?: number;
  tags?: string[];
  note?: string;
  /** Optional grayscale PNG mask, where 0 is ignored and 255 participates. */
  alpha?: Uint8Array;
}

export interface TemplateSaveResult {
  definition: TemplateDefinition;
  std: number;
  directory: string;
}

function asBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 8 || value.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`${label}为空或超过 32 MiB`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_384) throw new Error(`${label}无效`);
  return value;
}

function checkedRect(rect: Rect, width: number, height: number, label: string): Rect {
  const values = [rect?.x, rect?.y, rect?.w, rect?.h];
  if (!values.every((value) => Number.isSafeInteger(value)) || rect.x < 0 || rect.y < 0 ||
    rect.w < 3 || rect.h < 3 || rect.x + rect.w > width || rect.y + rect.h > height) {
    throw new Error(`${label}超出 ${width}×${height} 画面`);
  }
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function clampRoi(bounds: Rect, width: number, height: number): Rect {
  const marginX = Math.max(80, Math.round(bounds.w * 0.6));
  const marginY = Math.max(80, Math.round(bounds.h * 0.6));
  const x = Math.max(0, bounds.x - marginX);
  const y = Math.max(0, bounds.y - marginY);
  return {
    x, y,
    w: Math.min(width, bounds.x + bounds.w + marginX) - x,
    h: Math.min(height, bounds.y + bounds.h + marginY) - y,
  };
}

async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One writer per template directory; an atomic manifest remains the source of truth. */
export class TemplateLibrary {
  private readonly managedRoot: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error('AVDM home 必须是绝对路径');
    this.managedRoot = join(home, 'automation', 'templates');
  }

  async managedSets(gameId: string): Promise<TemplateSet[]> {
    if (!GAME_ID.test(gameId)) throw new Error('游戏包 ID 无效');
    const root = join(this.managedRoot, gameId);
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sets: TemplateSet[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { sets.push(await loadTemplateSet(join(root, entry.name))); }
      catch (error) { console.warn(`[avdm] 跳过损坏模板集 ${entry.name}:`, error); }
    }
    return sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async createSet(gameId: string, name: string, packageName: string, refWidth: number, refHeight: number): Promise<TemplateSet> {
    if (!GAME_ID.test(gameId)) throw new Error('游戏包 ID 无效');
    if (!name.trim() || name.trim().length > 100) throw new Error('模板集名称无效');
    if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new Error('游戏包名无效');
    positive(refWidth, '参考宽度');
    positive(refHeight, '参考高度');
    const id = `tset_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const directory = join(this.managedRoot, gameId, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(join(directory, 'manifest.json'), JSON.stringify({
      id, name: name.trim(), packageName, refWidth, refHeight, templates: [], updatedAt: Date.now(),
    }, null, 2) + '\n');
    return loadTemplateSet(directory);
  }

  load(directory: string): Promise<TemplateSet> { return loadTemplateSet(directory); }

  async image(directory: string, id: string): Promise<Uint8Array> {
    return readTemplatePng(await loadTemplateSet(directory), id);
  }

  async save(directory: string, input: TemplateDraft): Promise<TemplateSaveResult> {
    return this.withWrite(directory, async (root) => {
      const set = await loadTemplateSet(root);
      const image = asBytes(input.image, '模板原图');
      const meta = await sharp(image, { limitInputPixels: 100_000_000 }).metadata();
      const sourceWidth = positive(meta.width ?? 0, '原图宽度');
      const sourceHeight = positive(meta.height ?? 0, '原图高度');
      if (sourceWidth !== input.authoredWidth || sourceHeight !== input.authoredHeight) {
        throw new Error('原图尺寸已变化，请重新截图');
      }
      const crop = checkedRect(input.crop, sourceWidth, sourceHeight, '裁剪区域');
      const id = input.id?.trim() || `tpl_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      if (!SAFE_ID.test(id)) throw new Error('模板 ID 仅允许字母、数字、下划线、点和短横线');
      const name = input.name.trim();
      if (!name || name.length > 100) throw new Error('模板名称无效');
      if (set.templates.length >= MAX_TEMPLATES && !set.templates.some((item) => item.id === id)) {
        throw new Error('模板集已达到 1000 张上限');
      }
      const threshold = input.threshold ?? 0.85;
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('匹配阈值必须在 0 到 1 之间');
      const tags = input.tags?.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 20).map((tag) => tag.trim().slice(0, 40));
      const note = input.note?.trim().slice(0, 500);
      const bounds: Rect = {
        x: Math.round(crop.x * set.refWidth / sourceWidth),
        y: Math.round(crop.y * set.refHeight / sourceHeight),
        w: Math.max(1, Math.round(crop.w * set.refWidth / sourceWidth)),
        h: Math.max(1, Math.round(crop.h * set.refHeight / sourceHeight)),
      };
      const defaultRoi = input.defaultRoi
        ? checkedRect(input.defaultRoi, set.refWidth, set.refHeight, '默认搜索区域')
        : clampRoi(bounds, set.refWidth, set.refHeight);
      let png: Buffer = await sharp(image).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
        .png({ compressionLevel: 9 }).toBuffer();
      if (input.alpha) png = await applyAlpha(png, asBytes(input.alpha, '透明掩码'));
      const file = `${id}.${randomUUID().replaceAll('-', '').slice(0, 10)}.png`;
      const definition: TemplateDefinition = {
        id, name, file, authoredWidth: sourceWidth, authoredHeight: sourceHeight,
        bounds, defaultRoi, threshold, ...(tags?.length ? { tags } : {}),
      };
      // Validate the exact image that would be used at runtime before any manifest update.
      const prepared = await prepareTemplate(png, definition, set);
      const manifestFile = join(root, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      const old = set.templates.find((item) => item.id === id);
      const now = Date.now();
      const entry = { ...definition, std: Math.round(prepared.std * 10) / 10,
        ...(note ? { note } : {}), createdAt: old ? (raw.templates as Array<Record<string, unknown>>).find((item) => item.id === id)?.createdAt ?? now : now,
        updatedAt: now };
      const list = (raw.templates as Array<Record<string, unknown>>).filter((item) => item.id !== id);
      list.push(entry);
      raw.templates = list;
      raw.updatedAt = now;
      await writeAtomic(join(root, file), png);
      await writeAtomic(manifestFile, JSON.stringify(raw, null, 2) + '\n');
      if (old && old.file !== file) await rm(join(root, old.file), { force: true }).catch(() => undefined);
      return { definition, std: prepared.std, directory: root };
    });
  }

  async delete(directory: string, id: string): Promise<void> {
    await this.withWrite(directory, async (root) => {
      const set = await loadTemplateSet(root);
      const old = set.templates.find((item) => item.id === id);
      if (!old) throw new Error(`模板 ${id} 不存在`);
      const manifestFile = join(root, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      raw.templates = (raw.templates as Array<Record<string, unknown>>).filter((item) => item.id !== id);
      raw.updatedAt = Date.now();
      await writeAtomic(manifestFile, JSON.stringify(raw, null, 2) + '\n');
      await rm(join(root, old.file), { force: true });
    });
  }

  private async withWrite<T>(directory: string, action: (root: string) => Promise<T>): Promise<T> {
    if (!isAbsolute(directory)) throw new Error('模板目录必须是绝对路径');
    const root = resolve(directory);
    const previous = this.writes.get(root) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((done) => { release = done; });
    this.writes.set(root, next);
    await previous;
    try { return await action(root); }
    finally {
      if (this.writes.get(root) === next) this.writes.delete(root);
      release();
    }
  }
}

async function applyAlpha(png: Uint8Array, alphaPng: Uint8Array): Promise<Buffer> {
  const base = await sharp(png).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(alphaPng).greyscale().toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (mask.info.width !== base.info.width || mask.info.height !== base.info.height || mask.info.channels !== 1) {
    throw new Error('透明掩码尺寸必须与裁剪后的模板一致，且为单通道 PNG');
  }
  const rgba = Buffer.alloc(base.info.width * base.info.height * 4);
  for (let i = 0; i < base.info.width * base.info.height; i++) {
    rgba[i * 4] = base.data[i * base.info.channels]!;
    rgba[i * 4 + 1] = base.data[i * base.info.channels + 1]!;
    rgba[i * 4 + 2] = base.data[i * base.info.channels + 2]!;
    rgba[i * 4 + 3] = mask.data[i]!;
  }
  return sharp(rgba, { raw: { width: base.info.width, height: base.info.height, channels: 4 } }).png().toBuffer();
}
