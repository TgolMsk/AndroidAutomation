import { describe, expect, it, vi } from 'vitest';
import { runServiceSteps, ServiceHealth } from '../src/main/lifecycle';

describe('isolated service lifecycle', () => {
  it('keeps starting the remaining services after one fails', async () => {
    const order: string[] = [];
    const log = vi.fn();
    const failures = await runServiceSteps('start', [
      { name: '自动续跑调度', run: async () => { order.push('schedules'); } },
      { name: '脚本计划', run: async () => { order.push('plans'); throw new Error('plans.json 损坏'); } },
      { name: '运行监控', run: () => { order.push('monitoring'); throw new Error('同步失败'); } },
      { name: '只读机器人', run: async () => { order.push('bot'); } },
    ], log);
    expect(order).toEqual(['schedules', 'plans', 'monitoring', 'bot']);
    expect(failures.map((failure) => failure.name)).toEqual(['脚本计划', '运行监控']);
    expect(log).toHaveBeenCalledWith('[wanlong] 脚本计划启动失败', expect.any(Error));
  });

  it('stops every service even when one throws, and survives a throwing logger', async () => {
    const stopped: string[] = [];
    const failures = await runServiceSteps('stop', [
      { name: 'A', run: () => { throw new Error('x'); } },
      { name: 'B', run: async () => { stopped.push('B'); } },
    ], () => { throw new Error('logger broke'); });
    expect(stopped).toEqual(['B']);
    expect(failures).toHaveLength(1);
  });

  it('logs only the message by default (no stack that could carry a credential URL)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runServiceSteps('stop', [{ name: '机器人', run: () => { throw new Error('网络失败'); } }]);
      expect(spy).toHaveBeenCalledWith('[wanlong] 机器人关闭失败', '网络失败');
    } finally { spy.mockRestore(); }
  });

  it('carries the impact of a failed start step', async () => {
    const failures = await runServiceSteps('start', [
      { name: '脚本计划', impact: '定时脚本不会自动运行', run: () => { throw new Error('坏文件'); } },
      { name: '运行监控', run: () => { throw new Error('x'); } },
    ], () => undefined);
    expect(failures.map(({ name, impact }) => ({ name, impact }))).toEqual([
      { name: '脚本计划', impact: '定时脚本不会自动运行' }, { name: '运行监控', impact: undefined },
    ]);
    expect('impact' in failures[1]!).toBe(false);
  });
});

describe('service start failures for the renderer', () => {
  it('keeps message-only entries, replaces a repeated service and pushes the whole list', () => {
    const notify = vi.fn();
    let now = 1_000;
    const health = new ServiceHealth(notify, () => now);
    health.report([]);
    expect(notify).not.toHaveBeenCalled();

    const secret = Object.assign(new Error('plans.json 损坏'), { stack: 'Error: https://api.telegram.org/bot123:SECRET/x', cause: 'token' });
    health.report([{ name: '脚本计划', impact: '定时脚本不会自动运行', error: secret }, { name: '只读机器人', error: 'boom' }]);
    expect(health.list()).toEqual([
      { name: '脚本计划', impact: '定时脚本不会自动运行', message: 'plans.json 损坏', at: 1_000 },
      { name: '只读机器人', message: 'boom', at: 1_000 },
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('SECRET');

    now = 2_000;
    health.report([{ name: '脚本计划', error: new Error('') }]);
    expect(health.list()).toEqual([
      { name: '只读机器人', message: 'boom', at: 1_000 },
      { name: '脚本计划', message: '未知错误', at: 2_000 },
    ]);
    expect(notify).toHaveBeenLastCalledWith(health.list());

    health.list()[0]!.message = 'changed';
    expect(health.list()[0]!.message).toBe('boom');
  });

  it('survives a notifier that throws (window already closed)', () => {
    const health = new ServiceHealth(() => { throw new Error('窗口已关闭'); });
    expect(() => health.report([{ name: '运行监控', error: new Error('x') }])).not.toThrow();
    expect(health.list()).toHaveLength(1);
  });
});
