/**
 * The game-data module's `GameUpdateRecovery` (detect → one confirm tap after a fresh re-detection → ≤ 15 min
 * cancellable wait that never re-clicks) driven from main, with its template matching answered by the instance's
 * long-lived vision worker (query kind 'update'). The control flow (`handle` / `wait`) is the unchanged base class;
 * only `detect` / `progress` are routed, so OpenCV never runs on the main thread.
 */
import type { RawFrame } from '@avdm/automation';
import { GameUpdateRecovery, type GameUpdateRecoveryOptions } from '@avdm/automation/wanlong';

/** One frame's update verdict from the worker: the confirm button (2560×1440 reference) and the progress texts. */
export interface UpdateVerdict {
  target: { x: number; y: number } | null;
  /** 「下载中」 text visible. */
  downloading: boolean;
  /** 「下载中」 or 「校验中」 visible. */
  progress: boolean;
}

export const NO_UPDATE: UpdateVerdict = { target: null, downloading: false, progress: false };

export class WorkerUpdateRecovery extends GameUpdateRecovery {
  /** One worker question per frame object: `handle` / `wait` ask detect and progress about the same frame. */
  private readonly verdicts = new WeakMap<RawFrame, Promise<UpdateVerdict>>();

  constructor(private readonly lookup: (raw: RawFrame) => Promise<UpdateVerdict>, options: Omit<GameUpdateRecoveryOptions, 'templateDir'> = {}) {
    super({ ...options, templateDir: () => null });
  }

  private verdict(raw: RawFrame): Promise<UpdateVerdict> {
    let pending = this.verdicts.get(raw);
    if (!pending) {
      pending = this.lookup(raw);
      this.verdicts.set(raw, pending);
      pending.catch(() => this.verdicts.delete(raw));
    }
    return pending;
  }

  override async detect(raw: RawFrame): Promise<{ x: number; y: number } | null> {
    return (await this.verdict(raw)).target;
  }

  override async progress(raw: RawFrame, includeChecking: boolean): Promise<boolean> {
    const verdict = await this.verdict(raw);
    return includeChecking ? verdict.progress : verdict.downloading;
  }
}
