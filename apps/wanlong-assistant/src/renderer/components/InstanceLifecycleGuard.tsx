import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { OccupancyHolder } from '../../shared/ipc';
import { lifecycleConfirmation, type LifecycleAction, type LifecycleConfirmation } from '../../shared/occupancy';
import { avdm } from '../api';
import { ConfirmDialog } from './ConfirmDialog';

export interface LifecycleRequest {
  action: LifecycleAction;
  indices: number[];
  /** The actual call (e.g. `avdm.stop(indices)` + toast); runs only after the user agreed, if asking was needed. */
  run: () => Promise<void> | void;
  /**
   * Ask even when nothing uses the instances (original 关闭 Popconfirm「关闭这个实例？/ 模拟器会被关机。」).
   * When the instances are busy, the occupancy question is asked instead (it already names what gets interrupted).
   */
  confirmIdle?: { title: string; message: string };
}

/** Holders of every index; indices whose query failed are returned separately (the dialog then asks anyway). */
export async function readOccupancy(indices: readonly number[]): Promise<{ holders: OccupancyHolder[]; unknown: number[] }> {
  const results = await Promise.all(indices.map(async (index) => {
    try { return { index, holders: await avdm.instanceOccupancy(index) }; }
    catch { return { index, holders: null }; }
  }));
  return {
    holders: results.flatMap((result) => result.holders ?? []),
    unknown: results.filter((result) => result.holders === null).map((result) => result.index),
  };
}

interface Settle {
  resolve(ran: boolean): void;
  reject(error: unknown): void;
}

/**
 * Instance lifecycle guard for the instances page: before stop / restart / remove, ask main who is using the
 * instances (gather, scheduler, login, script plans, another process's lease) and let the user confirm. Render
 * `dialog` somewhere in the page; `guard()` resolves true when the action ran, false when the user cancelled, and
 * rejects with the action's error when it failed (asked or not), so the caller's error toast always fires.
 */
export function useInstanceLifecycleGuard(): { guard: (request: LifecycleRequest) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<{ request: LifecycleRequest; confirmation: LifecycleConfirmation } | null>(null);
  const settle = useRef<Settle | null>(null);

  const guard = useCallback(async (request: LifecycleRequest): Promise<boolean> => {
    const { holders, unknown } = await readOccupancy(request.indices);
    const busy = lifecycleConfirmation(request.action, request.indices, holders, unknown);
    const confirmation = !busy.needed && request.confirmIdle
      ? { needed: true, title: request.confirmIdle.title, lines: [], warning: request.confirmIdle.message }
      : busy;
    if (!confirmation.needed) {
      await request.run();
      return true;
    }
    return new Promise<boolean>((resolve, reject) => {
      settle.current?.resolve(false);
      settle.current = { resolve, reject };
      setPending({ request, confirmation });
    });
  }, []);

  const close = () => {
    setPending(null);
    settle.current?.resolve(false);
    settle.current = null;
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.confirmation.title}
      danger
      confirmLabel={`${pending.confirmation.lines.length > 0 ? '仍然' : ''}${pending.request.action === 'remove' ? '删除' : pending.request.action === 'restart' ? '重启' : '关闭'}`}
      message={(
        <>
          {pending.confirmation.lines.length > 0 && <ul className="confirm-list">{pending.confirmation.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
          <p>{pending.confirmation.warning}</p>
        </>
      )}
      onConfirm={async () => {
        const done = settle.current;
        settle.current = null;
        // ★ Never swallowed: a failed stop / restart / remove rejects guard() so the page reports it in Chinese; the
        //   dialog then closes (ConfirmDialog closes after onConfirm resolves) instead of hanging with a spinner.
        try { await pending.request.run(); }
        catch (error) { done?.reject(error); return; }
        done?.resolve(true);
      }}
      onClose={close}
    />
  ) : null;

  return { guard, dialog };
}
