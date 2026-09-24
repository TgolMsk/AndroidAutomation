/** Wording for the instance lifecycle guard (ask before stopping an instance someone is using). Pure. */
import type { OccupancyHolder } from './ipc';

export type LifecycleAction = 'start' | 'stop' | 'restart' | 'remove';

export const LIFECYCLE_ACTION_LABEL: Readonly<Record<LifecycleAction, string>> = {
  start: '启动',
  stop: '关闭',
  restart: '重启',
  remove: '删除',
};

/** 「实例 #N 正在运行采集、自动采集已开启」 for the holders of one instance, or null when nobody uses it. */
export function describeOccupancy(index: number, holders: readonly OccupancyHolder[]): string | null {
  const mine = holders.filter((holder) => holder.index === index);
  if (mine.length === 0) return null;
  return `实例 #${index} 正在${mine.map((holder) => holder.label).join('、')}`;
}

/**
 * Whether `action` on an instance with these holders needs an explicit confirmation. Starting never interrupts
 * anything; stopping, restarting or removing an instance that is being used (or has automation configured) does.
 */
export function lifecycleNeedsConfirm(action: LifecycleAction, holders: readonly OccupancyHolder[]): boolean {
  return action !== 'start' && holders.length > 0;
}

export interface LifecycleConfirmation {
  /** False when nothing uses the instances: run the action right away. */
  needed: boolean;
  title: string;
  /** One line per busy instance, e.g. 「实例 #1 正在运行采集」. */
  lines: string[];
  /** What happens when the user goes ahead. */
  warning: string;
}

/**
 * What to ask before `action` on `indices`. `holders` may include other instances (they are ignored); an index
 * whose occupancy could not be read is listed with `unknown` so the user still decides.
 */
export function lifecycleConfirmation(
  action: LifecycleAction, indices: readonly number[], holders: readonly OccupancyHolder[], unknown: readonly number[] = [],
): LifecycleConfirmation {
  const verb = LIFECYCLE_ACTION_LABEL[action];
  const lines: string[] = [];
  for (const index of indices) {
    const mine = holders.filter((holder) => holder.index === index);
    if (action !== 'start' && mine.length > 0) lines.push(describeOccupancy(index, mine)!);
    else if (action !== 'start' && unknown.includes(index)) lines.push(`实例 #${index} 的占用情况读取失败，无法确认是否有任务在运行`);
  }
  const blocking = holders.some((holder) => indices.includes(holder.index) && holder.blocking);
  return {
    needed: lines.length > 0,
    title: `确认${verb}${indices.length > 1 ? ` ${indices.length} 个实例` : `实例 #${indices[0] ?? ''}`}`,
    lines,
    warning: blocking
      ? `${verb}会打断正在进行的任务（采集、登录或脚本会失败并在下次重试），确定继续吗？`
      : `这些实例开启了自动化，${verb}后自动任务会因实例未运行而暂停执行，确定继续吗？`,
  };
}
