#!/usr/bin/env node
/**
 * End-to-end test of the built `avdm` CLI (packages/cli/dist/index.js) against the fake Android SDK
 * (packages/core/test/fixtures/fake-sdk: Node scripts standing in for emulator / adb / qemu-img).
 *
 * Everything runs in temp dirs: AVDM_HOME, the SDK root, the emulator discovery dir. Nothing touches
 * ~/.avdm, ~/Library/Android or ~/.android, and no real emulator is started. Fake emulators still listen on
 * the real per-index ports (console 5554+2i, gRPC 8554+i), so those must be free.
 *
 *   pnpm e2e:cli                      # builds core + cli, then runs this script
 *   node scripts/e2e-cli.mjs          # run against the existing build
 *   node scripts/e2e-cli.mjs --keep   # keep the temp dirs for inspection
 *
 * Node >= 22.18 is required (the fake-SDK helper is imported as TypeScript via native type stripping).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const CORE_DIST = path.join(ROOT, 'packages', 'core', 'dist', 'index.js');
const FAKE_HELPER = path.join(ROOT, 'packages', 'core', 'test', 'helpers', 'fakeSdk.ts');

const KEEP = process.argv.includes('--keep');
const COMMAND_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint('32');
const red = paint('31');
const dim = paint('2');
const bold = paint('1');

class CheckError extends Error {}

function expect(cond, message) {
  if (!cond) throw new CheckError(message);
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines(file) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function indent(text) {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

/** Run the CLI once; resolves with {code, stdout, stderr} (never rejects on a non-zero exit). */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`命令超时（${COMMAND_TIMEOUT_MS / 1000}s）: avdm ${args.join(' ')}`));
    }, COMMAND_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });
}

async function main() {
  for (const [file, hint] of [
    [CLI, 'pnpm --filter ./packages/cli run build'],
    [CORE_DIST, 'pnpm --filter ./packages/core run build'],
  ]) {
    if (!(await exists(file))) {
      console.error(red(`缺少构建产物 ${path.relative(ROOT, file)}，请先运行: ${hint}（或直接 pnpm e2e:cli）`));
      process.exit(1);
    }
  }

  const { createFakeSdk } = await import(FAKE_HELPER);
  // A gRPC token like the real emulator with -grpc-use-token; boot takes ~1.5 s so --wait really waits.
  const fake = await createFakeSdk({ bootMs: 1500, grpcToken: 'e2e-secret-token' });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-e2e-'));
  const home = path.join(work, 'home');
  const shots = path.join(work, 'shots');
  const apk = path.join(work, 'game.apk');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(shots, { recursive: true });
  await fsp.writeFile(apk, 'PK\x03\x04 dummy apk for the fake adb\n');
  // Fake emulators need no RAM, so admission must not depend on how busy this Mac is.
  await fsp.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ sdkRoot: fake.root, memoryReserveMb: 0, maxRunning: 8, defaultSpec: { ramMb: 1024 } }, null, 2),
  );

  const env = { ...process.env, ...fake.env, AVDM_HOME: home, NO_COLOR: '1', PAGER: 'cat' };
  delete env.AVDM_DEBUG;
  delete env.ANDROID_AVD_HOME;

  console.log(bold('avdm CLI 端到端测试（假 SDK）'));
  console.log(dim(`  AVDM_HOME=${home}`));
  console.log(dim(`  SDK=${fake.root}`));
  console.log(dim(`  discovery=${fake.discoveryDir}`));

  const results = [];
  let failed = false;

  /**
   * Run `avdm <args>` and apply `check(result)`; `check` throws CheckError to fail the step.
   * After the first failure the remaining steps are skipped (they depend on earlier state).
   */
  async function step(args, check) {
    const label = `avdm ${args.map((a) => (/[\s"']/.test(a) || a === '' ? JSON.stringify(a) : a)).join(' ')}`;
    if (failed) {
      results.push({ label, status: 'skip' });
      return undefined;
    }
    const started = Date.now();
    console.log(`\n${bold('$')} ${label}`);
    let res;
    try {
      res = await runCli(args, env);
      const out = [res.stdout, res.stderr && dim(res.stderr)].filter(Boolean).join('\n');
      if (out.trim()) console.log(indent(out));
      expect(res.code === 0, `退出码 ${res.code}（期望 0）`);
      if (check) await check(res);
      const ms = Date.now() - started;
      console.log(green(`  ✓ 通过 (${(ms / 1000).toFixed(1)}s)`));
      results.push({ label, status: 'pass', ms });
    } catch (err) {
      failed = true;
      console.log(red(`  ✗ 失败: ${err instanceof Error ? err.message : String(err)}`));
      results.push({ label, status: 'fail', error: String(err instanceof Error ? err.message : err) });
    }
    return res;
  }

  const jsonOf = (res) => {
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new CheckError('stdout 不是合法 JSON');
    }
  };
  const listJson = async () => {
    const res = await runCli(['list', '--json'], env);
    expect(res.code === 0, `list --json 退出码 ${res.code}`);
    return jsonOf(res);
  };
  const statusOf = async (index) => (await listJson()).find((s) => s.record?.index === index)?.status;

  try {
    await step(['doctor'], ({ stdout }) => {
      expect(stdout.includes('37.1.11'), 'doctor 未显示 emulator 版本 37.1.11');
    });
    await step(['sdk', 'status'], ({ stdout }) => {
      expect(stdout.includes('android-35'), 'sdk status 未列出已安装镜像 android-35');
    });
    await step(['create', '-n', '3', '--res', '1280x720'], ({ stdout }) => {
      for (const i of [0, 1, 2]) expect(stdout.includes(`emulator-${5554 + 2 * i}`), `create 输出缺少实例 #${i}`);
    });
    await step(['list'], ({ stdout }) => {
      expect(/实例-0/.test(stdout) && /实例-2/.test(stdout), 'list 缺少实例名');
      expect(stdout.includes('已停止'), 'list 未显示“已停止”');
    });
    await step(['list', '--json'], (res) => {
      const list = jsonOf(res);
      expect(Array.isArray(list) && list.length === 3, `list --json 应有 3 个实例，实际 ${list?.length}`);
      expect(list.every((s) => s.status === 'stopped'), '新建实例状态应为 stopped');
      expect(list.map((s) => s.ports.serial).join(',') === 'emulator-5554,emulator-5556,emulator-5558', 'serial 不符');
      expect(list.every((s) => s.record.spec.width === 1280 && s.record.spec.height === 720), '分辨率不符');
    });
    await step(['start', 'all', '--wait'], async ({ stdout }) => {
      expect((stdout.match(/✓/g) ?? []).length >= 3, 'start 输出应有 3 个 ✓');
      const list = await listJson();
      expect(list.every((s) => s.status === 'running'), `启动后状态: ${list.map((s) => s.status).join(',')}`);
      expect(new Set(list.map((s) => s.pid)).size === 3, '3 个实例 pid 应互不相同');
      expect(!JSON.stringify(list).includes('e2e-secret-token'), 'list --json 泄露了 gRPC token');
      expect(list.every((s) => s.grpcAuth === true && s.bootCompleted === true), '应已开机且 gRPC 需鉴权');
    });
    await step(['shell', '0-2', '--', 'getprop', 'ro.product.model'], ({ stdout }) => {
      for (const i of [0, 1, 2]) expect(new RegExp(`\\[#${i}\\]\\s*\\S`).test(stdout), `shell 输出缺少 [#${i}] 行`);
    });
    await step(['install', '0', apk], async () => {
      const calls = await readJsonLines(fake.adbLog);
      expect(
        calls.some((c) => JSON.stringify(c).includes('install') && JSON.stringify(c).includes('game.apk')),
        '假 adb 未收到 install 调用',
      );
    });
    await step(['app', 'start', '1', 'com.example.game'], async () => {
      const calls = await readJsonLines(fake.adbLog);
      expect(
        calls.some((c) => JSON.stringify(c).includes('emulator-5556') && JSON.stringify(c).includes('com.example.game')),
        '假 adb 未收到 #1 的启动应用调用',
      );
    });
    await step(['screenshot', '0', '-o', shots], async () => {
      const files = (await fsp.readdir(shots)).filter((f) => /^avdm-0-\d{8}-\d{6}\.png$/.test(f));
      expect(files.length === 1, `截图目录应有 1 个 avdm-0-*.png，实际 ${files.length}`);
      const head = (await fsp.readFile(path.join(shots, files[0]))).subarray(0, 8);
      expect(head.equals(PNG_SIGNATURE), '截图不是 PNG');
    });
    await step(['tap', '0', '100', '100'], async () => {
      const calls = [...(await readJsonLines(fake.adbLog)), ...(await readJsonLines(fake.inputLog))].map((c) =>
        JSON.stringify(c),
      );
      expect(
        calls.some((c) => /input.*tap.*100.*100/.test(c) || (c.includes('"touch"') && c.includes('100'))),
        '未观察到 (100,100) 的点击',
      );
    });
    await step(['stop', 'all'], async () => {
      const list = await listJson();
      expect(list.every((s) => s.status === 'stopped'), `停止后状态: ${list.map((s) => s.status).join(',')}`);
      const left = (await fsp.readdir(fake.discoveryDir)).filter((f) => f.startsWith('pid_'));
      expect(left.length === 0, `仍有 discovery 文件: ${left.join(',')}`);
    });
    await step(['clone', '0', '-n', '2'], async () => {
      const list = await listJson();
      const clones = list.filter((s) => s.record.clonedFrom === 0).map((s) => s.record.index);
      expect(clones.join(',') === '3,4', `克隆应得到 #3,#4，实际 ${clones.join(',')}`);
      expect(await exists(path.join(home, 'avd', 'avdm_3.avd', 'config.ini')), '克隆的 AVD 目录缺失');
    });
    await step(['set', '3', '--ram', '4096', '--name', '测试'], async () => {
      const s = (await listJson()).find((x) => x.record.index === 3);
      expect(s?.record.name === '测试' && s.record.spec.ramMb === 4096, '修改未生效');
      const cfg = await fsp.readFile(path.join(home, 'avd', 'avdm_3.avd', 'config.ini'), 'utf8');
      expect(/^hw\.ramSize\s*=\s*4096M?$/m.test(cfg), 'config.ini 的 hw.ramSize 未更新');
    });
    await step(['rm', '4', '-y'], async () => {
      const list = await listJson();
      expect(!list.some((s) => s.record.index === 4), '#4 仍在列表中');
      expect(!(await exists(path.join(home, 'avd', 'avdm_4.avd'))), '#4 的 AVD 目录未删除');
    });
    await step(['script', 'example'], async () => {
      expect(await exists(path.join(home, 'scripts', 'hello-adb', 'script.json')), '示例 script.json 未生成');
      expect(await exists(path.join(home, 'scripts', 'hello-adb', 'main.py')), '示例 main.py 未生成');
    });
    await step(['script', 'list'], ({ stdout }) => {
      expect(stdout.includes('hello-adb'), 'script list 未列出 hello-adb');
    });
    await step(['start', '0', '--wait'], async () => {
      expect((await statusOf(0)) === 'running', '#0 未进入运行中');
    });
    await step(['script', 'run', 'hello-adb', '0'], async ({ stdout }) => {
      expect(/\[#0\]/.test(stdout), 'script run 输出缺少 [#0] 前缀');
      const runs = await fsp.readdir(path.join(home, 'logs', 'scripts')).catch(() => []);
      expect(runs.some((f) => f.startsWith('hello-adb-0-')), '脚本运行日志未生成');
    });
    await step(['logs', '0', '-n', '5'], ({ stdout }) => {
      const lines = stdout.replace(/\s+$/, '').split('\n');
      expect(lines.length >= 1 && lines.length <= 6, `logs -n 5 输出 ${lines.length} 行`);
    });
    await step(['stop', 'all'], async () => {
      expect((await statusOf(0)) === 'stopped', '#0 未停止');
    });
  } finally {
    // Stop whatever may still run (e.g. after a failed step), then kill leftover fakes and remove temp dirs.
    await runCli(['stop', 'all', '--force'], env).catch(() => undefined);
    await fake.cleanup();
    if (KEEP) {
      console.log(dim(`\n保留临时目录: ${work}`));
    } else {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const bad = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log(`\n${bold('结果')}: ${green(`${passed} 通过`)}，${bad.length ? red(`${bad.length} 失败`) : '0 失败'}，${skipped} 跳过`);
  for (const r of bad) console.log(red(`  ✗ ${r.label}: ${r.error}`));
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((err) => {
  console.error(red(`e2e 脚本异常: ${err?.stack ?? err}`));
  process.exitCode = 1;
});
