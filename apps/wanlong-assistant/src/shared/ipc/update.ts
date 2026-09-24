/**
 * In-app update from GitHub Releases (ported from wanlong-panel's `update:*` channel group). The state types live in
 * `../update` (import them from there; they are not re-exported through `shared/ipc`).
 */
import type { UpdateState } from '../update';
import type { Assert, ListsExactly } from './contract';

/**
 * None of these take renderer arguments: what to download, where to save it and which page to open are decided by
 * the main process, so a renderer can never point the updater at another URL or file.
 */
export interface UpdateApi {
  /**
   * Current state, with the busy answer asked again (the settings card and the sidebar entry read it once, then
   * follow `update-changed`).
   */
  updateState(): Promise<UpdateState>;
  /** Check GitHub once. Never fails: problems land in `phase: 'error'` with a Chinese `error`. */
  updateCheck(): Promise<UpdateState>;
  /** Download and verify the installer (only in phase `available`; `INVALID_ARGUMENT` otherwise). */
  updateDownload(): Promise<UpdateState>;
  /** Stop a running download; the partial file is kept so the next download resumes. */
  updateCancelDownload(): Promise<UpdateState>;
  /**
   * Open the verified installer and quit the assistant so the new app can be dragged over the old one.
   * Refused with `CONCURRENCY_LIMIT` while anything is busy (gather, script plan, login, SDK install).
   */
  updateInstall(): Promise<void>;
  /** Open the Release page of the newest version (or the Releases list) in the browser. */
  updateOpenReleasePage(): Promise<void>;
  /** Show the downloaded installer in Finder. */
  updateRevealDownload(): Promise<void>;
}

export const UPDATE_METHODS = [
  'updateState', 'updateCheck', 'updateDownload', 'updateCancelDownload', 'updateInstall', 'updateOpenReleasePage',
  'updateRevealDownload',
] as const satisfies readonly (keyof UpdateApi)[];

export interface UpdateEvents {
  /** The whole state after every change (check finished, download progress, failure). */
  'update-changed': UpdateState;
}

export const UPDATE_EVENTS = ['update-changed'] as const satisfies readonly (keyof UpdateEvents)[];

export type UpdateContractCheck = [
  Assert<ListsExactly<UpdateApi, typeof UPDATE_METHODS>>,
  Assert<ListsExactly<UpdateEvents, typeof UPDATE_EVENTS>>,
];
