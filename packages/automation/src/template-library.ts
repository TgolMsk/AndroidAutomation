import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import sharp, { type Metadata } from 'sharp';
import type { Rect, TemplateDefinition, TemplateSet } from './contracts.js';
import { DEFAULT_SHRINK } from './constants.js';
import { AppError } from './errors.js';
import { applyAlpha, buildDiffAlpha } from './template-alpha.js';
import { mergeTemplateSets, type SeedLog, type SeedResult } from './template-seed.js';
import { loadTemplateSet, parseTemplateDefinition, readTemplatePng } from './templates.js';
import { prepareTemplate } from './vision.js';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
const GAME_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_TEMPLATES = 1_000;
const MAX_TAGS = 20;
const MAX_NOTE = 500;
const MAX_DIFF_FRAMES = 7;

export interface TemplateDraft {
  /** Fixed id (flows reference templates by id, e.g. tpl_btn_close_popup). Empty: a new random id. */
  id?: string;
  name: string;
  /** The whole frame (PNG/JPEG) when `crop` is given; otherwise the already cropped template. */
  image: Uint8Array;
  /** Size of the frame the template comes from (drives reference normalization, k = refWidth / authoredWidth). */
  authoredWidth: number;
  authoredHeight: number;
  /** Crop in the image's own pixels. Omit when `image` is already the template. */
  crop?: Rect;
  /** Reference-canvas coordinates. Omitted: derived from the bounds (pad max(80, 60%)). */
  defaultRoi?: Rect;
  threshold?: number;
  /** Glyph sets need ['digit', <set prefix>]. */
  tags?: string[];
  note?: string;
  /** Optional one-channel PNG mask the size of the crop: 0 is ignored, 255 takes part. Wins over `diffFrames`. */
  alpha?: Uint8Array;
  /** Extra whole frames (same size as `image`, same control, different background): the mask is computed here. */
  diffFrames?: Uint8Array[];
  /** Diff tolerance for `diffFrames` (default 24). */
  diffTolerance?: number;
  /** Required to replace an existing template with the same id (otherwise TEMPLATE_EXISTS). */
  overwrite?: boolean;
}

export interface TemplateSaveResult {
  definition: TemplateDefinition;
  std: number;
  /** Opaque fraction of a transparent-background template (after shrinking, as matched). */
  maskCoverage?: number;
  /** Opaque fraction of the diff mask at full resolution, when `diffFrames` were given. */
  diffCoverage?: number;
  directory: string;
  /** True when an existing template with the same id was replaced. */
  replaced: boolean;
}

function asBytes(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 8 || value.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError('INVALID_ARGUMENT', `${label}为空或超过 32 MiB`);
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_384) throw new AppError('INVALID_ARGUMENT', `${label}无效`);
  return value;
}

function checkedRect(rect: Rect | undefined, width: number, height: number, label: string): Rect {
  const values = [rect?.x, rect?.y, rect?.w, rect?.h];
  if (!rect || !values.every((value) => Number.isSafeInteger(value)) || rect.x < 0 || rect.y < 0 ||
    rect.w < 3 || rect.h < 3 || rect.x + rect.w > width || rect.y + rect.h > height) {
    throw new AppError('INVALID_ARGUMENT', `${label}超出 ${width}×${height} 画面`, { rect });
  }
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/** A loose default search window around the bounds (reference space): pad max(80 px, 60% of the size). */
export function deriveRoi(bounds: Rect, width: number, height: number): Rect {
  const padX = Math.max(80, Math.round(bounds.w * 0.6));
  const padY = Math.max(80, Math.round(bounds.h * 0.6));
  const x = Math.max(0, bounds.x - padX);
  const y = Math.max(0, bounds.y - padY);
  return {
    x, y,
    w: Math.max(1, Math.min(width, bounds.x + bounds.w + padX) - x),
    h: Math.max(1, Math.min(height, bounds.y + bounds.h + padY) - y),
  };
}

export async function writeAtomic(file: string, bytes: Uint8Array | string): Promise<void> {
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One spelling per directory: the realpath (AVDM_HOME may sit behind a symlink, e.g. macOS /var → /private/var).
 * A folder that does not exist yet (a set an import is about to copy) is canonicalized through its parent.
 * `TemplateSet.directory`, the per-directory writer and the templates-changed events all use this form.
 */
export async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = resolve(directory);
  try { return await realpath(resolved); }
  catch {
    try { return join(await realpath(dirname(resolved)), basename(resolved)); }
    catch { return resolved; }
  }
}

/** One writer per template directory; an atomic manifest remains the source of truth. */
export class TemplateLibrary {
  private readonly managedRoot: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(home: string) {
    if (!isAbsolute(home)) throw new AppError('INVALID_ARGUMENT', 'AVDM home 必须是绝对路径');
    this.managedRoot = join(home, 'automation', 'templates');
  }

  /** The managed root of one game: ~/.avdm/automation/templates/<gameId>. */
  gameRoot(gameId: string): string {
    if (!GAME_ID.test(gameId)) throw new AppError('INVALID_ARGUMENT', '游戏包 ID 无效');
    return join(this.managedRoot, gameId);
  }

  /** The managed root, created if needed, in its canonical (realpath) spelling. */
  async canonicalGameRoot(gameId: string): Promise<string> {
    const root = this.gameRoot(gameId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    return realpath(root);
  }

  async managedSets(gameId: string): Promise<TemplateSet[]> {
    const root = this.gameRoot(gameId);
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sets: TemplateSet[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try { sets.push(await loadTemplateSet(join(root, entry.name))); }
      catch (error) { console.warn(`[avdm] 跳过损坏模板集「${entry.name}」：${errorText(error)}`); }
    }
    return sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async createSet(gameId: string, name: string, packageName: string, refWidth: number, refHeight: number): Promise<TemplateSet> {
    const root = this.gameRoot(gameId);
    if (!name.trim() || name.trim().length > 100) throw new AppError('INVALID_ARGUMENT', '模板集名称不能为空，且不超过 100 字');
    if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) throw new AppError('INVALID_ARGUMENT', '游戏包名无效');
    positive(refWidth, '参考宽度');
    positive(refHeight, '参考高度');
    const id = `tset_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const directory = join(root, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(join(directory, 'manifest.json'), JSON.stringify({
      id, name: name.trim(), packageName, refWidth, refHeight, templates: [], updatedAt: Date.now(),
    }, null, 2) + '\n');
    return loadTemplateSet(directory);
  }

  /** Delete a whole set, only inside this library's managed root (never a user-picked folder). */
  async deleteSet(gameId: string, directory: string): Promise<void> {
    const root = await realpath(this.gameRoot(gameId)).catch(() => null);
    const target = await realpath(directory).catch(() => null);
    if (!root || !target || dirname(target) !== root || !(await lstat(target)).isDirectory()) {
      throw new AppError('INVALID_ARGUMENT', '只能删除助手管理目录中的模板集');
    }
    await this.withWrite(target, () => rm(target, { recursive: true, force: true }));
  }

  load(directory: string): Promise<TemplateSet> { return loadTemplateSet(directory); }

  async image(directory: string, id: string): Promise<Uint8Array> {
    return readTemplatePng(await loadTemplateSet(directory), id);
  }

  /**
   * Save (create or, with `overwrite`, replace) one template.
   * Crop → PNG (never JPEG) → optional mask (alpha, or diff frames computed here) → ★ variance guard BEFORE any
   * write → PNG `<id>.png` and the manifest, both atomic. A replaced template keeps its manifest position and
   * createdAt. Old randomized file names (`<id>.<rand>.png`) are still read and cleaned up on replace.
   */
  async save(directory: string, input: TemplateDraft): Promise<TemplateSaveResult> {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw new AppError('INVALID_ARGUMENT', '模板名称不能为空，且不超过 100 字');
    const image = asBytes(input.image, `模板「${name}」的图片`);
    const authoredWidth = positive(input.authoredWidth, `模板「${name}」截取时的画面宽度`);
    const authoredHeight = positive(input.authoredHeight, `模板「${name}」截取时的画面高度`);
    return this.withWrite(directory, async (root) => {
      const set = await loadTemplateSet(root);
      const id = input.id?.trim() || `tpl_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      if (!SAFE_ID.test(id)) throw new AppError('INVALID_ARGUMENT', `模板 ID「${id}」不合法：只允许字母、数字、下划线、点和短横线`);
      const old = set.templates.find((item) => item.id === id);
      if (old && input.overwrite !== true) {
        throw new AppError('TEMPLATE_EXISTS', `模板 ID「${id}」已被「${old.name}」使用。确认覆盖后再保存，或换一个 ID。`, { templateId: id });
      }
      if (!old && set.templates.length >= MAX_TEMPLATES) throw new AppError('INVALID_ARGUMENT', `模板集已达到 ${MAX_TEMPLATES} 张上限`);
      const threshold = input.threshold;
      if (threshold !== undefined && (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
        throw new AppError('INVALID_ARGUMENT', '匹配阈值必须在 0 到 1 之间');
      }
      const tags = Array.isArray(input.tags)
        ? [...new Set(input.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim().slice(0, 40)))].slice(0, MAX_TAGS)
        : undefined;
      const note = typeof input.note === 'string' ? input.note.trim().slice(0, MAX_NOTE) : '';

      let meta: Metadata;
      try { meta = await sharp(image, { limitInputPixels: 100_000_000 }).metadata(); }
      catch (error) { throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${name}」的图片无法解码：${errorText(error)}`); }
      const imageWidth = positive(meta.width ?? 0, '图片宽度');
      const imageHeight = positive(meta.height ?? 0, '图片高度');
      const crop = input.crop ? checkedRect(input.crop, imageWidth, imageHeight, `模板「${name}」的裁剪区域`) : undefined;
      if (crop && (imageWidth !== authoredWidth || imageHeight !== authoredHeight)) {
        throw new AppError('INVALID_ARGUMENT', `原图尺寸 ${imageWidth}×${imageHeight} 与截取时的画面 ${authoredWidth}×${authoredHeight} 不一致，请重新截图`);
      }

      // ① Crop and encode as PNG (lossless; JPEG blocks would pollute the correlation).
      let png: Buffer;
      try {
        let pipeline = sharp(image, { limitInputPixels: 100_000_000 });
        if (crop) pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h });
        png = await pipeline.png({ compressionLevel: 9 }).toBuffer();
      } catch (error) {
        throw new AppError('TEMPLATE_DECODE_FAILED', `模板「${name}」裁剪/编码失败：${errorText(error)}`);
      }
      // Transparent background: the caller's alpha wins; otherwise the diff frames are computed with the same
      // algorithm as the page's preview.
      let alpha: Uint8Array | null = input.alpha && input.alpha.byteLength > 0 ? asBytes(input.alpha, '透明掩码') : null;
      let diffCoverage: number | undefined;
      if (!alpha && Array.isArray(input.diffFrames) && input.diffFrames.length > 0) {
        if (!crop) throw new AppError('INVALID_ARGUMENT', `模板「${name}」要做差分去底必须给裁剪区域（差分帧是整帧，得知道裁哪一块）`);
        if (input.diffFrames.length > MAX_DIFF_FRAMES) throw new AppError('INVALID_ARGUMENT', `差分帧最多 ${MAX_DIFF_FRAMES} 张`);
        const diff = await buildDiffAlpha([image, ...input.diffFrames.map((frame, i) => asBytes(frame, `第 ${i + 2} 帧`))], crop,
          { tolerance: input.diffTolerance });
        alpha = diff.alphaPng;
        diffCoverage = diff.coverage;
      }
      if (alpha) png = await applyAlpha(png, alpha);

      // ② Bounds in the reference canvas: one uniform k, the same normalization prepareTemplate applies.
      const k = set.refWidth / authoredWidth;
      const pngMeta = await sharp(png).metadata();
      const bounds: Rect = crop
        ? { x: Math.round(crop.x * k), y: Math.round(crop.y * k), w: Math.max(1, Math.round(crop.w * k)), h: Math.max(1, Math.round(crop.h * k)) }
        : { x: 0, y: 0, w: Math.max(1, Math.round((pngMeta.width ?? 1) * k)), h: Math.max(1, Math.round((pngMeta.height ?? 1) * k)) };
      const defaultRoi = input.defaultRoi
        ? checkedRect(input.defaultRoi, set.refWidth, set.refHeight, '默认搜索区域')
        : deriveRoi(bounds, set.refWidth, set.refHeight);

      // ③ ★ Variance guard (and mask floor) before a single byte is written.
      const prepared = await prepareTemplate(png, {
        id, name, refW: set.refWidth, refH: set.refHeight, authoredWidth, shrink: DEFAULT_SHRINK, threshold, defaultRoi,
      });

      // ④ Write. Stable `<id>.png`, unless another template already owns that file name.
      const wanted = `${id}.png`;
      const file = set.templates.some((item) => item.id !== id && item.file.toLowerCase() === wanted.toLowerCase())
        ? `${id}.${randomUUID().replaceAll('-', '').slice(0, 10)}.png`
        : wanted;
      const manifestFile = join(root, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      const list = Array.isArray(raw.templates) ? raw.templates as Array<Record<string, unknown>> : [];
      const position = list.findIndex((item) => item?.id === id);
      const now = Date.now();
      const previousCreatedAt = position >= 0 && typeof list[position]!.createdAt === 'number' ? list[position]!.createdAt as number : now;
      const entry: Record<string, unknown> = {
        id, name, file, authoredWidth, authoredHeight, bounds, defaultRoi,
        ...(threshold !== undefined ? { threshold } : {}),
        std: Math.round(prepared.std * 10) / 10,
        ...(prepared.maskCoverage !== undefined ? { maskCoverage: prepared.maskCoverage } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(note ? { note } : {}),
        createdAt: previousCreatedAt,
        updatedAt: now,
      };
      if (position >= 0) list[position] = entry;
      else list.push(entry);
      raw.templates = list;
      raw.updatedAt = now;
      await writeAtomic(join(root, file), png);
      await writeAtomic(manifestFile, JSON.stringify(raw, null, 2) + '\n');
      if (old && old.file !== file) {
        try { await rm(join(root, old.file), { force: true }); }
        catch (error) { console.warn(`[vision] 旧模板图片删除失败 ${old.file}：${errorText(error)}`); }
      }
      const definition = parseTemplateDefinition(entry);
      return {
        definition, std: prepared.std, directory: root, replaced: Boolean(old),
        ...(prepared.maskCoverage !== undefined ? { maskCoverage: prepared.maskCoverage } : {}),
        ...(diffCoverage !== undefined ? { diffCoverage } : {}),
      };
    });
  }

  async delete(directory: string, id: string): Promise<void> {
    await this.withWrite(directory, async (root) => {
      const set = await loadTemplateSet(root);
      const old = set.templates.find((item) => item.id === id);
      if (!old) throw new AppError('TEMPLATE_NOT_FOUND', `模板集「${set.name}」里没有 id 为 ${id} 的模板`, { templateId: id });
      const manifestFile = join(root, 'manifest.json');
      const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
      raw.templates = (raw.templates as Array<Record<string, unknown>>).filter((item) => item.id !== id);
      raw.updatedAt = Date.now();
      await writeAtomic(manifestFile, JSON.stringify(raw, null, 2) + '\n');
      // The manifest is already effective; a failed image delete only warns.
      try { await rm(join(root, old.file), { force: true }); }
      catch (error) { console.warn(`[vision] 模板图片删除失败 ${old.file}：${errorText(error)}`); }
    });
  }

  /**
   * Only-add merge of template sets from `sourceDir` (a legacy templates root, or one set folder) into this game's
   * managed root. Existing ids are never touched; a corrupt managed manifest is skipped, never overwritten.
   * The target is `canonicalGameRoot(gameId)`, so `<that root>/<setId>` matches `TemplateSet.directory` of the sets
   * it reports. `dryRun` only reports what would change.
   */
  async importSets(gameId: string, sourceDir: string, options: { packageName?: string; log?: SeedLog; dryRun?: boolean } = {}):
    Promise<SeedResult> {
    if (!isAbsolute(sourceDir)) throw new AppError('INVALID_ARGUMENT', '导入目录必须是绝对路径');
    const source = await realpath(sourceDir).catch(() => { throw new AppError('NOT_FOUND', `导入目录不存在：${sourceDir}`); });
    const targetRoot = await this.canonicalGameRoot(gameId);
    if (source === targetRoot || source.startsWith(targetRoot + sep)) {
      throw new AppError('INVALID_ARGUMENT', '不能从助手自己的模板目录导入');
    }
    return mergeTemplateSets({
      sourceDir: source, targetRoot, packageName: options.packageName, log: options.log, dryRun: options.dryRun,
      lock: (dir, action) => this.withWrite(dir, () => action()),
    });
  }

  private async withWrite<T>(directory: string, action: (root: string) => Promise<T>): Promise<T> {
    if (!isAbsolute(directory)) throw new AppError('INVALID_ARGUMENT', '模板目录必须是绝对路径');
    // Keyed by the canonical spelling: a save through a symlinked path and an import into the same set serialize.
    const root = await canonicalDirectory(directory);
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
