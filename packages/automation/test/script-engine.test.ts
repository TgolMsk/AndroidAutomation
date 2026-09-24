import { describe, expect, it } from 'vitest';
import { ExecutionGuardError, expectedTemplateIds } from '../src/index.js';
import type { ScriptStep } from '../src/script/index.js';
import { PKG, fakeDevice, fakeVision, frame, harness, script } from './script-fakes.js';

const tap = (id: string, x = 10, y = 10, extra: Partial<ScriptStep> = {}): ScriptStep => ({ id, kind: 'tap', at: { x, y }, ...extra } as ScriptStep);
const failingTap = (device: ReturnType<typeof fakeDevice>, failing: number): void => {
  device.tap = async (x, y) => {
    device.actions.push(`tap:${x},${y}`);
    if (x === failing) throw new Error('fake adb failure');
  };
};

describe('script engine: control flow (original engine.ts semantics)', () => {
  it('scales script coordinates, runs branches, loops, parameters and goto', async () => {
    const h = harness(script([
      { id: 'a', kind: 'tap', at: { x: 25, y: 50 } },
      { id: 'b', kind: 'if', cond: { kind: 'foreground', packageName: PKG }, then: [{ id: 'c', kind: 'key', key: 'BACK' }] },
      { id: 'd', kind: 'loop', repeat: 2, steps: [{ id: 'e', kind: 'log', level: 'info', message: '轮次' }] },
      { id: 'f', kind: 'goto', label: 'end' },
      { id: 'g', kind: 'tap', at: { x: 0, y: 0 } },
      { id: 'h', kind: 'label', label: 'end' },
      { id: 'i', kind: 'text', text: 'role={{ name }} / {{missing}}' },
    ]));
    (h.ctx as unknown as { params: Record<string, string> }).params = { name: 'Alice' };
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    // 100×100 script canvas on a 200×100 device frame.
    expect(h.device.actions).toEqual(['tap:50,50', 'key:BACK', 'text:role=Alice / {{missing}}']);
    // a, b, d, label h and i complete; the goto itself and the skipped g do not count.
    expect(result.stepDone).toBe(5);
    expect(h.logs.filter((line) => line.scope === 'script').map((line) => line.message)).toEqual(['轮次', '轮次']);
  });

  it('skips a step whose when is false without failing', async () => {
    const h = harness(script([tap('a', 10, 10, { when: { kind: 'never' } }), tap('b', 20, 20)]));
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.device.actions).toEqual(['tap:40,20']);
    expect(h.logs.some((line) => line.level === 'debug' && line.message.includes('跳过步骤'))).toBe(true);
  });

  it('bubbles a goto up to a label in an outer block', async () => {
    const h = harness(script([
      { id: 'loop', kind: 'loop', repeat: 5, steps: [tap('inner'), { id: 'out', kind: 'goto', label: '落点1' }] },
      tap('skipped', 30, 30),
      { id: 'land', kind: 'label', label: '落点1' },
      tap('after', 40, 40),
    ]));
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.device.actions).toEqual(['tap:20,10', 'tap:80,40']);
  });

  it('fails the run when goto exceeds maxTimes, even with onFail continue', async () => {
    const h = harness(script([
      { id: 'top', kind: 'label', label: 'top' },
      tap('a'),
      { id: 'again', kind: 'goto', label: 'top', maxTimes: 3, onFail: { kind: 'continue' } },
    ]));
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('maxTimes');
    expect(h.device.actions).toHaveLength(4);
  });

  it('fails the run when a loop reaches maxIterations, but repeat ends normally', async () => {
    const capped = await harness(script([{ id: 'l', kind: 'loop', maxIterations: 3, steps: [tap('a')] }])).run();
    expect(capped.status).toBe('failed');
    expect(capped.error).toContain('硬上限 3');
    const repeated = harness(script([{ id: 'l', kind: 'loop', repeat: 3, maxIterations: 5, steps: [tap('a')] }]));
    expect((await repeated.run()).status).toBe('succeeded');
    expect(repeated.device.actions).toHaveLength(3);
  });

  it('a while loop re-judges a fresh frame every round', async () => {
    const vision = fakeVision((_id, call) => call < 3);
    const h = harness(script([{ id: 'l', kind: 'loop', while: { kind: 'template', templateId: 'pop' }, steps: [tap('close')] }], { templateSetId: 'set' }),
      { vision, templates: ['pop'] });
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.device.actions).toHaveLength(2);
    expect(h.device.captures).toBe(3);
  });

  it('an abort inside an if branch fails the run and is not retried by the if', async () => {
    const device = fakeDevice();
    failingTap(device, 20);
    const h = harness(script([
      { id: 'branch', kind: 'if', cond: { kind: 'always' }, retry: 3, onFail: { kind: 'continue' }, then: [tap('inner')] },
      tap('never', 30, 30),
    ]), { device });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('fake adb failure');
    expect(device.actions).toEqual(['tap:20,10']);
  });

  it('runs script-level loop rounds with an iteration counter until the run limit, which ends a loop as succeeded', async () => {
    const h = harness(script([tap('a')], { loop: true, loopIntervalMs: 1000 }), { engine: { maxRunMs: 2500 } });
    const started = Date.now();
    const result = await h.run();
    // A loop only ends by a stop or its time budget: reaching the budget is not a (retryable) failure.
    expect(result.status).toBe('succeeded');
    expect(result.timedOut).toBe(true);
    expect(result.error).toBeNull();
    expect(h.logs.some((line) => line.message.includes('按时结束'))).toBe(true);
    expect(result.stepTotal).toBeNull();
    expect(result.iteration).toBeGreaterThanOrEqual(2);
    expect(h.device.actions.length).toBe(result.iteration + (result.iteration >= 3 ? 0 : 1));
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('script engine: retry and onFail', () => {
  it('abort: retries, counts them, then fails with a failure shot', async () => {
    const device = fakeDevice();
    failingTap(device, 20);
    const h = harness(script([tap('a', 10, 10, { retry: 2, retryDelayMs: 0 })]), { device });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.stats.retries).toBe(2);
    expect(device.actions).toHaveLength(3);
    expect(h.shots).toEqual(['0001-fail-a.jpg']);
    const failure = h.logs.find((line) => line.level === 'error' && line.stepId === 'a');
    expect(failure?.shot).toBe('run-1/0001-fail-a.jpg');
    expect(failure?.data).toMatchObject({ code: 'STEP_FAILED' });
  });

  it('continue and goto keep the run going', async () => {
    const device = fakeDevice();
    failingTap(device, 20);
    const h = harness(script([
      tap('a', 10, 10, { onFail: { kind: 'continue' } }),
      tap('b', 10, 10, { onFail: { kind: 'goto', label: 'end' } }),
      tap('skipped', 30, 30),
      { id: 'end', kind: 'label', label: 'end' },
      tap('c', 40, 40),
    ]), { device });
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(device.actions).toEqual(['tap:20,10', 'tap:20,10', 'tap:80,40']);
  });

  it('restartApp stops, cold-launches and reruns from the top; too many restarts fail', async () => {
    const device = fakeDevice();
    let failures = 1;
    device.tap = async (x, y) => {
      device.actions.push(`tap:${x},${y}`);
      if (x === 40 && failures-- > 0) throw new Error('卡界面');
    };
    const h = harness(script([tap('a', 10, 10), tap('b', 20, 20, { onFail: { kind: 'restartApp' } })]), { device });
    expect((await h.run()).status).toBe('succeeded');
    expect(device.actions).toEqual(['tap:20,10', 'tap:40,20', `stop:${PKG}`, `launch:${PKG}:true`, 'tap:20,10', 'tap:40,20']);

    const stuck = fakeDevice();
    failingTap(stuck, 20);
    const capped = harness(script([tap('a', 10, 10, { onFail: { kind: 'restartApp' } })]), { device: stuck, engine: { maxRestarts: 2 } });
    const result = await capped.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('重启应用 2 次');
    expect(stuck.actions.filter((action) => action.startsWith('launch')).length).toBe(2);
  });

  it('a step timeout is a failure, retry/onFail apply, and the timed-out attempt never inputs later', async () => {
    const vision = fakeVision(() => false);
    const h = harness(script([
      { id: 'slow', kind: 'tapTemplate', templateId: 'btn', waitMs: 60_000, pollMs: 50, timeoutMs: 200, onFail: { kind: 'continue' } },
      tap('next', 30, 30),
    ], { templateSetId: 'set' }), { vision, templates: ['btn'] });
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.logs.some((line) => line.level === 'error' && line.message.includes('超过 200ms'))).toBe(true);
    const matchesAtEnd = vision.calls;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(vision.calls).toBe(matchesAtEnd);
    expect(h.device.actions).toEqual(['tap:60,30']);
  });

  it('an ExecutionGuardError from the host bypasses retry and onFail', async () => {
    const device = fakeDevice();
    device.tap = async () => { device.actions.push('tap'); throw new ExecutionGuardError('目标游戏已离开前台'); };
    const h = harness(script([tap('a', 10, 10, { retry: 3, onFail: { kind: 'continue' } }), tap('b')]), { device, consult: async () => ({ handled: true, message: 'x' }) });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('目标游戏已离开前台');
    expect(device.actions).toEqual(['tap']);
    expect(h.consults).toHaveLength(0);
  });
});

describe('script engine: stop, pause, shots', () => {
  it('stopping ends as aborted, not failed', async () => {
    const h = harness(script([{ id: 's', kind: 'sleep', ms: 60_000 }, tap('never')]));
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.engine.stop();
    const result = await running;
    expect(result.status).toBe('aborted');
    expect(result.error).toBeNull();
    expect(h.device.actions).toEqual([]);
  });

  it('an aborted external signal stops the run', async () => {
    const controller = new AbortController();
    const h = harness(script([{ id: 's', kind: 'sleep', ms: 60_000 }]), { engine: { signal: controller.signal } });
    const running = h.run();
    controller.abort(new Error('助手正在退出'));
    expect((await running).status).toBe('aborted');
  });

  it('pause takes effect at the next step boundary only', async () => {
    const h = harness(script([{ id: 's', kind: 'sleep', ms: 80 }, tap('a')]));
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.engine.pause();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.device.actions).toEqual([]);
    expect(h.statuses.at(-1)?.status).toBe('paused');
    h.engine.resume();
    const result = await running;
    expect(result.status).toBe('succeeded');
    expect(h.device.actions).toEqual(['tap:20,10']);
  });

  it('pause time counts toward maxRunMs: a run paused past its limit ends without resuming or sending input', async () => {
    const h = harness(script([{ id: 's', kind: 'sleep', ms: 30 }, tap('a')]), { engine: { maxRunMs: 150 } });
    const started = Date.now();
    const running = h.run();
    h.engine.pause();
    // Nobody resumes: only the whole-run limit can end the run.
    const result = await running;
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('时间上限');
    expect(h.statuses.some((status) => status.status === 'paused')).toBe(true);
    expect(h.device.actions).toEqual([]);
  });

  it('shot policy: success shots only when capture=true or always; failures unless never or capture=false', async () => {
    const onFail = harness(script([tap('a'), tap('b', 10, 10, { capture: true })]));
    await onFail.run();
    expect(onFail.shots).toEqual(['0001-b-ok.jpg']);

    const always = harness(script([tap('a'), tap('b', 10, 10, { capture: false })]), { context: { shotPolicy: 'always' } });
    await always.run();
    expect(always.shots).toEqual(['0001-a-ok.jpg']);

    const device = fakeDevice();
    failingTap(device, 20);
    const never = harness(script([tap('a', 10, 10, { onFail: { kind: 'continue' } })]), { device, context: { shotPolicy: 'never' } });
    await never.run();
    expect(never.shots).toEqual([]);
    const suppressed = harness(script([tap('a', 10, 10, { capture: false, onFail: { kind: 'continue' } })]), { device });
    await suppressed.run();
    expect(suppressed.shots).toEqual([]);
  });

  it('a shot reuses the last frame and a shot failure only warns', async () => {
    const h = harness(script([tap('a'), { id: 'shot', kind: 'screenshot', label: '现场 1' }]));
    await h.run();
    expect(h.device.captures).toBe(1);
    expect(h.shots).toEqual(['0001-1.jpg']);
    expect(h.logs.find((line) => line.stepId === 'shot')?.shot).toBe('run-1/0001-1.jpg');

    const broken = harness(script([{ id: 'shot', kind: 'screenshot' }]), { shotSave: async () => { throw new Error('磁盘已满'); } });
    const result = await broken.run();
    expect(result.status).toBe('succeeded');
    expect(broken.logs.some((line) => line.level === 'warn' && line.message.includes('磁盘已满'))).toBe(true);
  });

  it('empty text warns and is skipped; the typed content is never logged', async () => {
    const h = harness(script([{ id: 'empty', kind: 'text', text: '' }, { id: 't', kind: 'text', text: 'secret-123' }]));
    await h.run();
    expect(h.device.actions).toEqual(['text:secret-123']);
    expect(h.logs.some((line) => line.level === 'warn' && line.stepId === 'empty')).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain('secret-123');
  });

  it('the start line masks free-text parameters (they may be passwords or codes)', async () => {
    const h = harness(script([tap('a')], { params: [{ key: 'mode', label: '模式', type: 'enum', options: [{ value: 'wood', label: '木' }] }] }));
    (h.ctx as unknown as { params: Record<string, string | number> }).params = { password: 'p@ss-777', mode: 'wood', count: 3 };
    await h.run();
    expect(JSON.stringify(h.logs)).not.toContain('p@ss-777');
    expect(h.logs[0]?.data).toMatchObject({ params: { password: '（8 字，已隐藏）', mode: 'wood', count: 3 } });
  });

  it('writes a Chinese finish summary before the final status', async () => {
    const h = harness(script([tap('a')]));
    await h.run();
    expect(h.logs.at(-1)?.message).toMatch(/^执行成功结束，耗时 \d+s：截图 1 次/);
    expect(h.statuses.at(-1)?.status).toBe('succeeded');
  });
});

describe('script engine: frame cache and stats', () => {
  it('an and/or over many template conditions costs exactly one capture', async () => {
    const vision = fakeVision((id) => id === 't5');
    const ids = ['t1', 't2', 't3', 't4', 't5'];
    const h = harness(script([{
      id: 'w', kind: 'waitFor', waitMs: 0,
      cond: { kind: 'and', all: [{ kind: 'or', any: ids.map((id) => ({ kind: 'template', templateId: id })) }, { kind: 'not', of: { kind: 'template', templateId: 't1' } }] },
    }], { templateSetId: 'set' }), { vision, templates: ids, context: { minCaptureIntervalMs: 400 } });
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.device.captures).toBe(1);
    expect(result.stats).toMatchObject({ captures: 1, matches: 6, matchHits: 1 });
  });

  it('an input invalidates the cached frame', async () => {
    const vision = fakeVision(() => true);
    const h = harness(script([
      { id: 'a', kind: 'tapTemplate', templateId: 'btn' },
      { id: 'b', kind: 'tapTemplate', templateId: 'btn' },
    ], { templateSetId: 'set' }), { vision, templates: ['btn'], context: { minCaptureIntervalMs: 0 } });
    const result = await h.run();
    expect(h.device.captures).toBe(2);
    expect(result.stats).toMatchObject({ taps: 2, matches: 2, matchHits: 2 });
    // Match centre (43, 23) in the reference canvas → device 86, 23 on a 200×100 frame.
    expect(h.device.actions).toEqual(['tap:86,23', 'tap:86,23']);
  });

  it('respects the minimum capture interval plus jitter between captures', async () => {
    const stamps: number[] = [];
    const device = fakeDevice({ async capture() { stamps.push(Date.now()); return frame(); } });
    const vision = fakeVision((_id, call) => call >= 3);
    const h = harness(script([{ id: 'w', kind: 'waitFor', cond: { kind: 'template', templateId: 'x' }, waitMs: 5000, pollMs: 50 }], { templateSetId: 'set' }),
      { device, vision, templates: ['x'], context: { minCaptureIntervalMs: 120, captureJitterMs: 30, random: () => 0.5 } });
    await h.run();
    expect(stamps).toHaveLength(3);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(130);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(130);
  });

  it('tapTemplate applies an offset in script space and reports hints on a miss', async () => {
    const vision = fakeVision(() => true);
    const h = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn', offset: { x: 5, y: -5 }, roi: { x: 0, y: 0, w: 50, h: 50 } }],
      { templateSetId: 'set' }), { vision, templates: ['btn'], context: { refWidth: 200, refHeight: 200 } });
    await h.run();
    // Script 100×100 → ref 200×200: offset (10, -10); centre (43, 23) → (53, 13) → device (53, 7) on 200×100.
    expect(h.device.actions).toEqual(['tap:53,7']);
    expect(vision.seen[0]?.roi).toEqual({ x: 0, y: 0, w: 100, h: 100 });

    const miss = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn' }], { templateSetId: 'set' }), { templates: ['btn'] });
    const result = await miss.run();
    expect(result.error).toContain('没找到模板「btn」');
    expect(result.error).toContain('ROI 是不是框小了');
  });

  it('an unknown template id fails with guidance', async () => {
    const result = await harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'nope' }])).run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('模板「nope」不在模板集里');
  });
});

describe('script engine: AI consult', () => {
  it('derives the expected templates from tapTemplate and waitFor', () => {
    expect(expectedTemplateIds({ id: 'a', kind: 'tapTemplate', templateId: 'x' })).toEqual(['x']);
    expect(expectedTemplateIds({
      id: 'b', kind: 'waitFor', waitMs: 1,
      cond: { kind: 'or', any: [{ kind: 'template', templateId: 'a' }, { kind: 'template', templateId: 'gone', present: false },
        { kind: 'and', all: [{ kind: 'anyTemplate', templateIds: ['b', 'a'] }, { kind: 'not', of: { kind: 'template', templateId: 'n' } }] }] },
    })).toEqual(['a', 'b']);
    expect(expectedTemplateIds({ id: 'c', kind: 'tap', at: { x: 1, y: 1 } })).toEqual([]);
  });

  it('asks once per step after retries, and a handled answer retries exactly once', async () => {
    const vision = fakeVision((_id, call) => call >= 3);
    const h = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn', retry: 1, retryDelayMs: 0 }], { templateSetId: 'set' }),
      { vision, templates: ['btn'], consult: async () => ({ handled: true, message: '关掉了活动弹窗', harvestedTemplateId: 'tpl_btn_close_popup' }) });
    const result = await h.run();
    expect(result.status).toBe('succeeded');
    expect(h.consults).toEqual([{ stepId: 'a', reason: expect.stringContaining('重试 1 次后仍然失败'), expectTemplateIds: ['btn'] }]);
    expect(h.logs.some((line) => line.message.includes('学到模板「tpl_btn_close_popup」'))).toBe(true);
  });

  it('skips onFail=continue and fails without retry when a human is needed', async () => {
    const skipped = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn', onFail: { kind: 'continue' } }], { templateSetId: 'set' }),
      { templates: ['btn'], consult: async () => ({ handled: true, message: 'x' }) });
    expect((await skipped.run()).status).toBe('succeeded');
    expect(skipped.consults).toHaveLength(0);

    const vision = fakeVision(() => false);
    const blocked = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn' }], { templateSetId: 'set' }),
      { vision, templates: ['btn'], consult: async () => ({ handled: false, requiresAttention: true, message: '检测到顶号弹窗' }) });
    const result = await blocked.run();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('检测到顶号弹窗');
    expect(vision.calls).toBe(1);
    expect(blocked.logs.find((line) => line.level === 'error' && line.stepId === 'a' && line.message.startsWith('步骤'))?.data).toMatchObject({ code: 'AI_RISK_BLOCKED' });
  });

  it('the whole-run limit does not wait for a pending advisor', async () => {
    const pending = new Promise<never>(() => undefined);
    const h = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn' }], { templateSetId: 'set' }),
      { templates: ['btn'], consult: () => pending, engine: { maxRunMs: 60 } });
    const started = Date.now();
    const result = await h.run();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.status).toBe('failed');
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('时间上限');
    expect(h.consults).toHaveLength(1);
  });

  it('a stop while the advisor is looking ends the run as aborted without retrying the step', async () => {
    const vision = fakeVision(() => false);
    const h = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn' }], { templateSetId: 'set' }),
      { vision, templates: ['btn'], consult: () => new Promise(() => undefined) });
    const running = h.run();
    for (let i = 0; i < 100 && !h.consults.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    h.engine.stop();
    const result = await running;
    expect(result.status).toBe('aborted');
    expect(vision.calls).toBe(1);
    expect(h.device.actions).toEqual([]);
  });

  it('a not-handled or throwing advisor leaves the original failure', async () => {
    const h = harness(script([{ id: 'a', kind: 'tapTemplate', templateId: 'btn' }], { templateSetId: 'set' }),
      { templates: ['btn'], consult: async () => { throw new Error('网络错误'); } });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.error).toContain('没找到模板');
  });
});
