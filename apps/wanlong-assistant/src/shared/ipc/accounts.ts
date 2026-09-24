/** Game accounts: details, instance binding, script parameters and the guided login session. */
import type {
  AccountBindOptions, AccountBindResult, AccountDetails, AccountLoginCommand, AccountLoginSession, AccountPatch,
  AccountsChangedEvent, AutomationReadiness, GameAccount, LoginFrame, LoginInput, ScriptParamValue,
} from '../../main/automation/accounts/types';
import type { Assert, ListsExactly } from './contract';

export interface AccountsApi {
  accountList(gameId: string): Promise<GameAccount[]>;
  accountCreate(gameId: string, details: AccountDetails & { defaultScriptId?: string | null }): Promise<GameAccount>;
  accountUpdate(id: string, patch: AccountPatch): Promise<GameAccount>;
  accountDelete(id: string): Promise<void>;
  /** Bind to any instance (or `null` to unbind); an owned instance needs `{ takeOver: true }` after confirmation. */
  accountBind(id: string, index: number | null, options?: AccountBindOptions): Promise<AccountBindResult>;
  accountSetEnabled(id: string, enabled: boolean): Promise<GameAccount>;
  /** Replace (or with `null` remove) the account's parameter overrides for one script. */
  accountSetScriptParams(id: string, scriptId: string, params: Record<string, ScriptParamValue> | null): Promise<GameAccount>;
  /** Whether gather / plans may start on the instance (base instance, active login, pending or stale account). */
  accountInstanceReadiness(gameId: string, index: number): Promise<AutomationReadiness>;
  /**
   * Start (or rejoin) the login wizard. For a new account pass a renderer-generated UUID as `id` plus its name;
   * retries with the same id never create a second account.
   */
  accountBeginLogin(gameId: string, index: number, id: string, newAccountName?: string): Promise<AccountLoginSession>;
  accountLoginSession(index: number): Promise<AccountLoginSession | null>;
  /** The latest session of every instance, for 「登录中」 labels. */
  accountLoginSessions(): Promise<AccountLoginSession[]>;
  accountLoginCommand(sessionId: string, command: AccountLoginCommand): Promise<AccountLoginSession>;
  /** Manual tap / swipe / key / digits from the embedded preview, serialized with the wizard's own commands. */
  accountLoginInput(sessionId: string, input: LoginInput): Promise<void>;
  /** One read-only preview frame of the instance being logged in (JPEG, never stored). */
  accountLoginFrame(sessionId: string): Promise<LoginFrame>;
  accountVerifyLogin(sessionId: string, identityConfirmed: boolean): Promise<AccountLoginSession>;
  accountCancelLogin(sessionId: string): Promise<void>;
}

export const ACCOUNTS_METHODS = [
  'accountList', 'accountCreate', 'accountUpdate', 'accountDelete', 'accountBind', 'accountSetEnabled',
  'accountSetScriptParams', 'accountInstanceReadiness',
  'accountBeginLogin', 'accountLoginSession', 'accountLoginSessions', 'accountLoginCommand', 'accountLoginInput',
  'accountLoginFrame', 'accountVerifyLogin', 'accountCancelLogin',
] as const satisfies readonly (keyof AccountsApi)[];

export interface AccountsEvents {
  /** The full account list of one game after any change (edit, bind, login prepare / complete, import). */
  'account-changed': AccountsChangedEvent;
  /** Every phase or message change of a login session; renderers keep the snapshot with the newest `updatedAt`. */
  'login-changed': AccountLoginSession;
}

export const ACCOUNTS_EVENTS = ['account-changed', 'login-changed'] as const satisfies readonly (keyof AccountsEvents)[];

export type AccountsContractCheck = [
  Assert<ListsExactly<AccountsApi, typeof ACCOUNTS_METHODS>>,
  Assert<ListsExactly<AccountsEvents, typeof ACCOUNTS_EVENTS>>,
];
