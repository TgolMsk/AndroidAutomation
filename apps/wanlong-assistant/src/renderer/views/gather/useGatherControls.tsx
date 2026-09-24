import { useState, type ReactNode } from 'react';
import { useToast } from '../../components/Toasts';
import { BATCH_VERB, collectOutcome, describeBatchOutcome, type BatchKind, type BatchOutcome } from './batch';
import { EnableAutoDialog } from './EnableAutoDialog';
import type { GatherQueuesApi } from './queue-store';

export interface GatherControls {
  /** The auto switch: enabling opens the confirm dialog with a fresh probe verdict; disabling runs at once. */
  toggleAuto(index: number, enabled: boolean): Promise<void>;
  sample(index: number): Promise<void>;
  /** After the user confirmed 「恢复」. */
  resume(index: number): Promise<void>;
  /** Batch over targets already filtered by `batchTargets` (enabling goes through the confirm dialog). */
  runBatch(kind: BatchKind, targets: readonly number[], skipped: readonly string[]): Promise<void>;
  /** Render this somewhere in the page (the enable dialog). */
  dialog: ReactNode;
}

/**
 * The per-instance and batch gather actions shared by the overview cards and the instance table (original
 * useInstanceGather + the pages' handlers): the same scheduler calls, the same Chinese toasts.
 */
export function useGatherControls(gameId: string, packageName: string, queues: GatherQueuesApi, nameOf: (index: number) => string): GatherControls {
  const toast = useToast();
  const [enabling, setEnabling] = useState<{ targets: Array<{ index: number; name: string }>; skipped: readonly string[] } | null>(null);

  function report(verb: string, out: BatchOutcome, skipped: readonly string[]): void {
    const summary = describeBatchOutcome(verb, out) + (skipped.length ? ` 跳过：${skipped.join('；')}。` : '');
    toast.push({ kind: out.failed.length > 0 ? 'warn' : 'success', title: summary, duration: out.failed.length > 0 ? 10_000 : undefined });
  }

  async function toggleAuto(index: number, enabled: boolean): Promise<void> {
    if (enabled) {
      setEnabling({ targets: [{ index, name: nameOf(index) }], skipped: [] });
      return;
    }
    const error = await queues.setAuto(index, false);
    if (error) toast.error(`实例 #${index} 关闭自动采集失败`, error);
    else toast.push({ kind: 'success', title: `实例 #${index} 已关闭自动采集，不会再主动操作它。` });
  }

  async function sample(index: number): Promise<void> {
    const error = await queues.sample(index);
    if (error) toast.error(`实例 #${index} 采样失败`, error);
    else toast.push({ kind: 'success', title: `实例 #${index} 已重新读取「部队管理」面板。` });
  }

  async function resume(index: number): Promise<void> {
    const error = await queues.resume(index);
    if (error) toast.error(`实例 #${index} 恢复失败`, error);
    else {
      toast.push({ kind: 'success', title: `实例 #${index} 已恢复自动调度，正在重新读一次「部队管理」面板。` });
      void queues.reload();
    }
  }

  async function runBatch(kind: BatchKind, targets: readonly number[], skipped: readonly string[]): Promise<void> {
    const verb = BATCH_VERB[kind];
    if (targets.length === 0) {
      toast.push({ kind: 'info', title: `当前列表里没有可${verb}的实例${skipped.length ? `（${skipped.join('；')}）` : ''}。` });
      return;
    }
    if (kind === 'on') {
      // Enabling really dispatches troops later: show every target with a fresh probe verdict first.
      setEnabling({ targets: targets.map((index) => ({ index, name: nameOf(index) })), skipped });
      return;
    }
    // Concurrent: the scheduler holds one lock per instance; one failure never affects the others.
    const results = await Promise.all(targets.map(async (index) => ({
      index, reason: kind === 'sample' ? await queues.sample(index) : await queues.setAuto(index, false),
    })));
    report(verb, collectOutcome(results), skipped);
  }

  const dialog = enabling ? (
    <EnableAutoDialog gameId={gameId} packageName={packageName} targets={enabling.targets} skipped={enabling.skipped}
      onClose={() => setEnabling(null)}
      onDone={(out) => {
        const single = enabling.targets.length === 1 && enabling.skipped.length === 0;
        setEnabling(null);
        if (single && out.ok.length === 1) toast.push({ kind: 'success', title: `实例 #${out.ok[0]} 已开启自动采集，正在读一次「部队管理」面板。` });
        else if (single && out.failed.length === 1) toast.error(`实例 #${out.failed[0]!.index} 开启自动采集失败`, out.failed[0]!.reason);
        else report(BATCH_VERB.on, out, enabling.skipped);
      }} />
  ) : null;

  return { toggleAuto, sample, resume, runBatch, dialog };
}
