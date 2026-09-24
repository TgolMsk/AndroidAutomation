import type { AppToast } from '../../shared/ipc';

/** Toasts older than this are not replayed to a window that loads late. */
export const TOAST_REPLAY_MS = 3 * 60_000;
const MAX_KEPT = 20;

export type AppToastInput = Omit<AppToast, 'id' | 'at'>;

/**
 * Main→renderer notices (original `app:toast`): a service that failed to start, self-check problems … Startup work
 * runs while the window is still loading, so recent toasts are kept for a few minutes and the renderer reads them
 * once on mount (`recent()`); ids let it show each one exactly once.
 */
export class AppToasts {
  private nextId = 1;
  private kept: AppToast[] = [];

  constructor(private readonly emit: (toast: AppToast) => void = () => undefined, private readonly now: () => number = Date.now) {}

  push(input: AppToastInput): AppToast {
    const toast: AppToast = { ...input, id: this.nextId++, at: this.now() };
    if (!toast.detail) delete toast.detail;
    if (!toast.view) delete toast.view;
    this.kept = [...this.kept.filter((item) => this.now() - item.at <= TOAST_REPLAY_MS), toast].slice(-MAX_KEPT);
    try { this.emit(toast); }
    catch { /* A closed window must not break the caller. */ }
    return { ...toast };
  }

  recent(): AppToast[] {
    const now = this.now();
    return this.kept.filter((item) => now - item.at <= TOAST_REPLAY_MS).map((item) => ({ ...item }));
  }
}
