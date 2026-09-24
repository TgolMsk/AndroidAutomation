import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { RawFrame } from '@avdm/automation';

const MAX_AGE_MS = 14 * 86_400_000;
const MAX_FILES = 300;
const SHOT_WIDTH = 1280;
const JPEG_QUALITY = 72;

/**
 * Failure-scene screenshots of gather cycles and scheduler probes (original `<dataDir>/shots/alerts`):
 * `automation/wanlong/shots/inst<N>-<label>-<time>.jpg`, private (0600), pruned after 14 days / 300 files.
 * Frames are local evidence only and never leave the machine unless the user sends them.
 */
export class ShotStore {
  readonly dir: string;
  private pruning: Promise<void> | null = null;

  constructor(private readonly home: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(home)) throw new Error('截图目录必须是绝对路径');
    this.dir = path.join(home, 'automation', 'wanlong', 'shots');
  }

  /** Encode and save one frame. Returns the path relative to the data directory (`automation/wanlong/shots/…`). */
  async save(index: number, label: string, raw: RawFrame): Promise<string> {
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'shot';
    const name = `inst${index}-${safeLabel}-${this.now()}.jpg`;
    const file = path.join(this.dir, name);
    const data = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
    const width = Math.min(SHOT_WIDTH, raw.width);
    const jpeg = await sharp(data, { raw: { width: raw.width, height: raw.height, channels: 4 } })
      .resize({ width, fit: 'inside' }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(jpeg); } finally { await handle.close(); }
      await rename(temp, file);
      await chmod(file, 0o600);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    this.pruning ??= this.prune().finally(() => { this.pruning = null; });
    return path.relative(this.home, file).split(path.sep).join('/');
  }

  async prune(): Promise<void> {
    let names: string[];
    try { names = (await readdir(this.dir)).filter((name) => name.endsWith('.jpg')); } catch { return; }
    const entries: Array<{ file: string; at: number }> = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try { entries.push({ file, at: (await stat(file)).mtimeMs }); } catch { /* vanished */ }
    }
    entries.sort((a, b) => b.at - a.at);
    const cutoff = this.now() - MAX_AGE_MS;
    await Promise.all(entries.filter((entry, i) => i >= MAX_FILES || entry.at < cutoff)
      .map((entry) => rm(entry.file, { force: true }).catch(() => undefined)));
  }
}
