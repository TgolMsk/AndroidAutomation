import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { displayWidth, padEnd, renderTable, stripAnsi, truncate } from '../../cli/src/ui/table.js';
import { formatBytes, renderBar } from '../../cli/src/ui/progress.js';
import { isYes } from '../../cli/src/ui/prompt.js';
import { makePalette } from '../../cli/src/ui/colors.js';
import {
  coordinate,
  gigabytes,
  intInRange,
  megabytes,
  nonNegativeSecondsToMs,
  parseSettingValue,
  parseSingleIndex,
  resolution,
} from '../../cli/src/util/parse.js';
import { cleanLogMessage, errorSummary, imageSummary, publicState, specSummary } from '../../cli/src/util/format.js';
import { LineSplitter, followFile, installedRevision, readTail } from '../../cli/src/util/files.js';
import { buildSettingsPatch } from '../../cli/src/commands/settings.js';
import { localizeCommanderError } from '../../cli/src/index.js';
import { DEFAULT_SPEC } from '../src/constants.js';
import type { InstanceState, Settings } from '../src/types.js';

// CLI sources import '@avdm/core' (package exports → dist/); use the sources instead so no build is needed.
vi.mock('@avdm/core', async () => await import('../src/index.js'));

describe('cli table (CJK aware)', () => {
  it('counts CJK and full-width characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('实例-0')).toBe(6);
    expect(displayWidth('ＡＢ')).toBe(4);
    expect(displayWidth('✓ ok')).toBe(4);
    expect(displayWidth('é')).toBe(1); // combining accent
  });

  it('ignores ANSI escapes', () => {
    const red = makePalette(true).red('运行中');
    expect(red).not.toBe('运行中');
    expect(stripAnsi(red)).toBe('运行中');
    expect(displayWidth(red)).toBe(6);
  });

  it('truncates and pads by display width', () => {
    expect(truncate('实例名称很长很长', 7)).toBe('实例名…');
    expect(displayWidth(truncate('实例名称很长很长', 7))).toBeLessThanOrEqual(7);
    expect(truncate('short', 10)).toBe('short');
    expect(padEnd('实例', 6)).toBe('实例  ');
  });

  it('aligns columns containing CJK text', () => {
    const rows = [
      { i: 0, name: '实例-0', st: '运行中' },
      { i: 12, name: 'phone', st: 'stopped' },
    ];
    const text = renderTable(rows, [
      { header: '#', get: (r) => String(r.i), align: 'right' },
      { header: '名称', get: (r) => r.name },
      { header: '状态', get: (r) => r.st },
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    // The third column starts at the same display column on every line.
    const col = (line: string, needle: string) => displayWidth(line.slice(0, line.indexOf(needle)));
    expect(col(lines[0]!, '状态')).toBe(col(lines[1]!, '运行中'));
    expect(col(lines[1]!, '运行中')).toBe(col(lines[2]!, 'stopped'));
    expect(lines[1]!.startsWith(' 0')).toBe(true); // right-aligned index
    expect(lines.every((l) => l === l.trimEnd())).toBe(true);
  });

  it('applies styles after padding', () => {
    const p = makePalette(true);
    const text = renderTable([{ a: 'x', b: 'y' }], [
      { header: 'A', get: (r) => r.a, style: (s) => p.green(s) },
      { header: 'B', get: (r) => r.b },
    ]);
    expect(stripAnsi(text).split('\n')[1]).toBe('x  y');
  });
});

describe('cli progress helpers', () => {
  it('renders a fixed-width bar', () => {
    expect(renderBar(0, 10)).toBe('[          ]');
    expect(renderBar(0.5, 10)).toBe('[====>     ]');
    expect(renderBar(1, 10)).toBe('[==========]');
    expect(renderBar(7, 4)).toBe('[====]');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(300 * 1024 * 1024)).toBe('300.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.50 GB');
    expect(formatBytes(undefined)).toBe('-');
  });
});

describe('cli argument parsing', () => {
  it('parses sizes, resolutions and ranges', () => {
    expect(megabytes('3072')).toBe(3072);
    expect(megabytes('4G')).toBe(4096);
    expect(megabytes('3.5g')).toBe(3584);
    expect(() => megabytes('lots')).toThrow(/内存/);
    expect(gigabytes('16G')).toBe(16);
    expect(resolution('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(resolution('720X1280')).toEqual({ width: 720, height: 1280 });
    expect(() => resolution('1280')).toThrow(/宽x高/);
    expect(intInRange(1, 16)('4')).toBe(4);
    expect(() => intInRange(1, 16)('17')).toThrow(/1\.\.16/);
    expect(() => intInRange(1, 16)('2.5')).toThrow();
    expect(coordinate('10.6')).toBe(11);
    expect(() => coordinate('-1')).toThrow();
  });

  it('parses a non-negative timeout in seconds (0 = unlimited)', () => {
    expect(nonNegativeSecondsToMs('0')).toBe(0);
    expect(nonNegativeSecondsToMs('1.5')).toBe(1500);
    expect(() => nonNegativeSecondsToMs('-1')).toThrow(/非负数/);
    expect(() => nonNegativeSecondsToMs('')).toThrow(/非负数/);
  });

  it('parses a single-instance selector', () => {
    expect(parseSingleIndex('3', [1, 3])).toBe(3);
    expect(() => parseSingleIndex('1-3', [1, 3])).toThrow(/单个实例/);
    expect(() => parseSingleIndex('2', [1, 3])).toThrow(/不存在/);
  });

  it('parses setting values as JSON with string fallback', () => {
    expect(parseSettingValue('8')).toBe(8);
    expect(parseSettingValue('true')).toBe(true);
    expect(parseSettingValue('["-no-audio"]')).toEqual(['-no-audio']);
    expect(parseSettingValue('127.0.0.1:7890')).toBe('127.0.0.1:7890');
    expect(parseSettingValue('')).toBe('');
  });

  it('accepts only explicit yes answers', () => {
    expect(isYes('y')).toBe(true);
    expect(isYes(' YES ')).toBe(true);
    expect(isYes('是')).toBe(true);
    expect(isYes('')).toBe(false);
    expect(isYes('n')).toBe(false);
    expect(isYes('yep')).toBe(false);
  });
});

describe('cli settings patch', () => {
  const settings: Settings = {
    sdkRoot: '/sdk',
    defaultImage: 'system-images;android-35;default;arm64-v8a',
    defaultSpec: { ...DEFAULT_SPEC, extraArgs: [] },
    maxRunning: 6,
    memoryReserveMb: 6144,
    bootTimeoutSec: 240,
    healthIntervalSec: 5,
    proxy: 'direct',
    emulatorExtraArgs: [],
    scrcpyPath: '',
  };

  it('builds typed patches', () => {
    expect(buildSettingsPatch(settings, 'maxRunning', '8')).toEqual({ maxRunning: 8 });
    expect(buildSettingsPatch(settings, 'proxy', '127.0.0.1:7890')).toEqual({ proxy: '127.0.0.1:7890' });
    expect(buildSettingsPatch(settings, 'emulatorExtraArgs', '["-no-audio"]')).toEqual({ emulatorExtraArgs: ['-no-audio'] });
    // A numeric-looking string stays a string for string settings.
    expect(buildSettingsPatch(settings, 'defaultImage', '123')).toEqual({ defaultImage: '123' });
    const nested = buildSettingsPatch(settings, 'defaultSpec.ramMb', '4096');
    expect(nested.defaultSpec).toEqual({ ...settings.defaultSpec, ramMb: 4096 });
    expect(buildSettingsPatch(settings, 'defaultSpec.headless', 'false').defaultSpec?.headless).toBe(false);
    const whole = buildSettingsPatch(settings, 'defaultSpec', '{"cpuCores":4}');
    expect(whole.defaultSpec).toEqual({ ...settings.defaultSpec, cpuCores: 4 });
  });

  it('rejects unknown keys and wrong types in Chinese', () => {
    expect(() => buildSettingsPatch(settings, 'nope', '1')).toThrow(/未知设置项/);
    expect(() => buildSettingsPatch(settings, 'defaultSpec.nope', '1')).toThrow(/未知设置项/);
    expect(() => buildSettingsPatch(settings, 'maxRunning', 'many')).toThrow(/需为数字/);
    expect(() => buildSettingsPatch(settings, 'emulatorExtraArgs', '-no-audio')).toThrow(/JSON 数组/);
    expect(() => buildSettingsPatch(settings, 'defaultSpec.headless', 'maybe')).toThrow(/true 或 false/);
  });
});

describe('cli formatting', () => {
  it('summarises spec and image', () => {
    expect(specSummary(DEFAULT_SPEC)).toBe('2核/3G/1280x720@320');
    expect(imageSummary('system-images;android-35;google_apis;arm64-v8a')).toBe('android-35/google_apis');
    expect(imageSummary('weird')).toBe('weird');
  });

  it('summarises instance errors without a dangling "日志末尾:"', () => {
    expect(errorSummary('模拟器进程意外退出（pid 78209），日志末尾:\nINFO | Boot completed')).toBe('模拟器进程意外退出（pid 78209）');
    expect(errorSummary('启动超时')).toBe('启动超时');
    expect(errorSummary(undefined)).toBe('状态异常');
    expect(cleanLogMessage('实例 #0（实例-0）模拟器进程意外退出（pid 78209），日志末尾:，正在自动重启（10 分钟内第 1 次）')).toBe(
      '实例 #0（实例-0）模拟器进程意外退出（pid 78209），正在自动重启（10 分钟内第 1 次）',
    );
    expect(cleanLogMessage('实例 #0 已自动重启')).toBe('实例 #0 已自动重启');
  });

  it('never exposes the gRPC token in JSON state', () => {
    const st = { record: {}, ports: {}, status: 'running', bootCompleted: true, grpcToken: 'secret' } as unknown as InstanceState;
    const pub = publicState(st);
    expect(JSON.stringify(pub)).not.toContain('secret');
    expect(pub.grpcAuth).toBe(true);
  });

  it('splits streamed text into lines', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb')).toEqual(['a']);
    expect(s.push('c\r\nd\n')).toEqual(['bc', 'd']);
    expect(s.push('tail')).toEqual([]);
    expect(s.flush()).toEqual(['tail']);
  });

  it('localizes commander errors', () => {
    process.env.NO_COLOR = '1';
    expect(localizeCommanderError("error: missing required argument 'sel'\n")).toContain("错误: 缺少必需参数 'sel'");
    expect(localizeCommanderError("error: unknown command 'strat'\n(Did you mean start?)\n")).toContain('（是否想输入 start？）');
    expect(
      localizeCommanderError("error: option '--gpu <模式>' argument 'x' is invalid. Allowed choices are host, software, auto.\n"),
    ).toContain("错误: 选项 '--gpu <模式>' 的值 'x' 无效。可选值: host, software, auto。");
    expect(localizeCommanderError("error: option '--window' cannot be used with option '--headless'\n")).toContain(
      "选项 '--window' 不能与选项 '--headless' 同时使用",
    );
  });
});

describe('cli file helpers', () => {
  it('follows a growing file and handles truncation', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-follow-'));
    try {
      const file = path.join(dir, 'instance-0.log');
      await fsp.writeFile(file, 'old line\n');
      const from = (await fsp.stat(file)).size;
      const ac = new AbortController();
      let got = '';
      let truncated = 0;
      const done = followFile(file, {
        from,
        signal: ac.signal,
        intervalMs: 10,
        onData: (t) => (got += t),
        onTruncate: () => truncated++,
      });
      await fsp.appendFile(file, '新的一行\n');
      await vi.waitFor(() => expect(got).toBe('新的一行\n'), { timeout: 2000, interval: 10 });
      await fsp.writeFile(file, 'x\n');
      await vi.waitFor(() => expect(truncated).toBe(1), { timeout: 2000, interval: 10 });
      await vi.waitFor(() => expect(got).toBe('新的一行\nx\n'), { timeout: 2000, interval: 10 });
      ac.abort();
      await done;
      expect(got).not.toContain('old line');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('tails and then follows with no line lost or printed twice (unterminated last line left to the follower)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-tail-'));
    try {
      const file = path.join(dir, 'instance-0.log');
      await fsp.writeFile(file, 'a\nb\nc\npartial');
      const tail = await readTail(file, 2);
      expect(tail.lines).toEqual(['b', 'c']);
      expect(tail.offset).toBe('a\nb\nc\n'.length);
      // Written after the tail was read but before following starts (the old code lost or duplicated these).
      await fsp.appendFile(file, ' line\nd\n');
      const ac = new AbortController();
      let got = '';
      const done = followFile(file, { from: tail.offset, identity: tail.identity!, signal: ac.signal, intervalMs: 10, onData: (t) => (got += t) });
      await vi.waitFor(() => expect(got).toBe('partial line\nd\n'), { timeout: 2000, interval: 10 });
      ac.abort();
      await done;
      expect(await readTail(path.join(dir, 'missing.log'), 5)).toEqual({ lines: [], offset: 0 });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  // Known limitation, kept visible: off macOS a delete-and-recreate is only told apart from an append by
  // dev + inode (see `sameFile` in cli/src/util/files.ts), and ext4/tmpfs hand the freed inode number straight
  // back to the new file, so there this exact sequence reads as an append. APFS never reuses inode numbers.
  it.skipIf(process.platform !== 'darwin')('restarts at 0 when the log file is replaced by a larger new one (like tail -F)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-replace-'));
    try {
      const file = path.join(dir, 'instance-0.log');
      await fsp.writeFile(file, 'old\n'.repeat(10));
      const tail = await readTail(file, 200);
      // `avdm rm 0 && avdm create && avdm start 0`: deleted, recreated, and grown past the old size.
      await fsp.rm(file);
      await fsp.writeFile(file, '=== launch header ===\n' + 'new\n'.repeat(20));
      const ac = new AbortController();
      let got = '';
      let truncated = 0;
      const done = followFile(file, {
        from: tail.offset,
        identity: tail.identity!,
        signal: ac.signal,
        intervalMs: 10,
        onData: (t) => (got += t),
        onTruncate: () => truncated++,
      });
      await vi.waitFor(() => expect(got.startsWith('=== launch header ===\n')).toBe(true), { timeout: 2000, interval: 10 });
      await vi.waitFor(() => expect(got).toBe('=== launch header ===\n' + 'new\n'.repeat(20)), { timeout: 2000, interval: 10 });
      expect(truncated).toBe(1);
      ac.abort();
      await done;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('restarts at 0 when a larger new log file is renamed over the old one', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-rename-'));
    try {
      const file = path.join(dir, 'instance-0.log');
      await fsp.writeFile(file, 'old\n'.repeat(10));
      const tail = await readTail(file, 200);
      // Both files exist at once, so the new one always gets another inode: runs on every platform.
      await fsp.writeFile(`${file}.new`, '=== launch header ===\n' + 'new\n'.repeat(20));
      await fsp.rename(`${file}.new`, file);
      const ac = new AbortController();
      let got = '';
      let truncated = 0;
      const done = followFile(file, {
        from: tail.offset,
        identity: tail.identity!,
        signal: ac.signal,
        intervalMs: 10,
        onData: (t) => (got += t),
        onTruncate: () => truncated++,
      });
      await vi.waitFor(() => expect(got.startsWith('=== launch header ===\n')).toBe(true), { timeout: 2000, interval: 10 });
      await vi.waitFor(() => expect(got).toBe('=== launch header ===\n' + 'new\n'.repeat(20)), { timeout: 2000, interval: 10 });
      expect(truncated).toBe(1);
      ac.abort();
      await done;
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads installed package revisions from source.properties', async () => {
    const sdk = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-cli-sdk-'));
    try {
      const img = path.join(sdk, 'system-images', 'android-35', 'default', 'arm64-v8a');
      await fsp.mkdir(img, { recursive: true });
      await fsp.writeFile(path.join(img, 'source.properties'), 'Pkg.Desc=x\nPkg.Revision=2\n');
      await fsp.mkdir(path.join(sdk, 'platform-tools'), { recursive: true });
      await fsp.writeFile(path.join(sdk, 'platform-tools', 'adb'), '');
      expect(await installedRevision(sdk, 'system-images;android-35;default;arm64-v8a')).toBe('2');
      expect(await installedRevision(sdk, 'platform-tools')).toBe('');
      expect(await installedRevision(sdk, 'emulator')).toBeUndefined();
    } finally {
      await fsp.rm(sdk, { recursive: true, force: true });
    }
  });
});
