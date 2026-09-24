import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { shotFilename } from '../../shared/bot';

const MAX_AGE_MS = 14 * 86_400_000;
const MAX_FILES = 300;
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Audit copies of the screenshots the bot sent (original `<dataDir>/shots/bot/`):
 * `automation/wanlong/bot-shots/inst<N>-YYYYMMDD-HHMMSS.jpg` (Beijing time), private (0600), pruned after 14 days /
 * 300 files like the gather scenes. The caller applies the app's shot policy (「不留痕」 keeps none).
 */
export class BotShotStore {
  readonly dir: string;
  private pruning: Promise<void> | null = null;

  constructor(private readonly home: string, private readonly now: () => number = Date.now) {
    if (!path.isAbsolute(home)) throw new Error('机器人截图目录必须是绝对路径');
    this.dir = path.join(home, 'automation', 'wanlong', 'bot-shots');
  }

  /** Save one JPEG; returns the path relative to the data directory. */
  async save(index: number, jpeg: Uint8Array, at: number): Promise<string> {
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
    if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_BYTES) throw new Error('截图大小无效');
    const file = path.join(this.dir, shotFilename(index, at));
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
