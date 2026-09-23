#!/usr/bin/env node
/** Boot both packaged macOS apps in isolated Electron profiles and capture their first windows. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('安装包启动冒烟只支持 macOS');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = await mkdtemp(path.join(tmpdir(), 'avdm-packaged-smoke-'));
const releaseRoot = path.resolve(process.env.AVDM_RELEASE_DIR ?? path.join(root, 'release'));
const desktopRelease = path.resolve(process.env.AVDM_DESKTOP_RELEASE_DIR ?? releaseRoot);
const assistantRelease = path.resolve(process.env.AVDM_ASSISTANT_RELEASE_DIR ?? path.join(releaseRoot, 'wanlong-assistant'));

const apps = [
  {
    key: 'emulator',
    name: 'AVD 多开管理器',
    executable: path.join(desktopRelease, 'mac-arm64', 'AVD 多开管理器.app', 'Contents', 'MacOS', 'AVD 多开管理器'),
  },
  {
    key: 'wanlong',
    name: '万龙助手',
    executable: path.join(assistantRelease, 'mac-arm64', '万龙助手.app', 'Contents', 'MacOS', '万龙助手'),
  },
];

async function smoke(app) {
  const screenshot = path.join(work, `${app.key}-first-window.png`);
  let child;
  let timer;
  let output = '';
  try {
    child = spawn(app.executable, [`--user-data-dir=${path.join(work, `${app.key}-electron-profile`)}`], {
      cwd: root,
      env: {
        ...process.env,
        // The same manager home checks that both products can open one instance registry.
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
        reject(new Error(`${app.name} 安装包启动超过 30 秒`));
      }, 30_000);
    });
    const { code, signal } = await Promise.race([exit, timeout]);
    if (code !== 0) throw new Error(`${app.name} 安装包退出异常（${code ?? signal}）\n${output}`);
    const image = await readFile(screenshot);
    if (image.length < 10_000 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error(`${app.name} 首次窗口截图无效（${image.length} bytes）\n${output}`);
    }
    console.log(`${app.name} 已启动并显示首次窗口（截图 ${image.length} bytes）`);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
}

try {
  for (const app of apps) await smoke(app);
  const cli = path.join(desktopRelease, 'mac-arm64', 'AVD 多开管理器.app', 'Contents', 'Resources', 'bin', 'avdm');
  const cliEnv = { ...process.env, AVDM_HOME: path.join(work, 'cli-home') };
  const expectedVersion = JSON.parse(await readFile(path.join(root, 'packages', 'desktop', 'package.json'), 'utf8')).version;
  const version = execFileSync(cli, ['--version'], { env: cliEnv, encoding: 'utf8', timeout: 10_000 }).trim();
  const instances = JSON.parse(execFileSync(cli, ['list', '--json'], { env: cliEnv, encoding: 'utf8', timeout: 10_000 }));
  if (version !== expectedVersion || !Array.isArray(instances) || instances.length !== 0) {
    throw new Error(`安装包 CLI 冒烟失败：version=${version}, list=${JSON.stringify(instances)}`);
  }
  console.log(`模拟器安装包内 avdm 命令可运行（版本 ${version}，隔离实例列表为空）`);
} finally {
  await rm(work, { recursive: true, force: true });
}
