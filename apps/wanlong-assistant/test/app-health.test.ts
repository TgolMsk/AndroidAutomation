import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorCheck } from '@avdm/core';
import {
  AppHealth, INSTANCE_DISK_COST_BYTES, healthProblemSummary, resolutionProblems, runAssistantHealthCheck, type HealthDeps,
} from '../src/main/app/health';
import type { HealthReport } from '../src/shared/ipc';

let home: string;

beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-health-')); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

const okDoctor: DoctorCheck[] = [
  { id: 'sdk', level: 'ok', title: 'Android SDK', detail: '/sdk' },
  { id: 'emulator', level: 'ok', title: 'Emulator', detail: '36.6.11（≥ 36.6.11）' },
  { id: 'default-image', level: 'fail', title: '默认镜像', detail: 'x 未安装', hint: '打开「AVD 多开管理器」安装 x' },
];

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    home,
    environment: async () => okDoctor,
    instances: async () => [{ index: 0, name: '万龙1号', width: 2560, height: 1440 }],
    referenceSize: { width: 2560, height: 1440 },
    templateTargets: async () => [{ index: 0, load: async () => ({ templates: 93, name: '万龙觉醒' }) }],
    adbServer: async () => undefined,
    opencv: async () => ({ version: '4.12.0', ms: 1200 }),
    sharp: async () => '8.17.1',
    statfs: async () => ({ bavail: 100, bsize: INSTANCE_DISK_COST_BYTES }),
    now: () => 1_000,
    ...overrides,
  };
}

describe('assistant environment self-check', () => {
  it('passes on a healthy machine, lists environment then assistant items, and softens the default-image check', async () => {
    const report = await runAssistantHealthCheck(deps());
    expect(report.ok).toBe(true);
    expect(report.items.map((item) => item.key)).toEqual([
      'env:sdk', 'env:emulator', 'env:default-image', 'adbServer', 'instances', 'templates', 'dataDir', 'opencv', 'sharp', 'disk',
    ]);
    expect(report.items.find((item) => item.key === 'adbServer')).toMatchObject({ level: 'ok', group: 'environment', detail: 'adb 服务已在运行' });
    const image = report.items.find((item) => item.key === 'env:default-image')!;
    expect(image).toMatchObject({ level: 'warn', ok: true, group: 'environment' });
    expect(image.hint).toContain('从基础实例克隆不受影响');
    expect(report.items.find((item) => item.key === 'opencv')!.detail).toContain('OpenCV 4.12.0');
    expect(report.items.find((item) => item.key === 'templates')!.detail).toBe('实例 #0「万龙觉醒」93 张');
    expect(healthProblemSummary(report)).toBeNull();
  });

  it('never throws when every probe throws, and every failure says what to do in Chinese', async () => {
    const boom = async (): Promise<never> => { throw new Error('探测失败'); };
    const report = await runAssistantHealthCheck(deps({
      home: path.join(home, 'file-not-dir', '\0bad'),
      environment: boom, instances: boom, templateTargets: boom, opencv: boom, sharp: boom, statfs: boom, adbServer: boom,
    }));
    expect(report.ok).toBe(false);
    const failed = report.items.filter((item) => item.level === 'fail');
    expect(failed.map((item) => item.key)).toEqual(['env:manager', 'adbServer', 'instances', 'templates', 'dataDir', 'opencv', 'sharp', 'disk']);
    for (const item of failed) {
      expect(item.ok).toBe(false);
      expect(item.detail).toMatch(/[一-龥]|探测失败/);
      expect(item.hint, item.key).toMatch(/[一-龥]/);
    }
    expect(healthProblemSummary(report)).toBe('环境自检发现 8 个问题：模拟器管理器、adb 服务（127.0.0.1:5037）、实例分辨率、模板集、助手数据目录可写、视觉引擎（OpenCV WASM）、图像处理（sharp / libvips）、磁盘余量');
  });

  it('runs adb start-server and explains a 5037 conflict (original checkAdbServer)', async () => {
    const conflict = await runAssistantHealthCheck(deps({
      adbServer: async () => { throw new Error('adb server version (41) doesn\'t match this client (39); killing...'); },
    }));
    const server = conflict.items.find((item) => item.key === 'adbServer')!;
    expect(server).toMatchObject({ level: 'fail', ok: false, group: 'environment' });
    expect(server.detail).toContain('adb start-server 失败：adb server version (41)');
    expect(server.detail).toContain('5037 端口被别的 adb');
    expect(server.hint).toMatch(/adb kill-server|taskkill/);
    // Without adb itself, start-server is not even tried.
    const adbServer = vi.fn(async () => undefined);
    const missing = await runAssistantHealthCheck(deps({
      environment: async () => [{ id: 'adb', level: 'fail', title: 'adb', detail: '未安装', hint: '安装 platform-tools' }],
      adbServer,
    }));
    expect(missing.items.find((item) => item.key === 'adbServer')).toMatchObject({ level: 'fail', detail: 'adb 不可用，先解决上面的「adb」一项' });
    expect(adbServer).not.toHaveBeenCalled();
  });

  it('times a hanging probe out instead of waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang = () => new Promise<never>(() => undefined);
    const pending = runAssistantHealthCheck(deps({ instances: hang, probeTimeoutMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(10_001);
    const report = await pending;
    expect(report.items.find((item) => item.key === 'instances')).toMatchObject({ level: 'fail', detail: '实例分辨率超时（10 秒）' });
  });

  it('gives every template set its own time limit, however many instances there are', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang = () => new Promise<never>(() => undefined);
    const pending = runAssistantHealthCheck(deps({
      probeTimeoutMs: 10_000,
      templateTargets: async () => [0, 1, 2, 3, 4].map((index) => ({ index, load: index === 2 ? async () => ({ templates: 5, name: '好' }) : hang })),
    }));
    await vi.advanceTimersByTimeAsync(10_001);
    const templates = (await pending).items.find((item) => item.key === 'templates')!;
    expect(templates.detail.split('\n')).toEqual([
      '实例 #0 的模板集无法读取：实例 #0 的模板集读取超时（10 秒）', '实例 #1 的模板集无法读取：实例 #1 的模板集读取超时（10 秒）',
      '实例 #3 的模板集无法读取：实例 #3 的模板集读取超时（10 秒）', '实例 #4 的模板集无法读取：实例 #4 的模板集读取超时（10 秒）',
      '实例 #2「好」5 张',
    ]);
  });

  it('fails the template check for an enabled instance without a usable set', async () => {
    const report = await runAssistantHealthCheck(deps({
      templateTargets: async () => [
        { index: 0, load: async () => ({ templates: 93, name: '主号' }) },
        { index: 1, load: async () => null },
        { index: 2, load: async () => ({ templates: 0, name: '空集' }) },
        { index: 3, load: async () => { throw new Error('模板集与当前游戏包名不一致'); } },
      ],
    }));
    const templates = report.items.find((item) => item.key === 'templates')!;
    expect(templates.level).toBe('fail');
    expect(templates.detail.split('\n')).toEqual([
      '实例 #1 还没有选择模板集', '实例 #2 的模板集「空集」是空的', '实例 #3 的模板集无法读取：模板集与当前游戏包名不一致', '实例 #0「主号」93 张',
    ]);
    expect(templates.hint).toContain('模板库');
    // An instance whose settings could not be read is a failed line, not a silent skip.
    const unreadable = await runAssistantHealthCheck(deps({
      templateTargets: async () => [{ index: 4, load: () => Promise.reject(new Error('采集配置读取失败：自动化配置格式不兼容')) }],
    }));
    expect(unreadable.items.find((item) => item.key === 'templates')).toMatchObject({
      level: 'fail', detail: '实例 #4 的模板集无法读取：采集配置读取失败：自动化配置格式不兼容',
    });
    expect((await runAssistantHealthCheck(deps({ templateTargets: async () => [] }))).items.find((item) => item.key === 'templates')!.detail)
      .toBe('没有启用自动采集的实例，跳过检查');
  });

  it('checks the disk against the cost of one more instance', async () => {
    const report = await runAssistantHealthCheck(deps({ statfs: async () => ({ bavail: 1n, bsize: 1024n ** 3n }) }));
    const disk = report.items.find((item) => item.key === 'disk')!;
    expect(disk).toMatchObject({ level: 'fail', ok: false });
    expect(disk.detail).toBe('仅剩 1.0 GB，不足以再克隆一个实例（每个约需 4.0 GB）');
    expect(report.ok).toBe(false);
  });

  it('warns about instance resolutions that do not suit the 2560×1440 templates', () => {
    const reference = { width: 2560, height: 1440 };
    expect(resolutionProblems([{ index: 0, name: 'a', width: 1920, height: 1080 }], reference)).toEqual([]);
    expect(resolutionProblems([{ index: 1, name: 'b', width: 1280, height: 720 }], reference)).toEqual([
      '实例 #1「b」1280×720 分辨率偏低，数字识别可能不可靠（建议 2560×1440，至少 1920×1080）',
    ]);
    expect(resolutionProblems([{ index: 2, name: 'c', width: 1080, height: 2400 }], reference)[0]).toContain('比例不一致');
    expect(resolutionProblems([{ index: 3, name: 'd', width: 1440, height: 2560 }], reference)[0]).toContain('竖屏面板');
  });
});

describe('AppHealth (latest report + push)', () => {
  it('coalesces concurrent checks, keeps the last report and pushes it', async () => {
    let release!: (report: HealthReport) => void;
    const run = vi.fn(() => new Promise<HealthReport>((resolve) => { release = resolve; }));
    const emit = vi.fn();
    const health = new AppHealth(run, emit);
    expect(health.last()).toBeNull();
    const first = health.check();
    const second = health.check();
    expect(run).toHaveBeenCalledTimes(1);
    const report: HealthReport = { ok: true, checkedAt: 5, durationMs: 1, items: [] };
    release(report);
    await expect(first).resolves.toEqual(report);
    await expect(second).resolves.toEqual(report);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(health.last()).toEqual(report);
    const third = health.check();
    expect(run).toHaveBeenCalledTimes(2);
    release({ ...report, checkedAt: 6 });
    await third;
    expect(health.last()!.checkedAt).toBe(6);
  });
});
