import { promises as fsp } from 'node:fs';
import { AvdmError, MAX_INSTANCES, consolePortFor } from '@avdm/core';
import type { CreateOptions, DeviceIdentityInput, InstanceRecord, InstanceSpec, InstanceState, UpdateOptions } from '@avdm/core';
import { Option } from 'commander';
import type { Command } from 'commander';
import { c, ce, colorStatus, statusLabel } from '../ui/colors.js';
import { confirm } from '../ui/prompt.js';
import { interactiveOutput } from '../ui/terminal.js';
import { renderTable } from '../ui/table.js';
import type { Column } from '../ui/table.js';
import {
  instanceStates,
  note,
  out,
  printJson,
  resolveSelector,
  runBatch,
  withManager,
} from '../runtime.js';
import { errorSummary, imageSummary, publicState, specDetail, specSummary } from '../util/format.js';
import {
  GPU_MODES,
  GL_DRIVERS,
  gigabytes,
  intInRange,
  megabytes,
  parseSingleIndex,
  resolution,
} from '../util/parse.js';

/**
 * Instance CRUD: create, clone, list/ls, set, rm.
 * Manager methods: create, clone, list, indices, update, remove, batch, registry.list.
 */

interface SpecFlags {
  cores?: number;
  ram?: number;
  res?: { width: number; height: number };
  dpi?: number;
  data?: number;
  gpu?: InstanceSpec['gpuMode'];
  gl?: NonNullable<InstanceSpec['glDriver']>;
}

interface IdentityFlags {
  identityRandom?: boolean;
  identityTemplate?: string;
  identitySystem?: boolean;
}

function addIdentityOptions(cmd: Command): Command {
  return cmd
    .addOption(new Option('--identity-random', '为每个实例生成随机序列号、Wi-Fi MAC 并轮换 Android ID').conflicts(['identityTemplate', 'identitySystem']))
    .addOption(new Option('--identity-template <文件>', '从 JSON 模板设置 serialNumber / wifiMac / androidId / build').conflicts(['identityRandom', 'identitySystem']))
    .addOption(new Option('--identity-system', '停止托管标识（已写入的 Android ID 不回滚）').conflicts(['identityRandom', 'identityTemplate']));
}

async function identityInput(opts: IdentityFlags): Promise<DeviceIdentityInput | undefined> {
  if (opts.identityRandom) return 'random';
  if (opts.identitySystem) return 'system';
  if (!opts.identityTemplate) return undefined;
  try {
    return JSON.parse(await fsp.readFile(opts.identityTemplate, 'utf8')) as DeviceIdentityInput;
  } catch (err) {
    throw new AvdmError('INVALID_ARGUMENT', `读取设备标识模板失败：${String(err)}`);
  }
}

function specPatch(flags: SpecFlags): Partial<InstanceSpec> {
  const spec: Partial<InstanceSpec> = {};
  if (flags.cores !== undefined) spec.cpuCores = flags.cores;
  if (flags.ram !== undefined) spec.ramMb = flags.ram;
  if (flags.res) {
    spec.width = flags.res.width;
    spec.height = flags.res.height;
  }
  if (flags.dpi !== undefined) spec.dpi = flags.dpi;
  if (flags.data !== undefined) spec.dataPartitionGb = flags.data;
  if (flags.gpu !== undefined) spec.gpuMode = flags.gpu;
  if (flags.gl !== undefined) spec.glDriver = flags.gl;
  return spec;
}

function addSpecOptions(cmd: Command): Command {
  return cmd
    .option('--cores <n>', 'CPU 核数（默认取设置 defaultSpec，下同）', intInRange(1, 16))
    .option('--ram <MB>', '内存，如 3072 或 4G', megabytes)
    .option('--res <宽x高>', '分辨率，如 1280x720（横屏）或 720x1280（竖屏）', resolution)
    .option('--dpi <n>', '屏幕密度', intInRange(120, 640))
    .option('--data <GB>', '数据分区大小（GB）', gigabytes)
    .addOption(new Option('--gpu <模式>', 'GPU 渲染模式').choices(GPU_MODES))
    .addOption(
      new Option('--gl <驱动>', 'GLES 驱动：angle（GLES 3.1 + ASTC，默认，多数游戏需要）| translator（GLES 3.0，旧方式）').choices(GL_DRIVERS),
    );
}

function recordsTable(records: InstanceRecord[]): string {
  const p = c();
  const cols: Array<Column<InstanceRecord>> = [
    { header: '#', get: (r) => String(r.index), align: 'right' },
    { header: '名称', get: (r) => r.name, maxWidth: 24 },
    { header: 'ADB', get: (r) => `emulator-${consolePortFor(r.index)}` },
    { header: '设备序列号', get: (r) => r.identity?.serialNumber ?? '-' },
    { header: 'Wi-Fi MAC', get: (r) => r.identity?.wifiMac ?? '-' },
    { header: '规格', get: (r) => specSummary(r.spec) },
    { header: '镜像', get: (r) => imageSummary(r.image) },
  ];
  return renderTable(records, cols, { headerStyle: p.bold });
}

export function registerInstanceCommands(program: Command): void {
  // ── create ──
  addIdentityOptions(addSpecOptions(
    program
      .command('create')
      .description('从系统镜像新建实例')
      .option('-n, --count <n>', '创建数量', intInRange(1, MAX_INSTANCES), 1)
      .option('--name <前缀>', '名称前缀，实例命名为 <前缀>-<编号>（默认“实例”）')
      .option('--image <包路径>', '系统镜像包路径（默认取设置 defaultImage）'),
  ))
    .option('--window', '启动时显示模拟器窗口（默认无窗口）')
    .option('--cold-boot', '每次冷启动（不使用快照）')
    .option('--auto-restart', '崩溃后由 monitor 自动重启')
    .option('--json', '输出 JSON')
    .action(async (opts: SpecFlags & IdentityFlags & {
      count: number;
      name?: string;
      image?: string;
      window?: boolean;
      coldBoot?: boolean;
      autoRestart?: boolean;
      json?: boolean;
    }) => {
      // Mutating: a Ctrl-C lets core finish or roll back (records stuck in "准备中" otherwise).
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const spec = specPatch(opts);
        if (opts.window) spec.headless = false;
        if (opts.coldBoot) spec.bootMode = 'cold';
        const createOpts: CreateOptions = { count: opts.count, spec };
        if (opts.name !== undefined) createOpts.namePrefix = opts.name;
        if (opts.image !== undefined) createOpts.image = opts.image;
        if (opts.autoRestart) createOpts.autoRestart = true;
        createOpts.identity = await identityInput(opts);
        note(ctx, `正在创建 ${opts.count} 个实例…`);
        const records = await ctx.manager.create(createOpts);
        if (ctx.json) {
          printJson(records);
          return;
        }
        out(c().green(`已创建 ${records.length} 个实例`));
        out(recordsTable(records));
        const first = records[0];
        if (first) {
          out(c().gray(`规格: ${specDetail(first.spec)}`));
          const sel = records.length === 1 ? String(first.index) : `${first.index}-${records[records.length - 1]!.index}`;
          out(c().gray(`启动: avdm start ${sel} --wait`));
        }
      });
    });

  // ── clone ──
  addIdentityOptions(program
    .command('clone <src>')
    .description('克隆一个已停止的实例（APFS 写时复制，数据一并复制）')
    .option('-n, --count <n>', '克隆数量', intInRange(1, MAX_INSTANCES), 1)
    .option('--name <前缀>', '名称前缀（默认“实例”）')
    .option('--keep-snapshots', '保留快速启动快照（默认丢弃，首次冷启动）'))
    .option('--json', '输出 JSON')
    .action(async (src: string, opts: IdentityFlags & { count: number; name?: string; keepSnapshots?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const index = parseSingleIndex(src, await ctx.manager.indices());
        note(ctx, `正在克隆 #${index} × ${opts.count}…`);
        const records = await ctx.manager.clone(index, {
          count: opts.count,
          ...(opts.name !== undefined ? { namePrefix: opts.name } : {}),
          keepSnapshots: Boolean(opts.keepSnapshots),
          identity: await identityInput(opts),
        });
        if (ctx.json) {
          printJson(records);
          return;
        }
        out(c().green(`已从 #${index} 克隆 ${records.length} 个实例`));
        out(recordsTable(records));
      });
    });

  // ── list ──
  program
    .command('list')
    .alias('ls')
    .description('列出所有实例及状态')
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const states = await ctx.manager.list();
        if (ctx.json) {
          printJson(states.map(publicState));
          return;
        }
        printStateTable(states, ctx.manager.getSettings().maxRunning);
      });
    });

  // ── set ──
  addIdentityOptions(addSpecOptions(
    program
      .command('set <sel>')
      .description('修改实例名称/备注/规格（规格变更需实例已停止）')
      .option('--name <名称>', '新名称（选中多个实例时命名为 <名称>-<编号>）')
      .option('--notes <备注>', '备注（传空字符串清除）'),
  ))
    .addOption(new Option('--window', '启动时显示窗口').conflicts('headless'))
    .option('--headless', '启动时不显示窗口')
    .addOption(new Option('--cold-boot', '每次冷启动').conflicts('quickBoot'))
    .option('--quick-boot', '使用快速启动快照')
    .option('--auto-restart', '崩溃后自动重启')
    .option('--no-auto-restart', '关闭崩溃自动重启')
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: SpecFlags & IdentityFlags & {
      name?: string;
      notes?: string;
      window?: boolean;
      headless?: boolean;
      coldBoot?: boolean;
      quickBoot?: boolean;
      autoRestart?: boolean;
      json?: boolean;
    }) => {
      const spec = specPatch(opts);
      if (opts.window) spec.headless = false;
      if (opts.headless) spec.headless = true;
      if (opts.coldBoot) spec.bootMode = 'cold';
      if (opts.quickBoot) spec.bootMode = 'quick';
      const base: UpdateOptions = {};
      if (opts.notes !== undefined) base.notes = opts.notes;
      if (opts.autoRestart !== undefined) base.autoRestart = opts.autoRestart;
      if (Object.keys(spec).length > 0) base.spec = spec;
      base.identity = await identityInput(opts);
      if (base.identity === undefined) delete base.identity;
      if (opts.name === undefined && Object.keys(base).length === 0) {
        throw new AvdmError('INVALID_ARGUMENT', '未指定任何要修改的项（见 avdm set --help）');
      }
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const indices = await resolveSelector(ctx.manager, sel);
        await runBatch(
          ctx,
          indices,
          (index) => {
            const update: UpdateOptions = { ...base };
            if (opts.name !== undefined) update.name = indices.length > 1 ? `${opts.name}-${index}` : opts.name;
            return ctx.manager.update(index, update);
          },
          {
            label: '修改',
            concurrency: 4,
            describe: (rec) => c().gray(`${opts.name !== undefined ? `→ ${rec.name}  ` : ''}${specSummary(rec.spec)}`),
          },
        );
      });
    });

  // ── rm ──
  program
    .command('rm <sel>')
    .description('删除实例及其全部数据（不可恢复）')
    .option('--force', '实例运行中时先强制停止再删除')
    .option('-y, --yes', '不再确认')
    .option('--json', '输出 JSON')
    .action(async (sel: string, opts: { force?: boolean; yes?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json, mutating: true }, async (ctx) => {
        const indices = await resolveSelector(ctx.manager, sel);
        if (indices.length > 0 && !opts.yes) {
          // Ask where the user can see it (stderr when stdout is redirected); never prompt blind.
          const term = ctx.json ? undefined : interactiveOutput();
          if (!term) {
            throw new AvdmError('INVALID_ARGUMENT', '非交互模式下删除实例需加 -y 确认');
          }
          const tp = term === process.stdout ? c() : ce();
          const states = await instanceStates(ctx.manager);
          term.write(tp.bold(`将删除以下 ${indices.length} 个实例（AVD 数据将被永久删除）:`) + '\n');
          for (const i of indices) {
            const st = states.get(i);
            term.write(`  #${i} ${st?.record.name ?? ''} ${st ? colorStatus(st.status, statusLabel(st.status), tp) : ''}\n`);
          }
          const ok = await confirm('确认删除？[y/N] ', { output: term, signal: ctx.signal });
          if (!ok) {
            term.write('已取消\n');
            process.exitCode = ctx.signal.aborted ? 130 : 1;
            return;
          }
        }
        await runBatch(ctx, indices, (index) => ctx.manager.remove(index, { force: Boolean(opts.force) }), {
          label: '删除',
          concurrency: 3,
          describe: () => '已删除',
          toJson: () => null,
        });
      });
    });
}

/** The `list` table distinguishes the adb transport from the guest serial number. */
export function printStateTable(states: InstanceState[], maxRunning?: number): void {
  const p = c();
  if (states.length === 0) {
    out('暂无实例。使用 `avdm create` 创建，例如: avdm create -n 2');
    return;
  }
  const hasNotes = states.some((s) => s.record.notes);
  const cols: Array<Column<InstanceState>> = [
    { header: '#', get: (s) => String(s.record.index), align: 'right' },
    { header: '名称', get: (s) => s.record.name, maxWidth: 24 },
    {
      header: '状态',
      get: (s) => (s.record.provisioning ? '准备中' : statusLabel(s.status)),
      style: (text, s) => (s.record.provisioning ? p.yellow(text) : colorStatus(s.status, text, p)),
    },
    { header: 'ADB', get: (s) => s.ports.serial },
    { header: '设备序列号', get: (s) => s.record.identity?.serialNumber ?? '-' },
    { header: 'Wi-Fi MAC', get: (s) => s.record.identity?.wifiMac ?? '-' },
    { header: '规格', get: (s) => specSummary(s.record.spec) },
    { header: '镜像', get: (s) => imageSummary(s.record.image) },
    { header: 'pid', get: (s) => (s.pid ? String(s.pid) : '-'), align: 'right' },
  ];
  if (hasNotes) cols.push({ header: '备注', get: (s) => s.record.notes ?? '', maxWidth: 30 });
  out(renderTable(states, cols, { headerStyle: p.bold }));

  for (const s of states) {
    const i = s.record.index;
    if (s.status === 'error' && s.error) {
      out(p.red(`  #${i} 异常: ${errorSummary(s.error)}`) + p.gray(`（详见 avdm logs ${i}）`));
    }
    if (s.record.provisioning) {
      out(p.yellow(`  #${i} 准备中: 正在创建或克隆；若该操作已中断（没有 avdm/桌面端仍在创建），可用 avdm rm ${i} -y 删除后重建`));
    }
  }
  const running = states.filter((s) => s.status === 'running').length;
  const transitional = states.filter((s) => ['starting', 'booting', 'stopping'].includes(s.status)).length;
  const failed = states.filter((s) => s.status === 'error').length;
  out(
    p.gray(
      `共 ${states.length} 个实例，运行中 ${running} 个` +
        (transitional ? `，启动/停止中 ${transitional} 个` : '') +
        (failed ? `，异常 ${failed} 个` : '') +
        (maxRunning ? `（最多同时运行 ${maxRunning} 个）` : ''),
    ),
  );
}
