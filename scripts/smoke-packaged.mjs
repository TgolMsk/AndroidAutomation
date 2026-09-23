#!/usr/bin/env node
/** Boot the actual packaged macOS app in a fresh profile and capture its first window. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('安装包启动冒烟只支持 macOS');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'release', 'mac-arm64', 'AVD 多开管理器.app', 'Contents', 'MacOS', 'AVD 多开管理器');
const work = await mkdtemp(path.join(tmpdir(), 'avdm-packaged-smoke-'));
const screenshot = path.join(work, 'first-window.png');
let child;
let timer;
let output = '';
try {
  child = spawn(executable, [`--user-data-dir=${path.join(work, 'electron-profile')}`], {
    cwd: root,
    env: {
      ...process.env,
      AVDM_HOME: path.join(work, 'avdm-home'),
      AVDM_SCREENSHOT_PATH: screenshot,
      AVDM_SCREENSHOT_DELAY_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    output = (output + chunk.toString()).slice(-12_000);
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('安装包启动超过 30 秒'));
    }, 30_000);
  });
  const { code, signal } = await Promise.race([exit, timeout]);
  if (code !== 0) throw new Error(`安装包退出异常（${code ?? signal}）\n${output}`);
  const image = await readFile(screenshot);
  if (image.length < 10_000 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error(`首次窗口截图无效（${image.length} bytes）\n${output}`);
  }
  console.log(`已启动打包应用并显示首次窗口（截图 ${image.length} bytes）`);
} finally {
  if (timer) clearTimeout(timer);
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await rm(work, { recursive: true, force: true });
}
