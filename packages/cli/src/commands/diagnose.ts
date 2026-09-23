import type { AvdManager, InstanceState } from '@avdm/core';
import type { Command } from 'commander';
import { c, failMark, okMark, warnMark } from '../ui/colors.js';
import { assertRunning, instanceStates, out, printJson, withManager } from '../runtime.js';
import { padEnd } from '../ui/table.js';
import { formatRam, glDriverLabel } from '../util/format.js';
import { parseSingleIndex } from '../util/parse.js';

/**
 * `avdm diagnose <index> [package]` — game-compatibility check of a running instance:
 * Android/ABI, GLES version + driver, ASTC, Vulkan, RAM, and (optionally) an installed package's ABI and recent crashes.
 * Read-only: it only runs getprop / dumpsys / pm / ls / logcat -d inside the guest.
 * Manager methods: indices, list (via instanceStates), device (AdbDevice.shell).
 */

type Level = 'ok' | 'warn' | 'fail' | 'info';

interface Check {
  id: string;
  level: Level;
  title: string;
  detail: string;
  hint?: string;
}

interface GuestFacts {
  android: string;
  sdk: string;
  abiList: string[];
  abiList32: string[];
  glesVersion?: string;
  eglDriver: string;
  glRenderer?: string;
  astc: boolean;
  vulkanVersion?: string;
  memTotalMb?: number;
}

interface PackageFacts {
  name: string;
  installed: boolean;
  versionName?: string;
  primaryCpuAbi?: string;
  nativeAbis: string[];
  running: boolean;
  recentCrash: string[];
}

const SEP = '__AVDM_SEP__';

/** ro.opengles.version is major<<16 | minor (196608 → 3.0, 196609 → 3.1). */
export function decodeGlesVersion(raw: string): string | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return `${n >> 16}.${n & 0xffff}`;
}

/** android.hardware.vulkan.version is VK_MAKE_VERSION: major<<22 | minor<<12 | patch (4206592 → 1.3.0). */
export function decodeVulkanVersion(raw: string): string | undefined {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return `${n >>> 22}.${(n >>> 12) & 0x3ff}.${n & 0xfff}`;
}

function sections(text: string): string[] {
  return text.split(SEP).map((s) => s.replace(/\r/g, '').trim());
}

function listProp(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function probeGuest(manager: AvdManager, index: number): Promise<GuestFacts> {
  const dev = await manager.device(index);
  const cmd = [
    'getprop ro.build.version.release',
    'getprop ro.build.version.sdk',
    'getprop ro.product.cpu.abilist',
    'getprop ro.product.cpu.abilist32',
    'getprop ro.opengles.version',
    'getprop ro.hardware.egl',
    "dumpsys SurfaceFlinger | grep -m1 '^GLES:'",
    "dumpsys SurfaceFlinger | grep -c 'GL_KHR_texture_compression_astc_ldr'",
    "pm list features | grep 'android.hardware.vulkan.version' | cut -d= -f2",
    "grep MemTotal /proc/meminfo | tr -s ' ' | cut -d' ' -f2",
  ].join(`; echo ${SEP}; `);
  const s = sections(await dev.shell(cmd, { timeoutMs: 20_000 }));
  const memKb = Number.parseInt(s[9] ?? '', 10);
  return {
    android: s[0] ?? '',
    sdk: s[1] ?? '',
    abiList: listProp(s[2]),
    abiList32: listProp(s[3]),
    glesVersion: decodeGlesVersion(s[4] ?? ''),
    eglDriver: s[5] ?? '',
    glRenderer: (s[6] ?? '').replace(/^GLES:\s*/, '') || undefined,
    astc: Number.parseInt(s[7] ?? '0', 10) > 0,
    vulkanVersion: decodeVulkanVersion(s[8] ?? ''),
    memTotalMb: Number.isFinite(memKb) ? Math.round(memKb / 1024) : undefined,
  };
}

async function probePackage(manager: AvdManager, index: number, pkg: string): Promise<PackageFacts> {
  if (!/^[A-Za-z0-9_.]+$/.test(pkg)) {
    return { name: pkg, installed: false, nativeAbis: [], running: false, recentCrash: [] };
  }
  const dev = await manager.device(index);
  const cmd = [
    `dumpsys package ${pkg} | grep -m1 versionName= | cut -d= -f2`,
    `dumpsys package ${pkg} | grep -m1 primaryCpuAbi= | cut -d= -f2`,
    `p=$(pm path ${pkg} | head -1 | cut -d: -f2); [ -n "$p" ] && ls "$(dirname "$p")/lib" 2>/dev/null`,
    `pidof ${pkg}`,
    `logcat -d -b crash 2>/dev/null | grep -A8 "Process: ${pkg}" | tail -12`,
  ].join(`; echo ${SEP}; `);
  const s = sections(await dev.shell(cmd, { timeoutMs: 20_000 }));
  const versionName = s[0] || undefined;
  const primary = s[1] && s[1] !== 'null' ? s[1] : undefined;
  return {
    name: pkg,
    installed: versionName !== undefined,
    versionName,
    primaryCpuAbi: primary,
    nativeAbis: (s[2] ?? '').split(/\s+/).filter(Boolean),
    running: /\d/.test(s[3] ?? ''),
    recentCrash: (s[4] ?? '').split('\n').filter(Boolean),
  };
}

export function evaluate(st: InstanceState, g: GuestFacts, p?: PackageFacts): Check[] {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const i = st.record.index;

  add({ id: 'android', level: 'info', title: '系统', detail: `Android ${g.android}（API ${g.sdk}）` });

  const has32 = g.abiList32.length > 0;
  add({
    id: 'abi',
    level: 'info',
    title: 'CPU 架构',
    detail: `${g.abiList.join(', ') || '未知'}${has32 ? '' : '（不支持 32 位应用：Apple Silicon 无 AArch32）'}`,
  });

  const gles = g.glesVersion ? Number.parseFloat(g.glesVersion) : 0;
  const driver = g.eglDriver === 'angle' ? 'ANGLE' : g.eglDriver === 'emulation' ? '翻译层' : g.eglDriver || '未知';
  if (gles >= 3.1) {
    add({ id: 'gles', level: 'ok', title: 'OpenGL ES', detail: `${g.glesVersion}（${driver}）${g.glRenderer ? ` — ${g.glRenderer}` : ''}` });
  } else {
    add({
      id: 'gles',
      level: 'warn',
      title: 'OpenGL ES',
      detail: `${g.glesVersion ?? '未知'}（${driver}）${g.glRenderer ? ` — ${g.glRenderer}` : ''}`,
      hint:
        st.record.spec.gpuMode === 'software'
          ? '软件渲染下只有 GLES 3.0；游戏请改用硬件加速：avdm set ' + i + ' --gpu host --gl angle（需先停止）'
          : `很多 Unity 游戏需要 GLES 3.1（否则提示“设备不支持”）：avdm stop ${i} && avdm set ${i} --gl angle && avdm start ${i}`,
    });
  }
  add({
    id: 'astc',
    level: g.astc ? 'ok' : 'warn',
    title: 'ASTC 纹理',
    detail: g.astc ? '支持' : '不支持',
    hint: g.astc ? undefined : '多数手游使用 ASTC 纹理；ANGLE 驱动下可用（--gl angle）',
  });
  add({ id: 'vulkan', level: g.vulkanVersion ? 'ok' : 'warn', title: 'Vulkan', detail: g.vulkanVersion ?? '不可用' });
  if (g.memTotalMb !== undefined) {
    add({
      id: 'memory',
      level: g.memTotalMb < 3500 ? 'warn' : 'ok',
      title: '客体内存',
      detail: `${formatRam(g.memTotalMb)}（配置 ${formatRam(st.record.spec.ramMb)}）`,
      hint: g.memTotalMb < 3500 ? `大型游戏建议 ≥ 4G：avdm set ${i} --ram 4096（需先停止）` : undefined,
    });
  }

  if (p) {
    if (!p.installed) {
      add({ id: 'package', level: 'fail', title: '应用', detail: `${p.name} 未安装`, hint: `avdm install ${i} <apk>` });
    } else {
      const only32 = !p.primaryCpuAbi?.includes('64') && p.nativeAbis.some((a) => a === 'arm' || a.includes('armeabi'));
      add({
        id: 'package',
        level: only32 ? 'fail' : 'ok',
        title: '应用',
        detail: `${p.name} ${p.versionName ?? ''}，ABI ${p.primaryCpuAbi ?? '（无原生库）'}${p.nativeAbis.length ? `，lib/${p.nativeAbis.join(',')}` : ''}${p.running ? '，运行中' : ''}`,
        hint: only32 ? '该安装包只有 32 位原生库，Apple Silicon 上无法运行；请换带 arm64-v8a 的安装包' : undefined,
      });
      if (p.recentCrash.length) {
        add({ id: 'crash', level: 'warn', title: '最近崩溃', detail: p.recentCrash.slice(0, 6).join('\n    ') });
      }
    }
  }
  return checks;
}

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose <index> [package]')
    .description('游戏兼容性诊断：GLES/ASTC/Vulkan/架构/内存，以及指定应用的 ABI 与最近崩溃（只读）')
    .option('--json', '输出 JSON')
    .action(async (sel: string, pkg: string | undefined, opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const index = parseSingleIndex(sel, await ctx.manager.indices());
        const st = assertRunning(await instanceStates(ctx.manager), index);
        const guest = await probeGuest(ctx.manager, index);
        const app = pkg ? await probePackage(ctx.manager, index, pkg) : undefined;
        const checks = evaluate(st, guest, app);
        if (ctx.json) {
          printJson({ index, glDriver: st.record.spec.glDriver ?? 'angle', guest, package: app, checks });
          return;
        }
        const p = c();
        out(p.bold(`#${index} ${st.record.name}`) + p.gray(`  规格 GLES 驱动: ${glDriverLabel(st.record.spec)}`));
        for (const ch of checks) {
          const mark = ch.level === 'ok' ? okMark() : ch.level === 'warn' ? warnMark() : ch.level === 'fail' ? failMark() : p.gray('•');
          out(`${mark} ${padEnd(ch.title, 10)} ${ch.detail}`);
          if (ch.hint) out(p.gray(`    → ${ch.hint}`));
        }
      });
    });
}
