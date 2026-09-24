import { describe, expect, it } from 'vitest';
import type { InstanceState } from '@avdm/core';
import type { AutomationSchedule } from '../src/shared/ipc';
import { automationTargets, canLaunchOnTarget, pickGameId, pickTargetIndex } from '../src/renderer/state/selection';

function instance(index: number, status: InstanceState['status']): InstanceState {
  return { record: { index, name: `实例 ${index}` }, status } as InstanceState;
}

function schedule(index: number, enabled = true): AutomationSchedule {
  return { gameId: 'wanlong', index, enabled, nextWakeAt: null, failureCount: 0 };
}

describe('automation target safety', () => {
  it('keeps a stopped instance selectable to view and disable its saved schedule', () => {
    const stopped = instance(1, 'stopped');
    const running = instance(2, 'running');
    const targets = automationTargets([stopped, running], [schedule(1)], 'wanlong');
    expect(targets.map(({ index }) => index)).toEqual([1, 2]);
    expect(targets[0]?.instance).toBe(stopped);
    expect(canLaunchOnTarget(targets[0]?.instance)).toBe(false);
    expect(canLaunchOnTarget(targets[1]?.instance)).toBe(true);
  });

  it('exposes an enabled orphaned schedule for shutdown without allowing a launch', () => {
    const targets = automationTargets([], [schedule(3), schedule(4, false)], 'wanlong');
    expect(targets).toEqual([{ index: 3 }]);
    expect(canLaunchOnTarget(targets[0]?.instance)).toBe(false);
  });

  it('keeps the global selection while it exists and otherwise prefers a running instance', () => {
    const targets = automationTargets([instance(0, 'stopped'), instance(2, 'running')], [schedule(5)], 'wanlong');
    expect(pickTargetIndex(0, targets)).toBe(0);
    expect(pickTargetIndex(null, targets)).toBe(2);
    expect(pickTargetIndex(9, targets)).toBe(2);
    expect(pickTargetIndex(null, automationTargets([instance(1, 'stopped')], [], 'wanlong'))).toBe(1);
    expect(pickTargetIndex(null, automationTargets([], [schedule(5)], 'wanlong'))).toBe(5);
    expect(pickTargetIndex(3, [])).toBeNull();
  });

  it('keeps the current game while it is registered', () => {
    const games = [{ id: 'wanlong', name: '万龙觉醒', version: '1', packageName: 'p', tasks: [] }];
    expect(pickGameId('', games)).toBe('wanlong');
    expect(pickGameId('wanlong', games)).toBe('wanlong');
    expect(pickGameId('gone', [])).toBe('');
  });
});
