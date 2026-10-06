/**
 * 「画面巡检」 (screen-watch.ts): the freeze watchdog's own frame a minute. Fake ports for the round mechanics; the real
 * FreezeController on a virtual clock for the verdict it leads to — the 2026-09-25 case, a game whose picture stood still
 * while the scheduler sat on its back-off ladder. No emulator, no adb.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { defaultAlertsConfig, type AlertEvent } from '../src/shared/alerts';
import { FreezeController } from '../src/main/alerts/freeze-controller';
import { SCREEN_WATCH_INTERVAL_MS, ScreenWatch, type ScreenWatchPorts } from '../src/main/alerts/screen-watch';
import { SchedulerError } from '../src/main/scheduler/errors';

const MIN = 60_000;
const W = 192;
const H = 108;

function makeFrame(seed = 1): RawFrame {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = (x * 3 + seed * 17) & 255;
      data[o + 1] = (y * 5 + seed * 31) & 255;
      data[o + 2] = ((x ^ y) + seed * 7) & 255;
      data[o + 3] = 255;
    }
  }
  return { width: W, height: H, format: 1, data, capturedAt: 0 };
}

function makeWatch(over: Partial<ScreenWatchPorts> = {}) {
  const calls = {
    exclusive: [] as Array<{ index: number; what: string }>,
    captured: [] as number[],
    observed: [] as number[],
    judged: [] as number[],
    logs: [] as string[],
  };
  const watch = new ScreenWatch({
    targets: () => [0, 1],
    skip: () => false,
    exclusive: async (index, what, fn, signal) => {
      calls.exclusive.push({ index, what });
      return fn({ signal: signal ?? new AbortController().signal });
    },
    capture: async (index) => { calls.captured.push(index); return makeFrame(1); },
    observe: (index) => { calls.observed.push(index); },
    judge: async (index) => { calls.judged.push(index); },
    log: (level, message) => { calls.logs.push(`[${level}] ${message}`); },
    ...over,
  });
  return { watch, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe('ScreenWatch rounds', () => {
  it('looks at every instance under automatic scheduling inside the instance lock: frame → evidence → verdict', async () => {
    const { watch, calls } = makeWatch();
    await watch.tick();
    expect(calls.exclusive).toEqual([{ index: 0, what: '画面巡检' }, { index: 1, what: '画面巡检' }]);
    expect(calls.captured).toEqual([0, 1]);
    expect(calls.observed).toEqual([0, 1]);
    expect(calls.judged).toEqual([0, 1]);
  });

  it('leaves skipped instances alone and never stacks a second look behind one still waiting for the lock', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const { watch, calls } = makeWatch({
      skip: (index) => index === 1,
      exclusive: async (index, what, fn, signal) => {
        calls.exclusive.push({ index, what });
        await gate; // a sample holds the lock
        return fn({ signal: signal ?? new AbortController().signal });
      },
    });
    const first = watch.tick();
    await watch.tick();
    expect(calls.exclusive).toEqual([{ index: 0, what: '画面巡检' }]);
    open();
    await first;
    expect(calls.judged).toEqual([0]);
    await watch.tick();
    expect(calls.judged).toEqual([0, 0]);
  });

  it('a refused lock or a game out of front is not judged, and is logged once per reason', async () => {
    const refused = makeWatch({
      targets: () => [0],
      exclusive: async (index) => {
        throw new SchedulerError('CONCURRENCY_LIMIT', `实例 #${index} 正在运行脚本，画面巡检稍后再试。`, { instanceIndex: index });
      },
    });
    await refused.watch.tick();
    await refused.watch.tick();
    expect(refused.calls.captured).toEqual([]);
    expect(refused.calls.logs).toEqual(['[debug] [卡死][实例 #0] 画面巡检本轮跳过：实例 #0 正在运行脚本，画面巡检稍后再试。']);

    const away = makeWatch({ targets: () => [0], capture: async () => { throw new Error('万龙觉醒未处于前台'); } });
    await away.watch.tick();
    expect(away.calls.observed).toEqual([]);
    expect(away.calls.judged).toEqual([]);
    expect(away.calls.logs).toEqual(['[debug] [卡死][实例 #0] 画面巡检本轮跳过：万龙觉醒未处于前台']);
  });

  it('runs every minute once started; dispose() stops it and aborts a look that waits for the lock', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const { watch, calls } = makeWatch({
      targets: () => [0],
      exclusive: async (index, what, fn, signal) => {
        calls.exclusive.push({ index, what });
        if (calls.exclusive.length > 1) {
          // The second look waits until the watch is disposed.
          await new Promise<void>((_, reject) => signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }));
        }
        return fn({ signal: signal! });
      },
    });
    watch.start();
    await vi.advanceTimersByTimeAsync(SCREEN_WATCH_INTERVAL_MS);
    expect(calls.judged).toEqual([0]);
    await vi.advanceTimersByTimeAsync(SCREEN_WATCH_INTERVAL_MS);
    expect(calls.exclusive).toHaveLength(2);
    watch.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * SCREEN_WATCH_INTERVAL_MS);
    expect(calls.exclusive).toHaveLength(2);
    expect(calls.logs).toEqual([]);
  });
});

describe('ScreenWatch → FreezeController (full threshold)', () => {
  function world(frames: (minute: number) => RawFrame) {
    const clock = { now: 10 * MIN };
    const raised: AlertEvent[] = [];
    const restarts: string[] = [];
    const cfg = { ...defaultAlertsConfig().detect };
    const controller = new FreezeController({
      config: () => cfg,
      isPaused: () => false,
      instanceAlive: async () => ({ alive: true, status: 'running', identity: 'avd-a' }),
      exclusive: async (_index, _what, fn, signal) => fn({ signal: signal ?? new AbortController().signal }),
      recoveryIo: () => ({}) as never,
      saveShot: async () => null,
      raise: async (event) => { raised.push(event); },
      resetFailures: () => undefined,
      log: () => undefined,
      gamePackage: 'com.lilithgames.samo.android.cn',
      now: () => clock.now,
      // 「异常时自动重启游戏」 takes a frozen picture first (the emulator restart is off by default).
      restartGame: async (_index, trigger) => {
        restarts.push(trigger);
        controller.guard.reset(0);
        return { handled: true };
      },
    });
    let minute = 0;
    const { watch } = makeWatch({
      targets: () => [0],
      capture: async () => frames(minute),
      observe: (index, raw) => controller.onFrame(index, raw),
      judge: (index, signal) => controller.tryRecover(index, '画面巡检', signal, true),
    });
    const run = async (minutes: number) => {
      for (let i = 0; i < minutes; i += 1) {
        await watch.tick();
        minute += 1;
        clock.now += MIN;
      }
    };
    return { cfg, raised, restarts, run };
  }

  it('a picture that stood still for freezeMinutes restarts the game, without waiting for failed samples', async () => {
    const w = world(() => makeFrame(7));
    expect(w.cfg.freezeMinutes).toBe(5);
    await w.run(5);
    expect(w.restarts).toEqual([]); // the fifth look is 4 minutes after the first
    await w.run(1);
    expect(w.restarts).toHaveLength(1);
    expect(w.restarts[0]).toMatch(/^画面巡检：画面已 5 分钟纹丝不动（期间截的 6 张图一模一样）/);
    expect(w.raised).toEqual([]);
  });

  it('a live picture is never judged frozen', async () => {
    const w = world((minute) => makeFrame(minute + 1));
    await w.run(15);
    expect(w.restarts).toEqual([]);
    expect(w.raised).toEqual([]);
  });
});
