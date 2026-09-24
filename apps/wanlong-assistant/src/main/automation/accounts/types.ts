/**
 * Account and login contracts shared by main, preload and renderer. Types and pure helpers only: this file is
 * imported by the renderer, so it must never import runtime code.
 */

/** A per-script parameter value; the same shape plan tasks use for their overrides. */
export type ScriptParamValue = string | number | boolean;

/** Per-script parameter overrides stored on an account: `scriptParams[scriptId][key]`. */
export type ScriptParams = Record<string, Record<string, ScriptParamValue>>;

/**
 * The namespace inside `scriptParams` that holds the gather configuration as one JSON string
 * (`scriptParams.gather.configJson`, original `features/gather/configStorage.ts`). It is not a script id.
 */
export const GATHER_PARAM_SCOPE = 'gather';
export const GATHER_PARAM_KEY = 'configJson';

/** Account metadata is local to the user's Mac. Credentials are deliberately never persisted. */
export interface GameAccount {
  id: string;
  gameId: string;
  packageName: string;
  name: string;
  server: string;
  role: string;
  note: string;
  enabled: boolean;
  binding: { index: number; instanceCreatedAt: string } | null;
  login: {
    status: 'pending' | 'ready';
    attemptId: string | null;
    verifiedAt: number | null;
  };
  /** Script the plans / runs pages pre-select for this account (may point at a deleted script). */
  defaultScriptId?: string;
  /** Per-script parameter overrides (merged: script defaults < account < plan task < one-off request). */
  scriptParams?: ScriptParams;
  /** Id of the wanlong-panel account this one was imported from; importing the same file again skips it. */
  legacyId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountDetails {
  name: string;
  server?: string;
  role?: string;
  note?: string;
}

/** Editable account fields. `defaultScriptId: null` clears the default script. */
export interface AccountPatch extends Partial<AccountDetails> {
  defaultScriptId?: string | null;
}

/** Options of `accountBind`. */
export interface AccountBindOptions {
  /**
   * The user confirmed taking the instance from the account currently bound to it. That account is unbound,
   * reset to 「待登录」 and disabled. Without it, binding to an owned instance is refused (`ACCOUNT_SLOT_TAKEN`).
   */
  takeOver?: boolean;
}

export interface AccountBindResult {
  account: GameAccount;
  /** The account that lost the instance through a confirmed takeover. */
  displaced: { id: string; name: string } | null;
  /** Chinese follow-up message for the user (for example where the gather configuration went). */
  notice?: string;
}

export interface LoginScreen {
  step: 'phone' | 'code' | 'game' | 'manual';
  message: string;
  phoneMasked?: string;
  retryAt?: number;
}

export type LoginPhase = 'preparing' | 'starting' | 'awaitingLogin' | 'verifying' | 'completed' | 'cancelled' | 'failed';

export interface AccountLoginSession {
  id: string;
  accountId: string;
  accountName: string;
  gameId: string;
  index: number;
  phase: LoginPhase;
  message: string;
  screen?: LoginScreen;
  updatedAt: number;
}

export type AccountLoginCommand =
  | { requestId: string; action: 'inspect' }
  | { requestId: string; action: 'requestSms'; phone: string; agreementAccepted: boolean }
  | { requestId: string; action: 'submitCode'; code: string }
  | { requestId: string; action: 'resendCode' };

/** Keys the login preview may send (original `login:input` allow-list). */
export const LOGIN_INPUT_KEYS = [
  'BACK', 'HOME', 'ENTER', 'MENU', 'APP_SWITCH', 'DEL', 'ESCAPE', 'VOLUME_UP', 'VOLUME_DOWN',
] as const;
export type LoginInputKey = typeof LOGIN_INPUT_KEYS[number];

/** A point in the 2560×1440 reference space; main converts it with the device's screencap size. */
export interface LoginPoint { x: number; y: number }

/** Manual input from the login preview. Text is digits only (phone number or SMS code). */
export type LoginInput =
  | { kind: 'tap'; at: LoginPoint }
  | { kind: 'swipe'; at: LoginPoint; to: LoginPoint; durationMs: number }
  | { kind: 'key'; key: LoginInputKey }
  | { kind: 'text'; text: string };

/** One read-only preview frame of the instance being logged in. Never persisted. */
export interface LoginFrame {
  jpeg: Uint8Array;
  width: number;
  height: number;
  /** Device pixels of the screencap the preview was scaled from. */
  deviceWidth: number;
  deviceHeight: number;
  capturedAt: number;
  foregroundPackage: string | null;
}

/** Whether automation (gather, plans) may start on an instance, with the Chinese reason when not. */
export interface AutomationReadiness {
  ready: boolean;
  reason?: string;
}

/** One row of a legacy (wanlong-panel) accounts.json preview. */
export interface LegacyAccountPreview {
  oldId: string;
  name: string;
  note: string;
  /** False when the row is skipped (other game package, duplicate, invalid, imported before). */
  importable: boolean;
  /** Why the row is skipped, or for an importable row what was left out or changed (script params, the gather config). */
  reason?: string;
  /** The account a previous import created from this row (the row is skipped and mapped to it). */
  importedAs?: string;
  defaultScriptId?: string;
  scriptParamCount: number;
}

export interface LegacyAccountImport {
  entries: LegacyAccountPreview[];
  /**
   * Old account id → new account id, filled only when applied (rows imported before map to that account). Feed it
   * to the legacy plan importer.
   */
  idMap: Record<string, string>;
  applied: boolean;
  /** Accounts this call created (0 for a preview, or when every row was imported before). */
  created: number;
}

export function loginActive(phase: LoginPhase): boolean {
  return phase === 'preparing' || phase === 'starting' || phase === 'awaitingLogin' || phase === 'verifying';
}

/** Payload of the `account-changed` push event: the full account list of one game after any change. */
export interface AccountsChangedEvent {
  gameId: string;
  accounts: GameAccount[];
}

/** Whether the home check passed, with the template that proved it or the Chinese reason it did not. */
export type HomeVerdict = { ok: true; templateId: string; score: number } | { ok: false; reason: string };
