#!/usr/bin/env node
/**
 * Run the BUILT desktop app (packages/desktop/out) against the fake Android SDK and capture:
 *   main.png    main window: instance wall with running / booting / stopped cards
 *   wizard.png  SDK wizard (second run with an empty SDK; catalogue served from a file:// mirror of the fixtures)
 *   live.png    live view window of instance #0
 *
 *   pnpm build && node scripts/desktop-screenshots.mjs [--out docs/screenshots] [--keep]
 *
 * Uses the app's verification hook (AVDM_SCREENSHOT_PATH / AVDM_OPEN_LIVE, see packages/desktop/src/main/index.ts).
 * Everything lives in temp dirs; the Electron user-data dir is a temp dir too. Windows appear briefly on screen.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const DESKTOP_MAIN = path.join(DESKTOP, 'out', 'main', 'index.js');
const SDK_FIXTURES = path.join(ROOT, 'packages', 'core', 'test', 'fixtures', 'sdk');
const FAKE_HELPER = path.join(ROOT, 'packages', 'core', 'test', 'helpers', 'fakeSdk.ts');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(ROOT, 'docs', 'screenshots'));

function run(cmd, argv, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 90_000);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function cli(argv, env) {
  const res = await run(process.execPath, [CLI, ...argv], { env });
  if (res.code !== 0) throw new Error(`avdm ${argv.join(' ')} 失败 (退出码 ${res.code}):\n${res.stdout}${res.stderr}`);
  return res;
}

/** file:// mirror of dl.google.com/android/repository with the fixture manifests. */
async function makeRepositoryMirror(dir) {
  await fsp.mkdir(path.join(dir, 'sys-img', 'android'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'sys-img', 'google_apis'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'sys-img', 'google_apis_playstore'), { recursive: true });
  await fsp.copyFile(path.join(SDK_FIXTURES, 'repository2-3.xml'), path.join(dir, 'repository2-3.xml'));
  await fsp.copyFile(path.join(SDK_FIXTURES, 'sys-img-android.xml'), path.join(dir, 'sys-img', 'android', 'sys-img2-4.xml'));
  await fsp.copyFile(
    path.join(SDK_FIXTURES, 'sys-img-google_apis.xml'),
    path.join(dir, 'sys-img', 'google_apis', 'sys-img2-4.xml'),
  );
  await fsp.writeFile(
    path.join(dir, 'sys-img', 'google_apis_playstore', 'sys-img2-4.xml'),
    '<?xml version="1.0" ?>\n<sys-img:sdk-sys-img xmlns:sys-img="http://schemas.android.com/sdk/android/repo/sys-img2/04"></sys-img:sdk-sys-img>\n',
  );
  return pathToFileURL(dir).href;
}

async function capture(name, env, userDataDir) {
  const electron = createRequire(path.join(DESKTOP, 'package.json'))('electron');
  const target = path.join(OUT, name);
  await fsp.rm(target, { force: true });
  const res = await run(electron, ['.', `--user-data-dir=${userDataDir}`], {
    cwd: DESKTOP,
    env: { ...env, AVDM_SCREENSHOT_PATH: target },
    timeoutMs: 60_000,
  });
  const log = `${res.stdout}${res.stderr}`.trim();
  if (res.code !== 0) throw new Error(`截图 ${name} 失败 (退出码 ${res.code}):\n${log}`);
  // Retina captures are 2x; keep the repo small.
  await run('/usr/bin/sips', ['--resampleWidth', '1400', target], {}).catch(() => undefined);
  console.log(`✓ ${path.relative(ROOT, target)}${log ? `\n${log.replace(/^/gm, '    ')}` : ''}`);
}

async function main() {
  for (const f of [CLI, DESKTOP_MAIN]) {
    try {
      await fsp.access(f);
    } catch {
      console.error(`缺少构建产物 ${path.relative(ROOT, f)}，请先运行 pnpm build`);
      process.exit(1);
    }
  }
  await fsp.mkdir(OUT, { recursive: true });
  const { createFakeSdk } = await import(FAKE_HELPER);
  const fake = await createFakeSdk({ bootMs: 2000, grpcToken: 'shots-token', maxLifetimeMs: 5 * 60_000 });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-shots-'));
  const home = path.join(work, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ sdkRoot: fake.root, memoryReserveMb: 0, maxRunning: 8 }, null, 2),
  );
  const base = { ...process.env, ...fake.env, NO_COLOR: '1', FAKE_SCREEN_FPS: '20' };
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ANDROID_AVD_HOME;
  const env = { ...base, AVDM_HOME: home };

  try {
    // Instance wall: #0 #1 #4 running, #2 booting, #3 #5 stopped. --force: fakes need no RAM, skip admission.
    await cli(['create', '-n', '4', '--res', '1280x720'], env);
    await cli(['create', '--res', '720x1280', '--dpi', '280', '--name', '竖屏'], env);
    await cli(['set', '0', '--name', '主号', '--notes', '日常任务'], env);
    await cli(['set', '1', '--name', '小号'], env);
    await cli(['set', '3', '--name', '备用'], env);
    await cli(['clone', '3', '--name', '备用副本'], env);
    await cli(['start', '0,1,4', '--wait', '--force'], env);
    await cli(['start', '2', '--force'], { ...env, FAKE_BOOT_MS: '600000' });

    await capture('main.png', { ...env, AVDM_SCREENSHOT_DELAY_MS: '4500' }, path.join(work, 'electron-main'));
    await capture('live.png', { ...env, AVDM_OPEN_LIVE: '0', AVDM_SCREENSHOT_DELAY_MS: '2500' }, path.join(work, 'electron-live'));

    // SDK wizard: empty SDK dir, catalogue from the offline mirror.
    const home2 = path.join(work, 'home-empty');
    const emptySdk = path.join(work, 'empty-sdk');
    await fsp.mkdir(home2, { recursive: true });
    await fsp.mkdir(emptySdk, { recursive: true });
    await fsp.writeFile(path.join(home2, 'settings.json'), JSON.stringify({ sdkRoot: emptySdk }, null, 2));
    const mirror = await makeRepositoryMirror(path.join(work, 'mirror'));
    const env2 = { ...base, AVDM_HOME: home2, AVDM_SDK_REPOSITORY: mirror, ANDROID_HOME: emptySdk, ANDROID_SDK_ROOT: emptySdk };
    await capture('wizard.png', { ...env2, AVDM_SCREENSHOT_DELAY_MS: '3500' }, path.join(work, 'electron-wizard'));
  } finally {
    await run(process.execPath, [CLI, 'stop', 'all', '--force'], { env }).catch(() => undefined);
    await fake.cleanup();
    if (KEEP) console.log(`保留临时目录: ${work}`);
    else await fsp.rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
});
