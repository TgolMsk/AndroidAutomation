import type { StatsPauseReality } from './service';

export interface PauseRealityDeps {
  /** The scheduler's auto switch for the index (its restored state; the only source of pause / resume facts). */
  isAuto(index: number): boolean;
  /** The AVD at the index; rejects with code INSTANCE_NOT_FOUND when there is none. */
  instance(index: number): Promise<unknown>;
}

/**
 * The `pauseStates` port of `StatsService`: auto on → 'resumed' (the resume fact was lost), no AVD → 'gone',
 * otherwise 'paused'. Anything it cannot tell is 'unknown' (the pause is kept).
 */
export function pauseRealityPort(deps: PauseRealityDeps): (indexes: readonly number[]) => Promise<ReadonlyMap<number, StatsPauseReality>> {
  return async (indexes) => {
    const out = new Map<number, StatsPauseReality>();
    for (const index of indexes) {
      try {
        if (deps.isAuto(index)) { out.set(index, 'resumed'); continue; }
        await deps.instance(index);
        out.set(index, 'paused');
      } catch (error) {
        out.set(index, (error as { code?: unknown } | null)?.code === 'INSTANCE_NOT_FOUND' ? 'gone' : 'unknown');
      }
    }
    return out;
  };
}
