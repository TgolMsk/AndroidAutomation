import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadTemplateSet, parseTemplateDefinition, parseTemplateSetHeader } from './templates.js';

/*
 * Only-add merge of template sets (the original panel's builtin seeding, now an explicit import).
 *
 * The original seeded packaged sets into the user library on every boot. This product ships no templates, so the
 * same rules back 「导入 / 合并旧模板集」 (a legacy `.wl-data/templates` root, `<old dataDir>/templates`, or one set
 * folder):
 *   - the user lacks the set → copy it whole, PNGs first and the manifest last (an interruption never leaves a
 *     manifest pointing at missing images);
 *   - the user has the set → add only template ids absent from the user manifest; existing templates (edited
 *     thresholds, ROIs, re-cropped images, AI-learned templates) are never touched;
 *   - a corrupt user manifest → skip the set with a reason, never overwrite it;
 *   - unsafe set/file names, invalid source manifests, missing or non-regular source PNGs → skipped with a warning
 *     and left out of the manifest.
 * Idempotent: a second run copies nothing.
 */

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
const MANIFEST = 'manifest.json';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export type SeedLog = (level: 'info' | 'warn', message: string) => void;

export interface SeedResult {
  /** Sets copied whole: setId → files copied (including the manifest). */
  copiedSets: Record<string, number>;
  /** Template ids added to sets the user already had. */
  addedTemplates: Record<string, string[]>;
  /** Skipped sets and the Chinese reason. */
  skipped: Record<string, string>;
}

export interface MergeTemplateSetsOptions {
  /** A root holding set folders, or one set folder (with manifest.json directly inside). */
  sourceDir: string;
  /** The library root receiving `<setId>/` folders. */
  targetRoot: string;
  /** When given, sets that declare another package are skipped. */
  packageName?: string;
  log?: SeedLog;
  /** Serializes writes per target set folder with the library's own writer. */
  lock?: <T>(directory: string, action: () => Promise<T>) => Promise<T>;
}

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== '.' && segment !== '..';
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

async function isRegularFile(path: string, maxBytes = Infinity): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes;
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (isCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function writeManifest(directory: string, manifest: Record<string, unknown>): Promise<void> {
  const target = join(directory, MANIFEST);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Copy only when the target does not exist; false when it already does. */
async function copyIfMissing(src: string, dst: string): Promise<boolean> {
  try {
    await copyFile(src, dst, fsConstants.COPYFILE_EXCL);
    await chmod(dst, 0o600);
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  }
}

interface SourceTemplate {
  id: string;
  file: string;
  raw: Record<string, unknown>;
}

/** Valid, uniquely named templates whose PNG exists as a regular file in the source folder. */
async function usableTemplates(src: string, rawTemplates: unknown[], log: SeedLog): Promise<SourceTemplate[]> {
  const out: SourceTemplate[] = [];
  const seen = new Set<string>();
  for (const raw of rawTemplates) {
    const rawId = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '?';
    let id: string;
    let file: string;
    try { ({ id, file } = parseTemplateDefinition(raw)); }
    catch (error) {
      log('warn', `源模板「${rawId}」不合法，跳过这张：${errMsg(error)}`);
      continue;
    }
    if (seen.has(id)) {
      log('warn', `源模板「${id}」重复出现，只保留第一张。`);
      continue;
    }
    if (!(await isRegularFile(join(src, file), MAX_TEMPLATE_BYTES))) {
      log('warn', `源模板「${id}」缺图或不是常规文件（${file}），跳过这张。`);
      continue;
    }
    seen.add(id);
    out.push({ id, file, raw: raw as Record<string, unknown> });
  }
  return out;
}

export async function mergeTemplateSets(options: MergeTemplateSetsOptions): Promise<SeedResult> {
  const log: SeedLog = options.log ?? (() => undefined);
  const lock = options.lock ?? (<T>(_directory: string, action: () => Promise<T>) => action());
  const result: SeedResult = { copiedSets: {}, addedTemplates: {}, skipped: {} };

  let candidates: Array<{ setId: string; src: string }>;
  if (await isRegularFile(join(options.sourceDir, MANIFEST))) {
    // One set folder: its manifest id names the target folder when the folder name itself is not a safe segment.
    let setId = basename(options.sourceDir);
    if (!isSafeSegment(setId)) {
      try { setId = parseTemplateSetHeader(JSON.parse(await readFile(join(options.sourceDir, MANIFEST), 'utf8'))).id; }
      catch { /* Reported below as an invalid manifest. */ }
    }
    candidates = [{ setId, src: options.sourceDir }];
  } else {
    let entries: Dirent[];
    try { entries = await readdir(options.sourceDir, { withFileTypes: true }); }
    catch (error) {
      if (isCode(error, 'ENOENT')) return result;
      throw error;
    }
    candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = join(options.sourceDir, entry.name);
      if (!(await isRegularFile(join(src, MANIFEST)))) continue; // Not a template set.
      candidates.push({ setId: entry.name, src });
    }
  }

  for (const { setId, src } of candidates) {
    if (!isSafeSegment(setId)) {
      result.skipped[setId] = '模板集目录名含有不安全字符';
      log('warn', `模板集「${setId}」目录名不合法，跳过。`);
      continue;
    }
    let header: ReturnType<typeof parseTemplateSetHeader>;
    let rawManifest: Record<string, unknown>;
    try {
      rawManifest = JSON.parse(await readFile(join(src, MANIFEST), 'utf8')) as Record<string, unknown>;
      header = parseTemplateSetHeader(rawManifest);
    } catch (error) {
      result.skipped[setId] = `源 manifest 不合法：${errMsg(error)}`;
      log('warn', `模板集「${setId}」的 manifest 不合法，跳过：${errMsg(error)}`);
      continue;
    }
    if (options.packageName && header.packageName && header.packageName !== options.packageName) {
      result.skipped[setId] = `模板集属于 ${header.packageName}，不是 ${options.packageName}`;
      log('warn', `模板集「${header.name}」（${setId}）属于 ${header.packageName}，跳过。`);
      continue;
    }

    const dst = join(options.targetRoot, setId);
    try {
      await lock(dst, async () => {
        if (!(await exists(join(dst, MANIFEST)))) {
          const count = await copyWholeSet(src, dst, rawManifest, header.templates, log);
          result.copiedSets[setId] = count;
          log('info', `已导入模板集「${header.name}」（${setId}）：${count} 个文件。`);
        } else {
          const added = await mergeMissing(src, dst, header.templates, setId, log);
          if (added.length > 0) {
            result.addedTemplates[setId] = added;
            log('info', `模板集「${header.name}」（${setId}）补进 ${added.length} 张模板：${added.join('、')}。`);
          }
        }
      });
    } catch (error) {
      // A corrupt user manifest, a full disk, a permission problem: record the reason, never overwrite.
      result.skipped[setId] = errMsg(error);
      log('warn', `模板集「${setId}」导入失败，已跳过：${errMsg(error)}`);
    }
  }
  return result;
}

/** Copy a whole set: PNGs first, the manifest last. Returns the number of files copied (including the manifest). */
async function copyWholeSet(src: string, dst: string, rawManifest: Record<string, unknown>, rawTemplates: unknown[], log: SeedLog): Promise<number> {
  await mkdir(dst, { recursive: true, mode: 0o700 });
  let copied = 0;
  const kept: Record<string, unknown>[] = [];
  for (const template of await usableTemplates(src, rawTemplates, log)) {
    if (await copyIfMissing(join(src, template.file), join(dst, template.file))) copied += 1;
    kept.push(template.raw);
  }
  await writeManifest(dst, { ...rawManifest, templates: kept });
  return copied + 1;
}

/** An existing set: add only ids missing from the user manifest. Returns the added ids. */
async function mergeMissing(src: string, dst: string, rawTemplates: unknown[], setId: string, log: SeedLog): Promise<string[]> {
  // Strict read: a corrupt or unsafe user manifest throws here and the set is skipped untouched.
  const user = await loadTemplateSet(dst).catch((error: unknown) => {
    throw new Error(`模板集「${setId}」的现有 manifest 无法读取：${errMsg(error)}`);
  });
  const userRaw = JSON.parse(await readFile(join(dst, MANIFEST), 'utf8')) as Record<string, unknown>;
  const have = new Set(user.templates.map((item) => item.id));
  const usedFiles = new Set(user.templates.map((item) => item.file.toLowerCase()));
  const added: Record<string, unknown>[] = [];
  for (const template of await usableTemplates(src, rawTemplates, log)) {
    if (have.has(template.id)) continue;
    // Never let an added template point at a file another template (or an orphan) already occupies.
    let file = template.file;
    if (usedFiles.has(file.toLowerCase()) || await exists(join(dst, file))) {
      file = `${template.id}.${randomUUID().replaceAll('-', '').slice(0, 10)}.png`;
    }
    await copyIfMissing(join(src, template.file), join(dst, file));
    usedFiles.add(file.toLowerCase());
    added.push(file === template.file ? template.raw : { ...template.raw, file });
  }
  if (added.length === 0) return [];
  const templates = Array.isArray(userRaw.templates) ? userRaw.templates : [];
  await writeManifest(dst, { ...userRaw, templates: [...templates, ...added], updatedAt: Date.now() });
  return added.map((item) => item.id as string);
}
