import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { RawFrame } from '@avdm/automation';

const MAX_PNG_BYTES = 24 * 1024 * 1024;
const MAX_AGE_MS = 14 * 86_400_000;

function safeScope(gameId: string, index: number): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(gameId) || !Number.isInteger(index) || index < 0 || index > 63) {
    throw new Error('监控证据范围无效');
  }
}

/** Screenshots stay under the user's private AVD data directory and expire after 14 days. */
export class MonitorEvidenceStore {
  private readonly root: string;

  constructor(home: string) {
    if (!path.isAbsolute(home)) throw new Error('监控数据目录必须是绝对路径');
    this.root = path.join(home, 'automation', 'monitoring', 'shots');
  }

  async savePng(gameId: string, index: number, png: Uint8Array, at = Date.now()): Promise<string> {
    safeScope(gameId, index);
    if (!(png instanceof Uint8Array) || png.byteLength < 8 || png.byteLength > MAX_PNG_BYTES ||
        !Number.isSafeInteger(at) || at < 0) throw new Error('监控截图无效');
    const metadata = await sharp(Buffer.from(png.buffer, png.byteOffset, png.byteLength), { limitInputPixels: 100_000_000 }).metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('监控截图必须为 PNG');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = path.join(this.root, `${at}_${gameId}_${index}_${randomUUID()}.png`);
    const temp = `${file}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(png); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
      await chmod(file, 0o600);
      void this.prune(at).catch(() => undefined);
      return file;
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async saveFrame(gameId: string, index: number, frame: RawFrame, at = Date.now()): Promise<string> {
    if (frame.data.byteLength !== frame.width * frame.height * 4) throw new Error('监控原始截图格式无效');
    const png = await sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
      { raw: { width: frame.width, height: frame.height, channels: 4 }, limitInputPixels: 100_000_000 })
      .png({ compressionLevel: 9 }).toBuffer();
    return this.savePng(gameId, index, png, at);
  }

  async prune(now = Date.now()): Promise<void> {
    const entries = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of entries) {
      const match = /^(\d{13})_[a-z][a-z0-9-]{0,63}_\d{1,2}_[0-9a-f-]{36}\.png$/.exec(name);
      if (match && now - Number(match[1]) > MAX_AGE_MS) await rm(path.join(this.root, name), { force: true });
    }
  }
}
