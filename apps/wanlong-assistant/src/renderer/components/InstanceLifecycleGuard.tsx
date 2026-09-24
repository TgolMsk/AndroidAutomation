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

/**
 * Instance lifecycle guard for the instances page: before stop / restart / remove, ask main who is using the
 * instances (gather, scheduler, login, script plans, another process's lease) and let the user confirm. Render
 * `dialog` somewhere in the page; `guard()` resolves true when the action ran, false when the user cancelled.
 */
export function useInstanceLifecycleGuard(): { guard: (request: LifecycleRequest) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<{ request: LifecycleRequest; confirmation: LifecycleConfirmation } | null>(null);
  const settle = useRef<((ran: boolean) => void) | null>(null);

  const guard = useCallback(async (request: LifecycleRequest): Promise<boolean> => {
    const { holders, unknown } = await readOccupancy(request.indices);
    const confirmation = lifecycleConfirmation(request.action, request.indices, holders, unknown);
    if (!confirmation.needed) {
      await request.run();
      return true;
    }
    return new Promise<boolean>((resolve) => {
      settle.current?.(false);
      settle.current = resolve;
      setPending({ request, confirmation });
    });
  }, []);

  const close = () => {
    setPending(null);
    settle.current?.(false);
    settle.current = null;
  };

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.confirmation.title}
      danger
      confirmLabel={`仍然${pending.request.action === 'remove' ? '删除' : pending.request.action === 'restart' ? '重启' : '关闭'}`}
      message={(
        <>
          <ul className="confirm-list">{pending.confirmation.lines.map((line) => <li key={line}>{line}</li>)}</ul>
          <p>{pending.confirmation.warning}</p>
        </>
      )}
      onConfirm={async () => {
        await pending.request.run();
        const done = settle.current;
        settle.current = null;
        done?.(true);
      }}
      onClose={close}
    />
  ) : null;

  return { guard, dialog };
}
