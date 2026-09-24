/**
 * Pure helpers of the 模拟器实例 page (original views/InstancesView.tsx): search / status filter, the resolution
 * warning and the running count. Testable in Node.
 */
import type { InstanceSpec, InstanceState } from '@avdm/core';
import type { GameAccount } from '../../../main/automation/accounts/types';
import { accountOfIndex, isInstanceUp } from '../accounts/account-model';

export type StatusFilter = 'all' | 'up' | 'stopped';

/** Instances matching the search (name, index or bound account name) and the status filter, sorted by index. */
export function filterInstances(
  instances: readonly InstanceState[], accounts: readonly GameAccount[], query: string, status: StatusFilter,
): InstanceState[] {
  const term = query.trim().toLocaleLowerCase();
  return instances.filter((instance) => {
    const account = accountOfIndex(accounts, instance.record.index);
    const matches = !term || [instance.record.name, String(instance.record.index), account?.name ?? '']
      .some((text) => text.toLocaleLowerCase().includes(term));
    return matches && (status === 'all' || (status === 'up' ? isInstanceUp(instance) : !isInstanceUp(instance)));
  }).sort((a, b) => a.record.index - b.record.index);
}

/** Instances that count against the running limit (running, starting or booting). */
export function countUp(instances: readonly InstanceState[]): number {
  return instances.filter((instance) => isInstanceUp(instance)).length;
}

/**
 * The resolution warning (original 「分辨率不一致」 against exactly 2560×1440). AVDs may run scaled 16:9 frames, so
 * the check is: landscape-or-portrait 16:9, and at least 1920×1080 — below that the countdown / level OCR on the
 * 2560×1440 templates becomes unreliable (DECISIONS C「设备分辨率」). null = fine.
 */
export function resolutionWarning(spec: Pick<InstanceSpec, 'width' | 'height'> | undefined): { label: string; tip: string } | null {
  if (!spec || !(spec.width > 0) || !(spec.height > 0)) return null;
  const long = Math.max(spec.width, spec.height);
  const short = Math.min(spec.width, spec.height);
  const size = `${spec.width}×${spec.height}`;
  if (Math.abs(long / short - 16 / 9) > 0.02) {
    return {
      label: '比例不是 16:9',
      tip: `当前分辨率 ${size} 不是 16:9。模板都截自 2560×1440，比例不同会让所有匹配错位。请在「编辑配置」里改成 2560×1440（或至少 1920×1080）后重启实例。`,
    };
  }
  if (long < 1920 || short < 1080) {
    return {
      label: '分辨率偏低',
      tip: `当前分辨率 ${size} 低于 1920×1080。模板截自 2560×1440，画面缩得越小，倒计时、等级与坐标的数字识别越不可靠。建议在「编辑配置」里改成 2560×1440（或至少 1920×1080）后重启实例。`,
    };
  }
  return null;
}
