/**
 * Batch gather operations of the instance list (original InstancesView batchTargets + useInstanceGather
 * describeBatchOutcome). Pure: which filtered instances a batch touches, why the others are skipped, and the summary.
 */

/** The three items of the 「批量采集」 menu. */
export type BatchKind = 'on' | 'off' | 'sample';

export const BATCH_VERB: Readonly<Record<BatchKind, string>> = {
  on: '开启自动采集',
  off: '关闭自动采集',
  sample: '采样',
};

/** What the batch needs to know about one visible (filtered) instance. */
export interface BatchCandidate {
  index: number;
  /** Instance running (booted). */
  up: boolean;
  /** The alerts module has a pause record for it (never `!auto`). */
  paused: boolean;
  /** The game's base instance (only for cloning, never automated). */
  isBase: boolean;
  auto: boolean;
  /** Its switch is being toggled right now. */
  autoBusy: boolean;
  /** A sample is running (renderer anti-double-click or the scheduler's own flag). */
  sampling: boolean;
  /** A device operation is still finishing. */
  operating: boolean;
  /**
   * A script run holds the instance (plans module; scripts pre-empt gathering): the scheduler refuses a sample until it
   * ends, so a batch sample skips it instead of collecting refusals.
   */
  scriptRunning?: boolean;
}

/** Instances the batch really touches; the others grouped by reason, e.g. `未开机：#1、#3`. */
export function batchTargets(kind: BatchKind, candidates: readonly BatchCandidate[]): { targets: number[]; skipped: string[] } {
  const targets: number[] = [];
  const skip = new Map<string, number[]>();
  const skipAs = (reason: string, index: number): void => {
    const list = skip.get(reason) ?? [];
    list.push(index);
    skip.set(reason, list);
  };
  for (const c of candidates) {
    if (kind === 'off') {
      if (!c.auto) skipAs('本来就是关的', c.index);
      else if (c.autoBusy) skipAs('开关正在切换', c.index);
      else targets.push(c.index);
      continue;
    }
    if (!c.up) skipAs('未开机', c.index);
    else if (c.paused) skipAs('已被异常暂停，请单独点「恢复」', c.index);
    else if (kind === 'on' && c.isBase) skipAs('是基础实例', c.index);
    else if (kind === 'on' && c.auto) skipAs('本来就是开的', c.index);
    else if (kind === 'on' && c.autoBusy) skipAs('开关正在切换', c.index);
    else if (kind === 'sample' && c.sampling) skipAs('正在采样', c.index);
    else if (kind === 'sample' && c.operating) skipAs('设备操作中', c.index);
    else if (kind === 'sample' && c.scriptRunning) skipAs('脚本运行中（脚本优先）', c.index);
    else targets.push(c.index);
  }
  return { targets, skipped: [...skip].map(([reason, list]) => `${reason}：#${list.join('、#')}`) };
}

/** A batch's result: instances that succeeded plus failures with their Chinese reasons. */
export interface BatchOutcome {
  ok: number[];
  failed: Array<{ index: number; reason: string }>;
}

export function collectOutcome(results: ReadonlyArray<{ index: number; reason: string | null }>): BatchOutcome {
  const out: BatchOutcome = { ok: [], failed: [] };
  for (const r of results) {
    if (r.reason === null) out.ok.push(r.index);
    else out.failed.push({ index: r.index, reason: r.reason });
  }
  return out;
}

/** One Chinese sentence for the toast: 「已<verb> N 个实例（#a、#b）。M 个失败：#i 原因；…。」 */
export function describeBatchOutcome(verb: string, out: BatchOutcome): string {
  const parts: string[] = [];
  if (out.ok.length > 0) parts.push(`已${verb} ${out.ok.length} 个实例（#${out.ok.join('、#')}）`);
  if (out.failed.length > 0) parts.push(`${out.failed.length} 个失败：` + out.failed.map((f) => `#${f.index} ${f.reason}`).join('；'));
  return parts.join('。') + '。';
}

/**
 * Run `work` over `items` with at most `limit` in flight (batch enabling probes every instance: a capture plus a
 * worker each, so it is capped instead of the original's unbounded Promise.all). Results keep the input order.
 */
export async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
