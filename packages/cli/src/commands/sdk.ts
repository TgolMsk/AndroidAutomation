import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  AvdmError,
  DEFAULT_SDK_PACKAGES,
  compareVersions,
  findInstalledImage,
  listSystemImages,
  selectArchive,
} from '@avdm/core';
import type { InstalledImage, RemotePackage, SdkInfo, SdkInstallPlan } from '@avdm/core';
import type { Command } from 'commander';
import { c, ce, failMark, okMark, warnMark } from '../ui/colors.js';
import { formatBytes, SdkProgressReporter } from '../ui/progress.js';
import { confirm, pageText } from '../ui/prompt.js';
import { interactiveOutput } from '../ui/terminal.js';
import { renderKeyValues, renderTable } from '../ui/table.js';
import type { Column } from '../ui/table.js';
import { abortable, CancelledError, debugLog, note, out, printJson, withManager } from '../runtime.js';
import type { CommandContext } from '../runtime.js';
import { installedRevision } from '../util/files.js';

/**
 * `avdm sdk images | install | status`.
 * Manager methods: fetchCatalog, getSdk, refreshSdk, getSettings, planSdkInstall, acceptLicenses,
 * installSdkPackages (+ 'sdk-progress' events), paths.home.
 */

export function safeFindImage(sdk: SdkInfo, pkgPath: string): InstalledImage | undefined {
  try {
    return findInstalledImage(sdk, pkgPath);
  } catch (err) {
    debugLog('findInstalledImage', err);
    return sdk.images.find((img) => img.packagePath === pkgPath);
  }
}

function archiveSize(pkg: RemotePackage): number | undefined {
  try {
    return selectArchive(pkg)?.size;
  } catch (err) {
    debugLog('selectArchive', err);
    return pkg.archives[0]?.size;
  }
}

export function registerSdkCommands(program: Command): void {
  const sdk = program.command('sdk').description('Android SDK 组件管理：images | install | status');

  // ── sdk images ──
  sdk
    .command('images')
    .description('列出 Google 仓库中可用的 arm64 系统镜像（标记已安装）')
    .option('--preview', '包含预览版（beta/dev/canary 通道）')
    .option('--json', '输出 JSON')
    .action(async (opts: { preview?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json, interruptible: true }, async (ctx) => {
        const { manager } = ctx;
        note(ctx, '正在获取 Google SDK 仓库清单…');
        const catalog = await abortable(manager.fetchCatalog(), ctx.signal);
        const images = listSystemImages(catalog, { allowPreview: Boolean(opts.preview) });
        const info = await manager.getSdk();
        const defaultImage = manager.getSettings().defaultImage;
        const rows = images.map((pkg) => {
          const inst = safeFindImage(info, pkg.path);
          const upgradable = Boolean(inst?.revision && compareVersions(inst.revision, pkg.revision) < 0);
          return { pkg, inst, upgradable, size: archiveSize(pkg), isDefault: pkg.path === defaultImage };
        });
        if (ctx.json) {
          printJson(
            rows.map(({ pkg, inst, upgradable, size, isDefault }) => ({
              path: pkg.path,
              displayName: pkg.displayName,
              apiLevel: pkg.apiLevel,
              tagId: pkg.tagId,
              tagDisplay: pkg.tagDisplay,
              abi: pkg.abi,
              revision: pkg.revision,
              channel: pkg.channel,
              licenseId: pkg.licenseId,
              size,
              installed: Boolean(inst),
              installedRevision: inst?.revision,
              upgradable,
              default: isDefault,
            })),
          );
          return;
        }
        if (rows.length === 0) {
          out('没有找到适用于本机的 arm64 系统镜像');
          return;
        }
        const p = c();
        const cols: Array<Column<(typeof rows)[number]>> = [
          { header: '包路径', get: (r) => r.pkg.path },
          { header: 'API', get: (r) => r.pkg.apiLevel ?? '', align: 'right' },
          { header: '类型', get: (r) => r.pkg.tagDisplay ?? r.pkg.tagId ?? '', maxWidth: 28 },
          { header: '版本', get: (r) => r.pkg.revision + (r.pkg.channel !== 'channel-0' ? ` (${channelLabel(r.pkg.channel)})` : '') },
          { header: '大小', get: (r) => formatBytes(r.size), align: 'right' },
          {
            header: '状态',
            get: (r) =>
              [r.inst ? (r.upgradable ? `可升级（已装 ${r.inst.revision}）` : '已安装') : '', r.isDefault ? '默认' : '']
                .filter(Boolean)
                .join(' · '),
            style: (text, r) => (r.inst ? (r.upgradable ? p.yellow(text) : p.green(text)) : p.gray(text)),
          },
        ];
        out(renderTable(rows, cols, { headerStyle: p.bold }));
        out(p.gray(`安装: avdm sdk install "<包路径>"；默认镜像: ${defaultImage}`));
      });
    });

  // ── sdk install ──
  sdk
    .command('install [pkg...]')
    .description('下载并安装 SDK 组件（默认: emulator、platform-tools 及设置中的默认镜像 defaultImage）')
    .option('--accept-licenses', '不逐条询问，直接同意所需的 SDK 许可（表示你已阅读并同意）')
    .option('--force', '即使已是最新版本也重新安装')
    .option('--json', '输出 JSON（需配合 --accept-licenses 或许可已接受）')
    .action(async (pkgs: string[], opts: { acceptLicenses?: boolean; force?: boolean; json?: boolean }) => {
      await withManager({ json: opts.json, interruptible: true }, (ctx) => sdkInstall(ctx, pkgs, opts));
    });

  // ── sdk status ──
  sdk
    .command('status')
    .description('查看已安装的 SDK 组件')
    .option('--json', '输出 JSON')
    .action(async (opts: { json?: boolean }) => {
      await withManager({ json: opts.json }, async (ctx) => {
        const { manager } = ctx;
        const info = await manager.refreshSdk();
        const settings = manager.getSettings();
        const platformTools = info.exists ? await installedRevision(info.root, 'platform-tools') : undefined;
        const defaultInstalled = Boolean(safeFindImage(info, settings.defaultImage));
        if (ctx.json) {
          printJson({ ...info, platformToolsRevision: platformTools, defaultImage: settings.defaultImage, defaultImageInstalled: defaultInstalled });
          return;
        }
        const p = c();
        const missing = p.red('未安装');
        out(
          renderKeyValues(
            [
              ['SDK 根目录', `${info.root} ${info.exists ? '' : p.red('（不存在）')}`.trimEnd()],
              ['emulator', info.emulator ? `${info.emulator.version ?? '版本未知'}  ${p.gray(info.emulator.bin)}` : missing],
              [
                'platform-tools',
                info.adb ? `${platformTools || info.adb.version || '版本未知'}  ${p.gray(info.adb.bin)}` : missing,
              ],
              ['已接受许可', info.acceptedLicenses.length ? info.acceptedLicenses.join(', ') : p.gray('无')],
              ['默认镜像', `${settings.defaultImage} ${defaultInstalled ? p.green('已安装') : p.yellow('未安装')}`],
            ],
            { keyStyle: p.bold },
          ),
        );
        out('');
        if (info.images.length === 0) {
          out(p.yellow('未安装任何系统镜像'));
        } else {
          out(p.bold(`系统镜像（${info.images.length}）:`));
          const cols: Array<Column<InstalledImage>> = [
            { header: '包路径', get: (i) => i.packagePath },
            { header: 'API', get: (i) => i.apiLevel, align: 'right' },
            { header: '类型', get: (i) => i.tagDisplay || i.tagId, maxWidth: 28 },
            { header: '版本', get: (i) => i.revision ?? '-' },
          ];
          out(renderTable(info.images, cols, { headerStyle: p.bold, indent: 2 }));
        }
        if (!info.emulator || !info.adb || !defaultInstalled) {
          out(p.gray('\n提示: 运行 `avdm sdk install` 安装缺少的组件'));
        }
      });
    });
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'channel-1':
      return 'beta';
    case 'channel-2':
      return 'dev';
    case 'channel-3':
      return 'canary';
    default:
      return channel;
  }
}

interface PlanRow {
  pkg: RemotePackage;
  size: number | undefined;
  /** undefined = not installed; '' = installed, unknown revision. */
  installed: string | undefined;
  action: 'install' | 'upgrade' | 'reinstall' | 'skip';
}

async function planRows(info: SdkInfo, plan: SdkInstallPlan, force: boolean): Promise<PlanRow[]> {
  const rows: PlanRow[] = [];
  for (const pkg of plan.packages) {
    let installed: string | undefined;
    if (info.exists) {
      installed = await installedRevision(info.root, pkg.path);
      if (installed === undefined && pkg.path === 'emulator' && info.emulator) installed = info.emulator.version ?? '';
      if (installed === undefined && pkg.path.startsWith('system-images;')) {
        const img = safeFindImage(info, pkg.path);
        if (img) installed = img.revision ?? '';
      }
    }
    let action: PlanRow['action'];
    if (installed === undefined) action = 'install';
    else if (installed !== '' && compareVersions(installed, pkg.revision) < 0) action = 'upgrade';
    else action = force ? 'reinstall' : 'skip';
    rows.push({ pkg, size: archiveSize(pkg), installed, action });
  }
  return rows;
}

function actionLabel(row: PlanRow): string {
  switch (row.action) {
    case 'install':
      return '新安装';
    case 'upgrade':
      return `升级（${row.installed} → ${row.pkg.revision}）`;
    case 'reinstall':
      return '重新安装';
    case 'skip':
      return '已是最新，跳过';
  }
}

async function sdkInstall(
  ctx: CommandContext,
  pkgs: string[],
  opts: { acceptLicenses?: boolean; force?: boolean },
): Promise<void> {
  const { manager, signal } = ctx;
  const p = c();
  // Default set: DEFAULT_SDK_PACKAGES, with the image replaced by the configured default image.
  const defaults = DEFAULT_SDK_PACKAGES.filter((p) => !p.startsWith('system-images;'));
  const requested = pkgs.length ? pkgs : [...defaults, manager.getSettings().defaultImage];

  note(ctx, '正在获取 Google SDK 仓库清单…');
  const plan = await abortable(manager.planSdkInstall(requested), signal);
  if (plan.missing.length) {
    throw new AvdmError(
      'INVALID_ARGUMENT',
      `以下组件在 Google 仓库中不存在或没有适用于本机的稳定版: ${plan.missing.join(', ')}（可用 \`avdm sdk images\` 查看镜像）`,
    );
  }
  const info = await manager.refreshSdk();
  const rows = await planRows(info, plan, Boolean(opts.force));
  const todo = rows.filter((r) => r.action !== 'skip');
  const totalBytes = todo.reduce((sum, r) => sum + (r.size ?? 0), 0);

  if (!ctx.json) {
    out(p.bold(`SDK 目录: ${info.root}`));
    const cols: Array<Column<PlanRow>> = [
      { header: '组件', get: (r) => r.pkg.path },
      { header: '版本', get: (r) => r.pkg.revision },
      { header: '大小', get: (r) => formatBytes(r.size), align: 'right' },
      {
        header: '操作',
        get: actionLabel,
        style: (text, r) => (r.action === 'skip' ? p.gray(text) : r.action === 'upgrade' ? p.yellow(text) : p.cyan(text)),
      },
    ];
    out(renderTable(rows, cols, { headerStyle: p.bold, indent: 2 }));
  }
  if (todo.length === 0) {
    if (ctx.json) printJson({ installed: [], skipped: rows.map((r) => r.pkg.path), acceptedLicenses: [] });
    else out(p.green('所有组件均已是最新，无需安装（加 --force 可强制重新安装）'));
    return;
  }
  if (!ctx.json) out(`合计下载: ${p.bold(formatBytes(totalBytes))}`);

  // ── licenses: shown in full and explicitly accepted before anything is downloaded ──
  const needed = [...new Set(todo.map((r) => r.pkg.licenseId).filter(Boolean))];
  const unaccepted = needed.filter((id) => plan.unaccepted.includes(id));
  if (unaccepted.length) {
    if (opts.acceptLicenses) {
      const saved = await saveLicenseTexts(manager.paths.home, unaccepted, plan.licenses);
      if (!ctx.json) {
        out(`${warnMark(p)} 已通过 --accept-licenses 同意以下 SDK 许可: ${p.bold(unaccepted.join(', '))}`);
        if (saved) out(p.gray(`  许可全文已保存到 ${saved}`));
      }
    } else {
      // The full text and the question must reach the user's eyes: with stdout redirected
      // (`avdm sdk install > install.log`) they go to stderr; with no terminal at all we refuse.
      const term = ctx.json ? undefined : interactiveOutput();
      if (!term) {
        throw new AvdmError(
          'LICENSE_NOT_ACCEPTED',
          `需要同意 SDK 许可: ${unaccepted.join(', ')}。请在交互终端中运行 \`avdm sdk install\` 阅读许可全文，或阅读后加 --accept-licenses`,
        );
      }
      const tp = term === process.stdout ? c() : ce();
      for (const id of unaccepted) {
        const text = plan.licenses[id];
        if (!text) throw new AvdmError('LICENSE_NOT_ACCEPTED', `仓库清单中缺少许可 ${id} 的全文，无法继续`);
        term.write('\n' + tp.bold(`══════ 许可协议: ${id} ══════`) + '\n');
        await pageText(text.trim(), { output: term });
        term.write(tp.bold(`══════ 许可协议 ${id} 结束 ══════`) + '\n');
        if (signal.aborted) throw new CancelledError('已取消');
        const ok = await confirm(`是否接受许可 ${id}？[y/N] `, { output: term, signal });
        if (signal.aborted) throw new CancelledError('已取消');
        if (!ok) throw new AvdmError('LICENSE_NOT_ACCEPTED', `未接受许可 ${id}，已取消安装`);
      }
    }
    await manager.acceptLicenses(unaccepted, plan.licenses);
  }

  // ── download + install ──
  const reporter = ctx.json ? undefined : new SdkProgressReporter(process.stderr);
  const onProgress = (e: Parameters<SdkProgressReporter['handle']>[0]) => reporter?.handle(e);
  manager.on('sdk-progress', onProgress);
  if (!ctx.json) note(ctx, '开始下载（Ctrl-C 取消，已下载部分会保留以便续传）');
  try {
    await manager.installSdkPackages(
      todo.map((r) => r.pkg.path),
      { signal },
    );
  } finally {
    manager.off('sdk-progress', onProgress);
    reporter?.stop();
  }
  if (signal.aborted) throw new CancelledError('已取消');

  const after = await manager.getSdk();
  if (ctx.json) {
    printJson({
      installed: todo.map((r) => r.pkg.path),
      skipped: rows.filter((r) => r.action === 'skip').map((r) => r.pkg.path),
      acceptedLicenses: unaccepted,
      sdk: after,
    });
    return;
  }
  out(`${okMark(p)} 安装完成（${todo.length} 个组件）`);
  if (!after.emulator) out(`${failMark(p)} 仍未检测到 emulator，请运行 \`avdm doctor\` 检查`);
  out(p.gray('下一步: avdm doctor 体检，然后 avdm create 创建实例'));
}

/** Keep a copy of license texts accepted non-interactively so the user can read them later. */
async function saveLicenseTexts(home: string, ids: string[], texts: Record<string, string>): Promise<string | undefined> {
  const dir = path.join(home, 'licenses');
  try {
    await fsp.mkdir(dir, { recursive: true });
    for (const id of ids) {
      const text = texts[id];
      if (text) await fsp.writeFile(path.join(dir, `${id}.txt`), text.trim() + '\n');
    }
    return dir;
  } catch (err) {
    debugLog('saveLicenseTexts', err);
    return undefined;
  }
}
