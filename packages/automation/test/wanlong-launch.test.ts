/**
 * Port of scripts/gamelaunch-offline-check.ts (cold-start recovery, 22 assertions) with a virtual clock,
 * plus the target additions: prompt cancellation (checkAlive) and the createGatherIo wiring (pidof diagnostics).
 */
import { describe, expect, it } from 'vitest';
import type { DevicePort, RawFrame } from '../src/index.js';
import {
  DEFAULT_FOREGROUND_POLL_MS, DEFAULT_FOREGROUND_TIMEOUT_MS, createGatherIo, ensureGameForeground,
  type GameLaunchIo, type GamePresence,
} from '../src/wanlong/index.js';

const PKG = 'com.lilithgames.samo.android.cn';
const LAUNCHER = 'com.android.launcher3';

interface FakeOpts {
  /** foreground() returns these in turn, then keeps returning the last one. */
  foregrounds: (string | null)[];
  /** isRunning() answer; 'throw' throws; undefined leaves the capability out. */
  running?: boolean | 'throw';
  /** The Nth foreground() call (1-based) throws. */
  foregroundThrowsAt?: number;
  launchThrows?: boolean;
}

function makeFake(o: FakeOpts) {
  let clock = 1_000_000;
  let fgCalls = 0;
  const state = { launches: 0 };
  const logs: string[] = [];
  const io: GameLaunchIo = {
    foreground: async () => {
      fgCalls += 1;
      if (o.foregroundThrowsAt === fgCalls) throw new Error('dumpsys 挂了');
      return o.foregrounds[Math.min(fgCalls - 1, o.foregrounds.length - 1)] ?? null;
    },
    launch: async () => {
      state.launches += 1;
      if (o.launchThrows) throw new Error('monkey: No activities found');
    },
    isRunning: o.running === undefined ? undefined : async () => {
      if (o.running === 'throw') throw new Error('pidof 挂了');
      return o.running as boolean;
    },
    log: (level, message) => logs.push(`${level}:${message}`),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return {
    io,
    get launches() { return state.launches; },
    elapsedMs: () => clock - 1_000_000,
    logs,
  };
}

async function run(o: FakeOpts, opts = {}): Promise<{ r: GamePresence; f: ReturnType<typeof makeFake> }> {
  const f = makeFake(o);
  const r = await ensureGameForeground(f.io, { packageName: PKG, ...opts });
  return { r, f };
}

describe('一、游戏已在前台：什么都不做', () => {
  it('returns foreground without launching or waiting', async () => {
    const { r, f } = await run({ foregrounds: [PKG] });
    expect(r).toBe('foreground');
    expect(f.launches).toBe(0); // ★ a stray launch would push away what the player is looking at
    expect(f.elapsedMs()).toBe(0);
    expect((await run({ foregrounds: [PKG] })).r).toBe('foreground');
  });
});

describe('二、拉起并等到前台', () => {
  it('launches once and waits for the foreground (monkey wording when the process is gone)', async () => {
    const { r, f } = await run({ foregrounds: [LAUNCHER, LAUNCHER, PKG], running: false });
    expect(r).toBe('launched');
    expect(f.launches).toBe(1);
    expect(f.elapsedMs()).toBe(DEFAULT_FOREGROUND_POLL_MS * 2);
    expect(f.logs.some((l) => l.includes('monkey'))).toBe(true);
    expect(f.logs[0]).toContain(LAUNCHER);
  });

  it('uses the 切到前台 wording when the process is still alive', async () => {
    const back = await run({ foregrounds: [LAUNCHER, PKG], running: true });
    expect(back.r).toBe('launched');
    expect(back.f.launches).toBe(1);
    expect(back.f.logs.some((l) => l.includes('切到前台') && l.includes('进程还在'))).toBe(true);
  });

  it('still launches when the foreground is unknown (null)', async () => {
    const unknown = await run({ foregrounds: [null, PKG], running: false });
    expect(unknown.r).toBe('launched');
    expect(unknown.f.launches).toBe(1);
    expect(unknown.f.logs[0]).toContain('未知');
  });
});

describe('三、失败时不抛异常', () => {
  it('returns failed without polling when the launch throws', async () => {
    const { r, f } = await run({ foregrounds: [LAUNCHER], launchThrows: true, running: false });
    expect(r).toBe('failed');
    expect(f.elapsedMs()).toBe(0);
    expect(f.logs.some((l) => l.includes('拉起游戏失败'))).toBe(true);
  });

  it('gives up exactly at the timeout and names the current foreground', async () => {
    const stuck = await run({ foregrounds: [LAUNCHER], running: false });
    expect(stuck.r).toBe('failed');
    expect(stuck.f.elapsedMs()).toBeGreaterThanOrEqual(DEFAULT_FOREGROUND_TIMEOUT_MS);
    expect(stuck.f.elapsedMs()).toBeLessThan(DEFAULT_FOREGROUND_TIMEOUT_MS + DEFAULT_FOREGROUND_POLL_MS);
    expect(stuck.f.logs.at(-1)).toContain(LAUNCHER);
  });
});

describe('四、查询抛错不影响恢复', () => {
  it('launches when the first foreground query throws', async () => {
    const { r, f } = await run({ foregrounds: [PKG], foregroundThrowsAt: 1, running: false });
    expect(r).toBe('launched');
    expect(f.launches).toBe(1);
  });

  it('still launches when isRunning throws', async () => {
    const ir = await run({ foregrounds: [LAUNCHER, PKG], running: 'throw' });
    expect(ir.r).toBe('launched');
    expect(ir.f.launches).toBe(1);
  });

  it('keeps waiting when a mid-poll foreground query throws', async () => {
    const mid = await run({ foregrounds: [LAUNCHER, LAUNCHER, PKG], foregroundThrowsAt: 2, running: false });
    expect(mid.r).toBe('launched');
  });
});

describe('五、超时与轮询间隔可配', () => {
  it('honours a custom timeout and poll', async () => {
    const f = makeFake({ foregrounds: [LAUNCHER], running: false });
    const r = await ensureGameForeground(f.io, { packageName: PKG, foregroundTimeoutMs: 10_000, pollMs: 1_000 });
    expect(r).toBe('failed');
    expect(f.elapsedMs()).toBeGreaterThanOrEqual(10_000);
    expect(f.elapsedMs()).toBeLessThanOrEqual(11_000);
  });

  it('clamps pollMs so it never spins', async () => {
    const z = makeFake({ foregrounds: [LAUNCHER], running: false });
    await ensureGameForeground(z.io, { packageName: PKG, foregroundTimeoutMs: 1_000, pollMs: 0 });
    expect(z.elapsedMs()).toBeGreaterThanOrEqual(1_000);
  });
});

describe('六、中止（目标新增）', () => {
  it('propagates only the checkAlive cancellation, promptly', async () => {
    const f = makeFake({ foregrounds: [LAUNCHER], running: false });
    let calls = 0;
    f.io.checkAlive = () => { if (++calls > 3) throw new Error('调度已停止'); };
    await expect(ensureGameForeground(f.io, { packageName: PKG })).rejects.toThrow('调度已停止');
    expect(f.launches).toBe(1);
    expect(f.elapsedMs()).toBeLessThanOrEqual(DEFAULT_FOREGROUND_POLL_MS);
  });

  it('cancels before launching when already stopped', async () => {
    const f = makeFake({ foregrounds: [LAUNCHER], running: false });
    f.io.checkAlive = () => { throw new Error('用户停止脚本'); };
    await expect(ensureGameForeground(f.io, { packageName: PKG })).rejects.toThrow('用户停止脚本');
    expect(f.launches).toBe(0);
  });
});

describe('createGatherIo.ensureGameForeground wiring', () => {
  function device(opts: { running?: boolean; foregrounds: string[] }) {
    const calls: string[] = [];
    let i = 0;
    const raw: RawFrame = { width: 16, height: 9, data: new Uint8Array(16 * 9 * 4), capturedAt: 0 };
    const port: DevicePort = {
      async capture() { return raw; },
      async foregroundPackage() { const v = opts.foregrounds[Math.min(i, opts.foregrounds.length - 1)]!; i++; return v; },
      async tap() { calls.push('tap'); },
      async swipe() { calls.push('swipe'); },
      async key() { calls.push('key'); },
      async launchApp(pkg, cold) { calls.push(`launch:${pkg}:${cold}`); },
      async stopApp(pkg) { calls.push(`stop:${pkg}`); },
      ...(opts.running === undefined ? {} : { async isAppRunning(pkg: string) { calls.push(`pidof:${pkg}`); return opts.running!; } }),
    };
    return { port, calls };
  }

  it('launches through the device port (monkey on the host), asks pidof for wording and logs in Chinese', async () => {
    const { port, calls } = device({ running: false, foregrounds: [LAUNCHER, PKG] });
    const logs: string[] = [];
    const io = createGatherIo(port, { refWidth: 2560, refHeight: 1440, log: (level, m) => logs.push(`${level}:${m}`) });
    await expect(io.ensureGameForeground!(PKG)).resolves.toBe('launched');
    expect(calls).toEqual([`pidof:${PKG}`, `launch:${PKG}:false`]);
    expect(logs.some((l) => l.includes('monkey'))).toBe(true);
  }, 10_000);

  it('works without isAppRunning and stops waiting as soon as the signal aborts', async () => {
    const { port, calls } = device({ foregrounds: [LAUNCHER] });
    const controller = new AbortController();
    const io = createGatherIo(port, { refWidth: 2560, refHeight: 1440, signal: controller.signal });
    const pending = io.ensureGameForeground!(PKG);
    setTimeout(() => controller.abort(new Error('采集已取消')), 50);
    const started = Date.now();
    await expect(pending).rejects.toThrow('采集已取消');
    expect(Date.now() - started).toBeLessThan(DEFAULT_FOREGROUND_POLL_MS + 1_000);
    expect(calls).toEqual([`launch:${PKG}:false`]);
  }, 10_000);
});
