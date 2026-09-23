import { MIN_EMULATOR_VERSION, accelCheck, compareVersions, expectedResidentMb } from '@avdm/core';
import type { AvdManager, SdkInfo } from '@avdm/core';
import type { Command } from 'commander';
import { c, failMark, okMark, warnMark } from '../ui/colors.js';
import { StatusLine } from '../ui/progress.js';
import { displayWidth, padEnd } from '../ui/table.js';
import { debugLog, markFailed, out, printJson, withManager } from '../runtime.js';
import { errorMessage, firstLine } from '../util/format.js';
import { findExecutable } from '../util/files.js';
import { safeFindImage } from './sdk.js';

/**
 * `avdm doctor`: environment health check.
 * Manager methods: refreshSdk, getSettings, hostStats, registry.list, paths; core helpers accelCheck, compareVersions.
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
  hint?: string;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

async function runChecks(manager: AvdManager, progress: (label: string) => void): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const add = (r: CheckResult) => checks.push(r);
  const guard = async (id: string, title: string, fn: () => Promise<void>) => {
    progress(title);
    try {
      await fn();
    } catch (err) {
      debugLog(`doctor ${id}`, err);
      add({ id, level: 'fail', title, detail: `检查失败: ${firstLine(errorMessage(err))}` });
    }
  };
  const settings = manager.getSettings();

  // Platform
  {
    const { platform, arch } = process;
    if (platform === 'darwin' && arch === 'arm64') {
      add({ id: 'platform', level: 'ok', title: '平台', detail: 'macOS / Apple Silicon (arm64)' });
    } else if (platform === 'darwin') {
      add({
        id: 'platform',
        level: 'warn',
        title: '平台',
        detail: `macOS / ${arch}（Node 可能运行在 Rosetta 下）`,
        hint: '请使用 arm64 原生 Node 运行 avdm，否则无法使用 HVF 硬件加速',
      });
    } else {
      add({
        id: 'platform',
        level: 'warn',
        title: '平台',
        detail: `${platform} / ${arch}`,
        hint: '本工具主要面向 Apple Silicon macOS，其他平台为尽力支持',
      });
    }
  }
  add({ id: 'home', level: 'ok', title: '管理器目录', detail: manager.paths.home });

  let sdk: SdkInfo | undefined;
  await guard('sdk', 'Android SDK', async () => {
    sdk = await manager.refreshSdk();
    if (sdk.exists) add({ id: 'sdk', level: 'ok', title: 'Android SDK', detail: sdk.root });
    else
      add({
        id: 'sdk',
        level: 'fail',
        title: 'Android SDK',
        detail: `未找到 SDK 目录 ${sdk.root}`,
        hint: '运行 `avdm sdk install` 自动安装，或 `avdm settings set sdkRoot <路径>` 指向已有 SDK',
      });
  });

  await guard('emulator', 'Emulator', async () => {
    const emu = sdk?.emulator;
    if (!emu) {
      add({ id: 'emulator', level: 'fail', title: 'Emulator', detail: '未安装', hint: '运行 `avdm sdk install emulator`' });
      return;
    }
    if (!emu.version) {
      add({
        id: 'emulator',
        level: 'warn',
        title: 'Emulator',
        detail: `无法读取版本（${emu.bin}）`,
        hint: '运行 `avdm sdk install emulator --force` 重新安装',
      });
    } else if (compareVersions(emu.version, MIN_EMULATOR_VERSION) < 0) {
      add({
        id: 'emulator',
        level: 'fail',
        title: 'Emulator',
        detail: `${emu.version} 低于要求的 ${MIN_EMULATOR_VERSION}（旧版在 macOS 26 上有 HVF 内存泄漏）`,
        hint: '运行 `avdm sdk install emulator` 升级',
      });
    } else {
      add({ id: 'emulator', level: 'ok', title: 'Emulator', detail: `${emu.version}（≥ ${MIN_EMULATOR_VERSION}）` });
    }
  });

  await guard('adb', 'adb', async () => {
    const adb = sdk?.adb;
    if (!adb) {
      add({ id: 'adb', level: 'fail', title: 'adb', detail: '未安装', hint: '运行 `avdm sdk install platform-tools`' });
      return;
    }
    add({ id: 'adb', level: 'ok', title: 'adb', detail: adb.version ? `${adb.version}` : adb.bin });
  });

  await guard('accel', '硬件加速', async () => {
    if (!sdk?.emulator) {
      add({ id: 'accel', level: 'warn', title: '硬件加速', detail: '未安装 emulator，跳过检查' });
      return;
    }
    const res = await accelCheck(sdk);
    const summary = firstLine(res.output.split(/\r?\n/).find((l) => /hypervisor|hvf|kvm|whpx|usable/i.test(l)) ?? res.output);
    if (res.ok) add({ id: 'accel', level: 'ok', title: '硬件加速', detail: summary || 'HVF 可用' });
    else
      add({
        id: 'accel',
        level: 'fail',
        title: '硬件加速',
        detail: summary || '不可用',
        hint: '确认在 Apple Silicon 上以原生 arm64 运行，且未在不支持嵌套虚拟化的虚拟机中',
      });
  });

  await guard('images', '系统镜像', async () => {
    const images = sdk?.images ?? [];
    if (images.length === 0) {
      add({ id: 'images', level: 'fail', title: '系统镜像', detail: '未安装任何镜像', hint: '运行 `avdm sdk install`' });
    } else {
      const names = images.map((i) => `${i.platform}/${i.tagId}`).join(', ');
      add({ id: 'images', level: 'ok', title: '系统镜像', detail: `${images.length} 个: ${names}` });
    }
    const def = settings.defaultImage;
    if (sdk && safeFindImage(sdk, def)) {
      add({ id: 'default-image', level: 'ok', title: '默认镜像', detail: `${def} 已安装` });
    } else {
      add({
        id: 'default-image',
        level: 'fail',
        title: '默认镜像',
        detail: `${def} 未安装`,
        hint: `运行 \`avdm sdk install "${def}"\`，或 \`avdm settings set defaultImage <包路径>\` 改用已安装镜像`,
      });
    }
  });

  await guard('licenses', 'SDK 许可', async () => {
    const accepted = sdk?.acceptedLicenses ?? [];
    if (accepted.length) add({ id: 'licenses', level: 'ok', title: 'SDK 许可', detail: `已接受 ${accepted.join(', ')}` });
    else
      add({ id: 'licenses', level: 'warn', title: 'SDK 许可', detail: '尚未接受任何许可', hint: '`avdm sdk install` 会展示许可全文并询问' });
  });

  await guard('host', '主机资源', async () => {
    const host = await manager.hostStats();
    // Same model as start() admission: an instance is charged its expected resident size, not its configured RAM.
    const perInstance = expectedResidentMb(settings.defaultSpec.ramMb);
    const need = perInstance + settings.memoryReserveMb;
    const pressure = host.memoryPressure ? `，内存压力 ${pressureLabel(host.memoryPressure)}` : '';
    const memDetail = `可用 ${gb(host.availableMemMb)} / 共 ${gb(host.totalMemMb)}，实例已占用 ${gb(host.committedInstanceRamMb)}${pressure}`;
    if (host.memoryPressure === 'critical') {
      add({ id: 'memory', level: 'fail', title: '内存', detail: memDetail, hint: '内存压力严重，请停止部分实例或关闭其他应用' });
    } else if (host.memoryPressure === 'warn' || host.availableMemMb < need) {
      add({
        id: 'memory',
        level: 'warn',
        title: '内存',
        detail: memDetail,
        hint: `再启动一个默认规格实例需约 ${gb(need)} 可用内存（预计常驻 ${gb(perInstance)} + 保留 ${gb(settings.memoryReserveMb)}）`,
      });
    } else {
      const more = Math.floor((host.availableMemMb - settings.memoryReserveMb) / perInstance);
      add({ id: 'memory', level: 'ok', title: '内存', detail: `${memDetail}；约还可启动 ${more} 个默认规格实例` });
    }
    const load = host.loadAvg[0];
    const loadDetail = `${load.toFixed(2)} / ${host.cpuCount} 核（${host.cpuModel}）`;
    if (load > host.cpuCount) add({ id: 'load', level: 'warn', title: '负载', detail: loadDetail, hint: '主机负载较高，启动更多实例会变慢' });
    else add({ id: 'load', level: 'ok', title: '负载', detail: loadDetail });

    const records = await manager.registry.list();
    const running = host.runningInstances;
    const level: CheckLevel = running >= settings.maxRunning ? 'warn' : 'ok';
    add({
      id: 'instances',
      level,
      title: '实例',
      detail: `${records.length} 个，运行中 ${running} / 上限 ${settings.maxRunning}`,
      ...(level === 'warn' ? { hint: '已达最大运行数，可 `avdm settings set maxRunning <n>` 调整' } : {}),
    });
  });

  await guard('scrcpy', 'scrcpy', async () => {
    const found = await findExecutable('scrcpy', settings.scrcpyPath || undefined);
    if (found) add({ id: 'scrcpy', level: 'ok', title: 'scrcpy', detail: found });
    else if (settings.scrcpyPath)
      add({
        id: 'scrcpy',
        level: 'warn',
        title: 'scrcpy',
        detail: `设置的路径不可执行: ${settings.scrcpyPath}`,
        hint: '`avdm settings set scrcpyPath ""` 恢复自动查找',
      });
    else
      add({
        id: 'scrcpy',
        level: 'warn',
        title: 'scrcpy',
        detail: '未找到（可选，`avdm view` 需要）',
        hint: '`brew install scrcpy`，或 `avdm settings set scrcpyPath <路径>`',
      });
  });

  return checks;
}

function pressureLabel(p: 'normal' | 'warn' | 'critical'): string {
  return p === 'normal' ? '正常' : p === 'warn' ? '偏高' : '严重';
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('环境体检：SDK / emulator 版本 / adb / HVF / 镜像 / 主机资源 / scrcpy')
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const status = new StatusLine(process.stderr, Boolean(process.stderr.isTTY) && !ctx.json);
        let checks: CheckResult[];
        try {
          checks = await runChecks(ctx.manager, (label) => status.update(c().gray(`正在检查 ${label}…`)));
        } finally {
          status.done();
        }
        const failed = checks.filter((r) => r.level === 'fail').length;
        const warned = checks.filter((r) => r.level === 'warn').length;
        if (failed) markFailed();
        if (ctx.json) {
          printJson({ ok: failed === 0, checks });
          return;
        }
        const p = c();
        const titleWidth = Math.max(...checks.map((r) => displayWidth(r.title)));
        for (const r of checks) {
          const mark = r.level === 'ok' ? okMark(p) : r.level === 'warn' ? warnMark(p) : failMark(p);
          out(`${mark} ${p.bold(padEnd(r.title, titleWidth))}  ${r.detail}`);
          if (r.hint && r.level !== 'ok') out(p.gray(`    → ${r.hint}`));
        }
        out('');
        const passed = checks.length - failed - warned;
        const summary = `体检完成：${passed} 项通过，${warned} 项警告，${failed} 项失败`;
        out(failed ? p.red(summary) : warned ? p.yellow(summary) : p.green(summary));
      });
    });
}
