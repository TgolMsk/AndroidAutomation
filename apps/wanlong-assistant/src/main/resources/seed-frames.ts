import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RESOURCE_SEED_FRAMES, RESOURCE_SEED_FRAME_LABEL, RESOURCE_SEED_LEGACY_FILES, type ResourceSeedFrame } from '@avdm/automation/wanlong/pure';
import { SchedulerError } from '../scheduler/errors';

/** A whole-frame PNG (2560×1440 is about 5–12 MB); anything larger is not a screenshot. */
const MAX_FRAME_BYTES = 40 * 1024 * 1024;

/** File names accepted for each frame role, lower-cased: the old panel's names, then the role itself. */
export function resourceSeedFileNames(frame: ResourceSeedFrame): readonly string[] {
  return [RESOURCE_SEED_LEGACY_FILES[frame].toLowerCase(), `${frame.toLowerCase()}.png`];
}

export interface ResourceSeedFolder {
  frames: Partial<Record<ResourceSeedFrame, Uint8Array>>;
  /** The file used for each frame (base name). */
  files: Partial<Record<ResourceSeedFrame, string>>;
}

/** The expected file names as one Chinese hint line. */
export function resourceSeedFolderHint(): string {
  return RESOURCE_SEED_FRAMES.map((frame) => `${RESOURCE_SEED_LEGACY_FILES[frame]}（${RESOURCE_SEED_FRAME_LABEL[frame]}）`).join('、');
}

/**
 * The screenshots of a folder the user picked (wanlong-panel's `docs/game/shots/resources/`, or their own), matched by
 * name: `res_02_items.png` / `res_04_stats.png` / `res_05_back1.png` / `res_06_back2.png`, or `items.png` /
 * `stats.png` / `back1.png` / `worldmap.png` (case-insensitive). Only regular files, at most 40 MB each; symbolic links
 * are ignored. A folder with none of them is a Chinese error naming the expected files.
 */
export async function readResourceSeedFolder(dir: string): Promise<ResourceSeedFolder> {
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    throw new SchedulerError('NOT_FOUND', `读不了所选文件夹：${error instanceof Error ? error.message : String(error)}`);
  }
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  const out: ResourceSeedFolder = { frames: {}, files: {} };
  for (const frame of RESOURCE_SEED_FRAMES) {
    for (const wanted of resourceSeedFileNames(frame)) {
      const name = byLower.get(wanted);
      if (!name) continue;
      const file = path.join(dir, name);
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > MAX_FRAME_BYTES) {
        throw new SchedulerError('INVALID_ARGUMENT', `截图「${name}」超过 40 MB，不像一张整帧截图。`);
      }
      out.frames[frame] = new Uint8Array(await readFile(file));
      out.files[frame] = name;
      break;
    }
  }
  if (Object.keys(out.frames).length === 0) {
    throw new SchedulerError('NOT_FOUND', `所选文件夹里没有资源统计截图。需要这些文件（有几张用几张）：${resourceSeedFolderHint()}。`);
  }
  return out;
}
