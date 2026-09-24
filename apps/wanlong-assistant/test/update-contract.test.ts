/** Port of wanlong-panel `scripts/update-offline-check.ts` section 一 (version comparison) plus the renderer store. */
import { describe, expect, it, vi } from 'vitest';
import {
  UNSUPPORTED_TEXT, UPDATE_PHASES, UPDATE_PHASE_TEXT, compareVersions, formatBytes, formatSpeed, initialUpdateState, isNewer,
  updateAssetName, type UpdateState,
} from '../src/shared/update';
import { UPDATE_EVENTS, UPDATE_METHODS } from '../src/shared/ipc';
import { UPDATE_TONE, createUpdateStore, hasPendingUpdate, type UpdateClient } from '../src/renderer/views/update/update-store';

describe('一、版本比较', () => {
  it('按主 / 次 / 补丁号比较', () => {
    expect(compareVersions('0.2.2', '0.2.1')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('带 v 前缀也认', () => {
    expect(compareVersions('v0.2.2', '0.2.1')).toBeGreaterThan(0);
  });

  it('★ 预发布版小于同号正式版（别把人从 1.2.3 反向「更新」到 1.2.3-beta）', () => {
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
  });

  it('预发布之间按字典序', () => {
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.1')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.1')).toBe(0);
  });

  it('垃圾输入当 0.0.0，不猜', () => {
    expect(compareVersions('不是版本号', '0.0.1')).toBeLessThan(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });

  it('isNewer 只在真的更新时为 true', () => {
    expect(isNewer('0.2.2', '0.2.1')).toBe(true);
    expect(isNewer('0.2.1', '0.2.1')).toBe(false);
    expect(isNewer('0.2.0', '0.2.1')).toBe(false);
  });

  it('字节与速度格式化（十进制单位，与原版一致）', () => {
    expect(formatBytes(135_400_000)).toBe('135.4 MB');
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(1_500)).toBe('2 KB');
    expect(formatSpeed(2_500_000)).toBe('2.5 MB/s');
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(Number.NaN)).toBe('—');
    expect(formatSpeed(200)).toBe('1 KB/s');
  });
});

describe('契约', () => {
  it('八个阶段都有中文说法与色调，不支持的原因都有下一步', () => {
    expect(UPDATE_PHASES).toHaveLength(8);
    for (const phase of UPDATE_PHASES) {
      expect(UPDATE_PHASE_TEXT[phase]).toMatch(/\p{Script=Han}/u);
      expect(UPDATE_TONE[phase]).toBeTruthy();
    }
    expect(Object.keys(UPDATE_PHASE_TEXT).sort()).toEqual([...UPDATE_PHASES].sort());
    for (const text of Object.values(UNSUPPORTED_TEXT)) {
      expect(text.title).toMatch(/\p{Script=Han}/u);
      expect(text.detail).toMatch(/\p{Script=Han}/u);
    }
  });

  it('初始状态：未检查、可安装、什么都没下', () => {
    expect(initialUpdateState('0.3.0')).toMatchObject({
      phase: 'idle', currentVersion: '0.3.0', latestVersion: null, installable: true, busyReason: null, downloadedFile: null,
    });
  });

  it('安装包文件名与发布流程一致', () => {
    expect(updateAssetName('0.4.0')).toBe('Wanlong-Assistant-0.4.0-mac-arm64.dmg');
    expect(updateAssetName('v0.4.0-beta.1')).toBe('Wanlong-Assistant-0.4.0-beta.1-mac-arm64.dmg');
  });

  it('IPC 方法与事件名单', () => {
    expect([...UPDATE_METHODS]).toEqual([
      'updateState', 'updateCheck', 'updateDownload', 'updateCancelDownload', 'updateInstall', 'updateOpenReleasePage',
      'updateRevealDownload',
    ]);
    expect([...UPDATE_EVENTS]).toEqual(['update-changed']);
  });
});

function state(phase: UpdateState['phase'], extra: Partial<UpdateState> = {}): UpdateState {
  return { ...initialUpdateState('0.3.0'), phase, ...extra };
}

describe('侧栏红点', () => {
  it('只在真的有新版本时亮', () => {
    expect(hasPendingUpdate(null)).toBe(false);
    for (const phase of ['available', 'downloading', 'downloaded'] as const) expect(hasPendingUpdate(state(phase))).toBe(true);
    for (const phase of ['idle', 'checking', 'latest', 'unsupported'] as const) expect(hasPendingUpdate(state(phase))).toBe(false);
  });

  it('★ 检查失败不亮（常年断网或限流的挂机机器不能天天挂着红点）', () => {
    expect(hasPendingUpdate(state('error', { error: '连不上 GitHub' }))).toBe(false);
  });
});

function fakeClient(initial: UpdateState) {
  let listener: ((state: UpdateState) => void) | null = null;
  const off = vi.fn(() => { listener = null; });
  let read = Promise.resolve(initial);
  const client: UpdateClient = {
    updateState: vi.fn(() => read),
    on: vi.fn((_channel, fn) => { listener = fn; return off; }),
  };
  return {
    client, off,
    push(next: UpdateState) { listener?.(next); },
    setRead(promise: Promise<UpdateState>) { read = promise; },
  };
}

describe('更新状态仓库（渲染进程唯一一份）', () => {
  it('引用计数：第一个挂载的拉一次并订阅，最后一个卸载才退订', async () => {
    const fake = fakeClient(state('latest'));
    const store = createUpdateStore(fake.client);
    const releaseA = store.retain();
    const releaseB = store.retain();
    await vi.waitFor(() => expect(store.getSnapshot().state?.phase).toBe('latest'));
    expect(fake.client.updateState).toHaveBeenCalledTimes(1);
    expect(fake.client.on).toHaveBeenCalledTimes(1);
    releaseA();
    releaseA();
    expect(fake.off).not.toHaveBeenCalled();
    expect(store.holders()).toBe(1);
    releaseB();
    expect(fake.off).toHaveBeenCalledTimes(1);
    expect(store.holders()).toBe(0);
  });

  it('推送即更新，且比推送更早发出的读取结果不会把状态倒回去', async () => {
    const fake = fakeClient(state('idle'));
    let resolveRead!: (value: UpdateState) => void;
    fake.setRead(new Promise((resolve) => { resolveRead = resolve; }));
    const store = createUpdateStore(fake.client);
    const seen: (string | undefined)[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().state?.phase));
    const release = store.retain();
    fake.push(state('downloading', { progress: { percent: 5, transferred: 5, total: 100, bytesPerSecond: 1 } }));
    resolveRead(state('available'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot().state?.phase).toBe('downloading');
    expect(seen).toContain('downloading');
    release();
  });

  it('读取失败只记下原因，不抛', async () => {
    const fake = fakeClient(state('idle'));
    fake.setRead(Promise.reject(new Error('未连接到主进程（预加载脚本不可用）')));
    const store = createUpdateStore(fake.client);
    const release = store.retain();
    await vi.waitFor(() => expect(store.getSnapshot().loadError).toContain('未连接到主进程'));
    expect(store.getSnapshot().state).toBeNull();
    release();
  });

  it('动作防连点，错误交给提示，返回的状态被采用', async () => {
    const fake = fakeClient(state('idle'));
    const store = createUpdateStore(fake.client);
    let finish!: (value: UpdateState) => void;
    const action = vi.fn(() => new Promise<UpdateState>((resolve) => { finish = resolve; }));
    const onError = vi.fn();
    const first = store.run(action, onError);
    expect(store.getSnapshot().busy).toBe(true);
    await store.run(action, onError);
    expect(action).toHaveBeenCalledTimes(1);
    finish(state('available'));
    await first;
    expect(store.getSnapshot()).toMatchObject({ busy: false, state: { phase: 'available' } });

    await store.run(async () => { throw new Error('现在没有可下载的新版本'); }, onError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '现在没有可下载的新版本' }));
    expect(store.getSnapshot().busy).toBe(false);
  });

  it('订阅通道不可用时照常渲染', async () => {
    const store = createUpdateStore({
      updateState: async () => state('latest'),
      on: () => { throw new Error('no bridge'); },
    });
    const release = store.retain();
    await vi.waitFor(() => expect(store.getSnapshot().state?.phase).toBe('latest'));
    expect(() => release()).not.toThrow();
  });
});
