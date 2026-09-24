import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Atomic owner-only write (temp file + fsync + rename, mode 0600, directory 0700), as every assistant store does. */
export async function writePrivateFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Absolute data root check shared by the app stores. */
export function assertAbsoluteHome(home: string, label: string): void {
  if (!path.isAbsolute(home)) throw new Error(`${label}数据目录必须是绝对路径`);
}
