/**
 * Port of wanlong-panel `scripts/update-offline-check.ts` sections 二–五: the whole check → download → install state
 * machine with a fake `UpdaterPort`. No network, no packaging, no Electron.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateProgress, UpdateState } from '../src/shared/update';
import { UpdateCenter, UpdateError, describe as describeError, type UpdateRelease, type UpdaterPort } from '../src/main/update/center';
import { UpdateService } from '../src/main/update';

function release(version: string, extra: Partial<UpdateRelease> = {}): UpdateRelease {
  return {
    version,
    releaseNotes: null,
    releaseUrl: null,
    prerelease: false,
    publishedAt: null,
    asset: { name: `Wanlong-Assistant-${version}-mac-arm64.dmg`, size: 1000, url: 'https://example.invalid/asset' },
    checksumsUrl: 'https://example.invalid/SHA256SUMS',
    ...extra,
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Fake updater: controllable check/download, counters for opens and reveals. */
function makeWorld() {
  let check: UpdaterPort['check'] = async () => null;
  let download: UpdaterPort['download'] = async (item) => `/downloads/${item.asset.name}`;
  let verify: UpdaterPort['verify'] = async () => undefined;
  let progress: ((p: UpdateProgress) => void) | null = null;
  let signal: AbortSignal | null = null;
  const world = {
    opens: 0,
    reveals: 0,
    checks: 0,
    setCheck(fn: UpdaterPort['check']) { check = fn; },
    setDownload(fn: UpdaterPort['download']) { download = fn; },
    setVerify(fn: UpdaterPort['verify']) { verify = fn; },
    emitProgress(p: UpdateProgress) { progress?.(p); },
    get signal() { return signal; },
    port: {
      check: () => { world.checks += 1; return check(); },
      download: (item, options) => { progress = options.onProgress; signal = options.signal; return download(item, options); },
      verify: (file, item) => verify(file, item),
      open: async () => { world.opens += 1; },
      reveal: async () => { world.reveals += 1; },
    } satisfies UpdaterPort,
  };
  return world;
}

interface Env {
  packaged?: boolean;
  supported?: boolean;
  busy?: string | null;
  version?: string;
  publish?: (state: UpdateState) => void;
}

function makeCenter(world: ReturnType<typeof makeWorld>, env: Env = {}) {
  const published: UpdateState[] = [];
  const opened: string[] = [];
  let quits = 0;
  const updater = vi.fn(() => world.port);
  const center = new UpdateCenter();
  const state = { busy: env.busy ?? null };
  center.init({
    currentVersion: () => env.version ?? '0.3.0',
    packaged: () => env.packaged ?? true,
    supportedPlatform: () => env.supported ?? true,
    busy: () => state.busy,
    releasePageUrl: () => 'https://github.com/TgolMsk/AndroidAutomation/releases/latest',
    openExternal: async (url) => { opened.push(url); },
    updater,
    quit: () => { quits += 1; },
    publish: env.publish ?? ((s) => published.push(s)),
    log: () => undefined,
  });
  return { center, published, opened, updater, state, quits: () => quits };
}

async function ready(env: Env = {}) {
  const world = makeWorld();
  const made = makeCenter(world, env);
  world.setCheck(async () => release('0.4.0'));
  await made.center.check();
  await made.center.download();
  return { world, ...made };
}

describe('二、不支持的环境', () => {
  it('短路开发模式，且绝不去查（也不会构造更新器）', async () => {
    const world = makeWorld();
    const { center, updater } = makeCenter(world, { packaged: false });
    expect(center.getState().phase).toBe('unsupported');
    expect(center.getState().unsupportedReason).toBe('dev');
    await center.check();
    expect(world.checks).toBe(0);
    expect(updater).not.toHaveBeenCalled();
    expect(center.supported).toBe(false);
  });

  it('没有对应系统的安装包时报 platform，同样不查', async () => {
    const world = makeWorld();
    const { center, updater } = makeCenter(world, { supported: false });
    expect(center.getState().unsupportedReason).toBe('platform');
    expect((await center.check()).phase).toBe('unsupported');
    expect(updater).not.toHaveBeenCalled();
  });

  it('未初始化时动作给出中文原因', async () => {
    const center = new UpdateCenter('0.3.0');
    expect(center.getState()).toMatchObject({ phase: 'idle', currentVersion: '0.3.0', installable: true });
    await expect(center.check()).rejects.toThrow('更新中心还没初始化。');
  });
});

describe('三、检查更新', () => {
  it('发现新版本：记下版本号、说明、地址、检查时刻，每次变化都推给面板', async () => {
    const world = makeWorld();
    const { center, published } = makeCenter(world);
    world.setCheck(async () => release('0.4.0', {
      releaseNotes: '修了几个 bug', releaseUrl: 'https://example.invalid/tag/v0.4.0', prerelease: true, publishedAt: 42,
    }));
    const state = await center.check();
    expect(state.phase).toBe('available');
    expect(state).toMatchObject({
      latestVersion: '0.4.0', releaseNotes: '修了几个 bug', releaseUrl: 'https://example.invalid/tag/v0.4.0',
      prerelease: true, publishedAt: 42, assetName: 'Wanlong-Assistant-0.4.0-mac-arm64.dmg', assetSize: 1000,
    });
    expect(state.checkedAt).toEqual(expect.any(Number));
    expect(state.checkedAt).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(published[0]?.phase).toBe('checking');
  });

  it('版本相同 = 已是最新，没给地址时退回 releases/latest', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world, { version: '0.4.0' });
    world.setCheck(async () => release('0.4.0'));
    const state = await center.check();
    expect(state.phase).toBe('latest');
    expect(state.releaseUrl?.endsWith('/releases/latest')).toBe(true);
  });

  it('线上比本地旧也算最新（不往回装），预览版不高于同号正式版', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world, { version: '0.9.0' });
    world.setCheck(async () => release('0.3.0'));
    expect((await center.check()).phase).toBe('latest');
    world.setCheck(async () => release('0.9.0-beta.1'));
    expect((await center.check()).phase).toBe('latest');
    await expect(center.download()).rejects.toThrow('先点「检查更新」');
  });

  it('网络不通 → error，错误翻成人话', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
    const state = await center.check();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('连不上 GitHub');
    expect(state.checkedAt).toEqual(expect.any(Number));
  });

  it('限流也有中文说法', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => { throw new Error('HTTP 403 rate limit exceeded'); });
    expect((await center.check()).error).toContain('限流');
  });

  it('查不到发布信息按「已是最新」处理，不报错', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => null);
    const state = await center.check();
    expect(state.phase).toBe('latest');
    expect(state.error).toBeNull();
  });

  it('检查中再点检查只返回当前状态，不重复请求', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    const gate = deferred<UpdateRelease | null>();
    world.setCheck(() => gate.promise);
    const first = center.check();
    expect((await center.check()).phase).toBe('checking');
    expect(world.checks).toBe(1);
    gate.resolve(release('0.4.0'));
    expect((await first).phase).toBe('available');
  });

  it('推送失败被吞掉，不影响检查', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world, { publish: () => { throw new Error('窗口没了'); } });
    world.setCheck(async () => release('0.4.0'));
    expect((await center.check()).phase).toBe('available');
  });
});

describe('四、下载', () => {
  it('没检查就下载会被拒绝并说清楚怎么做', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    const error = await center.download().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateError);
    expect((error as UpdateError).code).toBe('INVALID_ARGUMENT');
    expect((error as UpdateError).message).toContain('先点「检查更新」');
  });

  it('下载中推进度，下完停在「待安装」且不自动装', async () => {
    const world = makeWorld();
    const { center, quits } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    const gate = deferred<string>();
    world.setDownload(() => gate.promise);
    const pending = center.download();
    await Promise.resolve();
    expect(center.getState().phase).toBe('downloading');
    world.emitProgress({ percent: 42, transferred: 420, total: 1000, bytesPerSecond: 3e6 });
    expect(center.getState().progress?.percent).toBe(42);
    expect((await center.download()).phase).toBe('downloading');
    gate.resolve('/downloads/Wanlong-Assistant-0.4.0-mac-arm64.dmg');
    await pending;
    expect(center.getState()).toMatchObject({
      phase: 'downloaded', progress: null, downloadedFile: '/downloads/Wanlong-Assistant-0.4.0-mac-arm64.dmg',
    });
    expect(world.opens).toBe(0);
    expect(quits()).toBe(0);
    world.emitProgress({ percent: 99, transferred: 990, total: 1000, bytesPerSecond: 1 });
    expect(center.getState().progress).toBeNull();
  });

  it('★ 下载失败回到「有新版本」，不卡在「正在下载」，原因是中文', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    world.setDownload(async () => { throw new Error('ECONNRESET'); });
    const state = await center.download();
    expect(state.phase).toBe('available');
    expect(state.error).toContain('连不上 GitHub');
  });

  it('★ 中途断流（先有进度再失败）也收回 available', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    const gate = deferred<string>();
    world.setDownload(() => gate.promise);
    const pending = center.download();
    await Promise.resolve();
    world.emitProgress({ percent: 10, transferred: 100, total: 1000, bytesPerSecond: 1 });
    gate.reject(new Error('net::ERR_CONNECTION_RESET'));
    const state = await pending;
    expect(state.phase).toBe('available');
    expect(state.progress).toBeNull();
    expect(state.error).toContain('连不上 GitHub');
  });

  it('校验失败有中文说法', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    world.setDownload(async () => { throw new Error('sha256 mismatch：安装包校验失败'); });
    expect((await center.download()).error).toBe('下载的文件校验没通过，已丢弃，请重试。');
  });

  it('取消下载：中止信号传给更新器，回到 available 且不算失败', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    world.setDownload((_item, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const pending = center.download();
    await Promise.resolve();
    const state = await center.cancelDownload();
    expect(world.signal?.aborted).toBe(true);
    expect(state).toMatchObject({ phase: 'available', error: null, progress: null });
    await pending;
  });

  it('退出时中止进行中的下载并等它收尾', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    world.setCheck(async () => release('0.4.0'));
    await center.check();
    world.setDownload((_item, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    void center.download();
    await Promise.resolve();
    await center.dispose();
    expect(world.signal?.aborted).toBe(true);
    expect(center.getState().phase).toBe('available');
    expect((await center.check()).phase).toBe('available');
  });

  it('下载完再检查：原版行为，按新结果重新判定（可重新下载，更新器会复用已校验的文件）', async () => {
    const { world, center } = await ready();
    world.setCheck(async () => release('0.4.0'));
    const state = await center.check();
    expect(state).toMatchObject({ phase: 'available', downloadedFile: null });
  });
});

describe('五、安装闸门（最要紧的一节）', () => {
  it('下载完了就能装：复核 → 打开安装包 → 退出', async () => {
    const { world, center, quits } = await ready();
    expect(center.getState()).toMatchObject({ phase: 'downloaded', installable: true, busyReason: null });
    await center.install();
    expect(world.opens).toBe(1);
    expect(quits()).toBe(1);
    // A second click while the quit is on its way opens nothing again.
    await center.install();
    expect(world.opens).toBe(1);
    expect(quits()).toBe(1);
  });

  it('★ 有任务在跑：installable=false、说清是谁占着、强行安装被拒且绝不打开/退出', async () => {
    const { world, center, quits } = await ready({ busy: '实例 #0 正在运行脚本计划。' });
    expect(center.getState().installable).toBe(false);
    expect(center.getState().busyReason).toContain('实例 #0');
    const error = await center.install().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateError);
    expect((error as UpdateError).code).toBe('CONCURRENCY_LIMIT');
    expect((error as UpdateError).message).toContain('掐断');
    expect((error as UpdateError).message).toContain('实例 #0 正在运行脚本计划。');
    expect(world.opens).toBe(0);
    expect(quits()).toBe(0);
  });

  it('★ 复核期间有任务开始了：复核后再问一次，仍然拒绝', async () => {
    const { world, center, state, quits } = await ready();
    world.setVerify(async () => { state.busy = '实例 #2 正在登录账号。'; });
    await expect(center.install()).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    expect(world.opens).toBe(0);
    expect(quits()).toBe(0);
  });

  it('busyReason 每次读取都现算（任务状态随时在变）', async () => {
    const { center, state } = await ready();
    expect(center.getState().installable).toBe(true);
    state.busy = '正在安装 SDK 组件。';
    expect(center.getState()).toMatchObject({ installable: false, busyReason: '正在安装 SDK 组件。' });
    state.busy = null;
    expect(center.getState().installable).toBe(true);
  });

  it('还没下载就点安装会被拒绝并指路', async () => {
    const world = makeWorld();
    const { center, quits } = makeCenter(world);
    await expect(center.install()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('先点「下载更新」') });
    expect(world.opens).toBe(0);
    expect(quits()).toBe(0);
  });

  it('安装包被删或被改：退回 available 并给出中文原因，不退出', async () => {
    const { world, center, quits } = await ready();
    world.setVerify(async () => { throw new Error('下载好的安装包已被移走或删除，请重新下载。'); });
    await expect(center.install()).rejects.toThrow('已被移走或删除');
    expect(center.getState()).toMatchObject({ phase: 'available', downloadedFile: null });
    expect(world.opens).toBe(0);
    expect(quits()).toBe(0);
  });

  it('在访达中显示只在下载完成后可用', async () => {
    const world = makeWorld();
    const { center } = makeCenter(world);
    await expect(center.revealDownload()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const done = await ready();
    await done.center.revealDownload();
    expect(done.world.reveals).toBe(1);
  });

  it('打开 Release 页优先用检查到的版本页，否则发布列表', async () => {
    const world = makeWorld();
    const { center, opened } = makeCenter(world);
    await center.openReleasePage();
    world.setCheck(async () => release('0.4.0', { releaseUrl: 'https://github.com/TgolMsk/AndroidAutomation/releases/tag/v0.4.0' }));
    await center.check();
    await center.openReleasePage();
    expect(opened).toEqual([
      'https://github.com/TgolMsk/AndroidAutomation/releases/latest',
      'https://github.com/TgolMsk/AndroidAutomation/releases/tag/v0.4.0',
    ]);
  });
});

describe('describe()：错误中文化', () => {
  it.each([
    ['getaddrinfo EAI_AGAIN api.github.com', '连不上 GitHub'],
    ['fetch failed', '连不上 GitHub'],
    ['net::ERR_INTERNET_DISCONNECTED', '连不上 GitHub'],
    ['The operation was aborted due to timeout', '连不上 GitHub'],
    ['ETIMEDOUT：下载长时间没有收到数据', '连不上 GitHub'],
    ['HTTP 429 rate limit exceeded', '限流'],
    ['GitHub 请求失败（HTTP 404）', '没找到发布信息'],
    ['下载的文件大小与发布信息不符（checksum 无法通过），请稍后重试。', '校验没通过'],
  ])('%s', (raw, expected) => {
    expect(describeError(new Error(raw))).toContain(expected);
  });

  it('已经是中文的原因原样保留（缺 SHA256SUMS 不是「校验没通过」）', () => {
    const message = '这个版本的发布缺少校验文件 SHA256SUMS，无法确认安装包完好；请到 Release 页手动下载。';
    expect(describeError(new Error(message))).toBe(message);
    expect(describeError('奇怪的错误')).toBe('奇怪的错误');
  });
});

describe('UpdateService：启动后只自动查一次', () => {
  afterEach(() => { vi.useRealTimers(); });

  function deps(world: ReturnType<typeof makeWorld>, packaged = true) {
    return () => ({
      currentVersion: () => '0.3.0', packaged: () => packaged, supportedPlatform: () => true, busy: () => null,
      releasePageUrl: () => 'https://github.com/TgolMsk/AndroidAutomation/releases/latest',
      openExternal: async () => undefined, updater: () => world.port, quit: () => undefined, publish: () => undefined,
      log: () => undefined,
    });
  }

  it('30 秒后静默检查一次，只查不下', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const world = makeWorld();
    world.setCheck(async () => release('0.4.0'));
    const service = new UpdateService(deps(world));
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(world.checks).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.checks).toBe(1);
    expect(service.center.getState().phase).toBe('available');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(world.checks).toBe(1);
    expect(world.signal).toBeNull();
    await service.dispose();
  });

  it('开发模式、截图验证模式、以及退出后都不自动检查', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const world = makeWorld();
    const dev = new UpdateService(deps(world, false));
    dev.start();
    const screenshot = new UpdateService(deps(world), { autoCheck: false });
    screenshot.start();
    const disposed = new UpdateService(deps(world));
    disposed.start();
    await disposed.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.checks).toBe(0);
  });

  it('初始化失败不抛，界面仍能读到状态', () => {
    const service = new UpdateService(() => { throw new Error('boom'); });
    expect(service.center.getState().phase).toBe('idle');
    expect(service.center.supported).toBe(false);
  });
});
