/** Assistant application settings, data paths, self-check, logs and legacy data import. */
import type { Assert, ListsExactly } from './contract';

/** A background service that failed to start; the rest of the assistant keeps working without it. */
export interface ServiceFailure {
  /** Chinese service name, e.g. 「脚本计划」. */
  name: string;
  /** Error message only, never a stack (a stack or cause could carry a credential-bearing URL). */
  message: string;
  /** What the user loses while it is down, e.g. 「定时脚本不会自动运行」. */
  impact?: string;
  /** Epoch milliseconds of the failure. */
  at: number;
}

/** The app-shell module adds settings, paths, self-check, logs and legacy import here (and to `APP_METHODS`). */
export interface AppApi {
  /**
   * Services that failed to start since launch. `restore()` runs while the window is still loading, so the
   * `service-failures` push can arrive before anyone listens: the renderer reads this once on mount.
   */
  appServiceFailures(): Promise<ServiceFailure[]>;
}

export const APP_METHODS = ['appServiceFailures'] as const satisfies readonly (keyof AppApi)[];

export interface AppEvents {
  /** The complete current list, pushed whenever a service fails to start. */
  'service-failures': ServiceFailure[];
}

export const APP_EVENTS = ['service-failures'] as const satisfies readonly (keyof AppEvents)[];

export type AppContractCheck = [
  Assert<ListsExactly<AppApi, typeof APP_METHODS>>,
  Assert<ListsExactly<AppEvents, typeof APP_EVENTS>>,
];
