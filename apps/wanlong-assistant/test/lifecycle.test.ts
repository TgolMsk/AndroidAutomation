import { describe, expect, it, vi } from 'vitest';
import { runServiceSteps } from '../src/main/lifecycle';

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
});
