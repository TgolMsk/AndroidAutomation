import { mkdir, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DoctorCheck } from '@avdm/core';
import type { HealthItem, HealthLevel, HealthReport } from '../../shared/ipc';
import type { HealthWorkerOutput } from './health-worker';

/** One probe may take this long before it is reported as failed (original: 10 s per external command). */
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;
/** The emulator checks include `emulator -accel-check` (up to 30 s on its own). */
export const HEALTH_ENVIRONMENT_TIMEOUT_MS = 45_000;
/** `adb start-server` spawns the daemon on a cold start (core allows it 30 s). */
export const HEALTH_ADB_SERVER_TIMEOUT_MS = 30_000;
/** OpenCV's WASM runtime can take a while to compile on a cold start. */
export const HEALTH_OPENCV_TIMEOUT_MS = 60_000;
/** Disk needed for one more instance (a cloned AVD with its data and a Quick Boot snapshot, rounded up). */
export const INSTANCE_DISK_COST_BYTES = 4 * 1024 ** 3;

/** Doctor checks that are only advisory for the assistant (it clones existing instances; a blank one is optional). */
const SOFT_ENVIRONMENT_CHECKS = new Set<string>(['default-image']);

export interface HealthInstance {
  index: number;
  name: string;
  width: number;
  height: number;
}

export interface HealthTemplateTarget {
  index: number;
  /** Loads the instance's template set (throws when it is unreadable); null when none is configured. */
  load: () => Promise<{ templates: number; name: string } | null>;
}

export interface HealthDeps {
  home: string;
  /** Shared host / SDK / emulator checks (`runDoctorChecks(manager, { audience: 'app' })`). */
  environment: () => Promise<DoctorCheck[]>;
  /** AVD instances with their configured display size. */
  instances: () => Promise<HealthInstance[]>;
  /** Templates and coordinates are authored for this size (the game plugin's reference size). */
  referenceSize: { width: number; height: number };
  /** Instances with automatic gather enabled or configured: each needs a usable template set. */
  templateTargets: () => Promise<HealthTemplateTarget[]>;
  /**
   * `adb start-server` with the SDK's adb (original `checkAdbServer`): a daemon of another adb version on 5037
   * (Android Studio, another emulator) makes every device call fail although adb itself is installed.
   */
  adbServer?: () => Promise<void>;
  /** Initializes OpenCV off the main thread. */
  opencv?: () => Promise<{ version: string | null; ms: number }>;
  /** libvips version of the loaded sharp. */
  sharp?: () => Promise<string>;
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  diskCostBytes?: number;
  now?: () => number;
  probeTimeoutMs?: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    timer.unref?.();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function item(key: string, label: string, level: HealthLevel, detail: string, hint?: string, group: HealthItem['group'] = 'assistant'): HealthItem {
  return { key, label, level, ok: level !== 'fail', detail, ...(hint ? { hint } : {}), group };
}

/** Run one assistant probe: a throw or a timeout becomes a failed line with the Chinese hint. */
async function settle(
  key: string, label: string, timeoutMs: number, hint: string, probe: () => Promise<HealthItem>, group: HealthItem['group'] = 'assistant',
): Promise<HealthItem> {
  try {
    return await withTimeout(probe(), timeoutMs, label);
  } catch (error) {
    const text = message(error);
    // System errors arrive in English: keep them, but lead with a Chinese sentence.
    return item(key, label, 'fail', /[\u4e00-\u9fa5]/.test(text) ? text : `检查失败：${text}`, hint, group);
  }
}

const ADB_SERVER_LABEL = 'adb 服务（127.0.0.1:5037）';
const ADB_SERVER_HINT = process.platform === 'win32'
  ? '退出占用 5037 端口的其他模拟器或 Android Studio，或在 PowerShell 执行 `taskkill /F /IM adb.exe`，然后点「重新自检」'
  : '退出占用 5037 端口的其他模拟器或 Android Studio，或在终端执行 `adb kill-server`，然后点「重新自检」';

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Resolution warnings for instances whose display does not suit the 2560×1440 reference templates. */
export function resolutionProblems(instances: readonly HealthInstance[], reference: { width: number; height: number }): string[] {
  const problems: string[] = [];
  const refLandscape = reference.width >= reference.height;
  const refRatio = reference.width / reference.height;
  for (const instance of instances) {
    const { width, height } = instance;
    if (!(width > 0 && height > 0)) continue;
    const who = `实例 #${instance.index}「${instance.name}」${width}×${height}`;
    const landscape = width >= height;
    // Android renders a landscape game rotated on a portrait panel: compare the panel's long / short sides.
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const ratio = long / short;
    const refLong = Math.max(reference.width, reference.height);
    const refShort = Math.min(reference.width, reference.height);
    if (Math.abs(ratio - refRatio) / refRatio > 0.01) {
      const d = gcd(refLong, refShort);
      problems.push(`${who} 与参考分辨率 ${reference.width}×${reference.height}（${refLong / d}:${refShort / d}）比例不一致，模板会错位`);
    } else if (long < refLong * 0.75 || short < refShort * 0.75) {
      problems.push(`${who} 分辨率偏低，数字识别可能不可靠（建议 ${reference.width}×${reference.height}，至少 1920×1080）`);
    } else if (landscape !== refLandscape) {
      problems.push(`${who} 是${landscape ? '横' : '竖'}屏面板，与参考方向不一致；若截图也是${landscape ? '横' : '竖'}屏，模板会错位`);
    }
  }
  return problems;
}

/**
 * The assistant's environment self-check (original `runHealthCheck`). Never throws: every probe is isolated and
 * time-limited, and each failing line carries a 「我现在该做什么」 hint. The first part is the shared emulator
 * doctor (`avdm doctor`); the second part checks what only the assistant needs.
 */
export async function runAssistantHealthCheck(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeout = deps.probeTimeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const items: HealthItem[] = [];

  try {
    const checks = await withTimeout(deps.environment(), HEALTH_ENVIRONMENT_TIMEOUT_MS, '模拟器环境检查');
    for (const check of checks) {
      const soft = SOFT_ENVIRONMENT_CHECKS.has(check.id) && check.level === 'fail';
      const hint = soft ? `${check.hint ? `${check.hint}；` : ''}只影响新建空白实例，从基础实例克隆不受影响` : check.hint;
      items.push(item(`env:${check.id}`, check.title, soft ? 'warn' : check.level, check.detail, hint, 'environment'));
    }
  } catch (error) {
    items.push(item('env:manager', '模拟器管理器', 'fail', `无法完成模拟器环境检查：${message(error)}`,
      '请先打开「AVD 多开管理器」确认它能正常列出实例，并已完成 Android 运行环境安装', 'environment'));
  }

  if (deps.adbServer) {
    const adbServer = deps.adbServer;
    const adbMissing = items.some((entry) => entry.key === 'env:adb' && entry.level === 'fail');
    items.push(adbMissing
      ? item('adbServer', ADB_SERVER_LABEL, 'fail', 'adb 不可用，先解决上面的「adb」一项', undefined, 'environment')
      : await settle('adbServer', ADB_SERVER_LABEL, HEALTH_ADB_SERVER_TIMEOUT_MS, ADB_SERVER_HINT, async () => {
        try { await adbServer(); }
        catch (error) {
          throw new Error(`adb start-server 失败：${message(error)}\n常见原因是 5037 端口被别的 adb（例如 Android Studio 自带的、或另一个模拟器的）占用且版本不一致。`,
            { cause: error });
        }
        return item('adbServer', ADB_SERVER_LABEL, 'ok', 'adb 服务已在运行', undefined, 'environment');
      }, 'environment'));
  }

  items.push(await settle('instances', '实例分辨率', timeout, '请确认「AVD 多开管理器」能正常列出实例', async () => {
    const instances = await deps.instances();
    if (instances.length === 0) return item('instances', '实例分辨率', 'ok', '还没有实例；在「设备与账号 → 模拟器实例」或多开管理器里新建');
    const problems = resolutionProblems(instances, deps.referenceSize);
    if (problems.length === 0) {
      return item('instances', '实例分辨率', 'ok', `共 ${instances.length} 个实例，分辨率与参考 ${deps.referenceSize.width}×${deps.referenceSize.height} 相符`);
    }
    return item('instances', '实例分辨率', 'warn', problems.join('\n'),
      `在「AVD 多开管理器」里停止实例后把显示改成 ${deps.referenceSize.width}×${deps.referenceSize.height}（或至少 1920×1080），再重新启动`);
  }));

  // Listing the targets gets one probe timeout, then every target is loaded in parallel under its own timeout, so
  // the outer limit is two probe timeouts however many instances there are.
  items.push(await settle('templates', '模板集', timeout * 2 + 1_000, '到「脚本与模板 → 模板库」为该实例选择或导入模板集', async () => {
    const targets = await withTimeout(deps.templateTargets(), timeout, '启用采集的实例列表读取');
    if (targets.length === 0) return item('templates', '模板集', 'ok', '没有启用自动采集的实例，跳过检查');
    const good: string[] = [];
    const bad: string[] = [];
    const results = await Promise.all(targets.map(async (target) => {
      try { return { target, set: await withTimeout(target.load(), timeout, `实例 #${target.index} 的模板集读取`) }; }
      catch (error) { return { target, error }; }
    }));
    for (const result of results.sort((a, b) => a.target.index - b.target.index)) {
      const { target } = result;
      if ('error' in result) bad.push(`实例 #${target.index} 的模板集无法读取：${message(result.error)}`);
      else if (!result.set) bad.push(`实例 #${target.index} 还没有选择模板集`);
      else if (result.set.templates === 0) bad.push(`实例 #${target.index} 的模板集「${result.set.name}」是空的`);
      else good.push(`实例 #${target.index}「${result.set.name}」${result.set.templates} 张`);
    }
    if (bad.length > 0) {
      return item('templates', '模板集', 'fail', [...bad, ...good].join('\n'),
        '到「脚本与模板 → 模板库」为这些实例选择或导入模板集（可用「导入旧版模板集」合并原面板的模板）');
    }
    return item('templates', '模板集', 'ok', good.join('\n'));
  }));

  items.push(await settle('dataDir', '助手数据目录可写', timeout, '请修复该目录的权限，或设置 AVDM_HOME 指向一个有写权限的目录后重启', async () => {
    const dir = path.join(deps.home, 'automation');
    const probe = path.join(dir, `.write-probe-${process.pid}-${now()}`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(probe, String(now()), { mode: 0o600 });
      await unlink(probe);
    } catch (error) {
      throw new Error(`无法写入：${dir}（${message(error)}）`, { cause: error });
    }
    return item('dataDir', '助手数据目录可写', 'ok', dir);
  }));

  items.push(await settle('opencv', '视觉引擎（OpenCV WASM）', HEALTH_OPENCV_TIMEOUT_MS,
    '请重新安装万龙助手；开发环境请在仓库根目录执行 pnpm install', async () => {
      const result = await (deps.opencv ?? probeOpencvInWorker)();
      return item('opencv', '视觉引擎（OpenCV WASM）', 'ok',
        `已在工作线程完成初始化${result.version ? `（OpenCV ${result.version}）` : ''}，耗时 ${(result.ms / 1000).toFixed(1)} 秒；主进程不加载 WASM`);
    }));

  items.push(await settle('sharp', '图像处理（sharp / libvips）', timeout,
    `本机需要 ${process.platform}-${process.arch} 的预编译包（@img/sharp-${process.platform}-${process.arch}）；请重新安装万龙助手，或在开发环境执行 pnpm install`,
    async () => item('sharp', '图像处理（sharp / libvips）', 'ok', `libvips ${await (deps.sharp ?? sharpVersion)()}`)));

  items.push(await settle('disk', '磁盘余量', timeout, '请确认数据目录所在的磁盘可以访问', async () => {
    const st = await (deps.statfs ?? statfs)(deps.home);
    const available = Number(st.bavail) * Number(st.bsize);
    const cost = deps.diskCostBytes ?? INSTANCE_DISK_COST_BYTES;
    return available >= cost
      ? item('disk', '磁盘余量', 'ok', `剩余 ${gb(available)}，够再克隆一个实例（每个约 ${gb(cost)}）`)
      : item('disk', '磁盘余量', 'fail', `仅剩 ${gb(available)}，不足以再克隆一个实例（每个约需 ${gb(cost)}）`,
        '请清理磁盘，或删除不用的模拟器实例后重试');
  }));

  return { ok: items.every((entry) => entry.ok), checkedAt: now(), durationMs: Math.max(0, now() - startedAt), items };
}

async function sharpVersion(): Promise<string> {
  const mod = await import('sharp');
  const sharp = (mod.default ?? mod) as unknown as { versions?: Record<string, string> };
  return sharp.versions?.['vips'] ?? '未知版本';
}

/** Spawn `health-worker.js` (a sibling of the bundled main file, as for the other workers) and wait for its answer. */
export function probeOpencvInWorker(): Promise<{ version: string | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'health-worker.js');
    let worker: Worker;
    try { worker = new Worker(entry); }
    catch (error) { reject(new Error(`无法启动自检工作线程：${message(error)}`)); return; }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('OpenCV 初始化超时'))), HEALTH_OPENCV_TIMEOUT_MS);
    timer.unref?.();
    worker.once('message', (output: HealthWorkerOutput) => finish(() => {
      if (output.ok) resolve({ version: output.version, ms: output.ms });
      else reject(new Error(`OpenCV 初始化失败：${output.error}`));
    }));
    worker.once('error', (error) => finish(() => reject(new Error(`自检工作线程出错：${message(error)}`))));
    worker.once('exit', (code) => finish(() => reject(new Error(`自检工作线程已退出 (${code})`))));
  });
}

/**
 * Holds the latest report and coalesces concurrent runs (a click on 「重新自检」 while the startup check is still
 * running joins it instead of starting a second one).
 */
export class AppHealth {
  private latest: HealthReport | null = null;
  private running: Promise<HealthReport> | null = null;

  constructor(private readonly run: () => Promise<HealthReport>, private readonly emit: (report: HealthReport) => void = () => undefined) {}

  last(): HealthReport | null {
    return this.latest ? structuredClone(this.latest) : null;
  }

  check(): Promise<HealthReport> {
    this.running ??= (async () => {
      try {
        const report = await this.run();
        this.latest = report;
        try { this.emit(structuredClone(report)); }
        catch { /* A closed window must not fail the check. */ }
        return structuredClone(report);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

/** 「环境自检发现 N 个问题：A、B」 for the startup toast, or null when everything passed. */
export function healthProblemSummary(report: HealthReport): string | null {
  const bad = report.items.filter((entry) => !entry.ok);
  if (bad.length === 0) return null;
  return `环境自检发现 ${bad.length} 个问题：${bad.map((entry) => entry.label).join('、')}`;
}
