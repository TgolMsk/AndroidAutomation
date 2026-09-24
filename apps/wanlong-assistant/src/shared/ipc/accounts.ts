/** Game accounts: details, instance binding and the guided login session. */
import type { AccountDetails, AccountLoginCommand, AccountLoginSession, GameAccount } from '../../main/automation/accounts/types';
import type { Assert, ListsExactly } from './contract';

export interface AccountsApi {
  accountList(gameId: string): Promise<GameAccount[]>;
  accountCreate(gameId: string, details: AccountDetails): Promise<GameAccount>;
  accountUpdate(id: string, patch: Partial<AccountDetails>): Promise<GameAccount>;
  accountDelete(id: string): Promise<void>;
  accountBind(id: string, index: number | null): Promise<GameAccount>;
  accountSetEnabled(id: string, enabled: boolean): Promise<GameAccount>;
  accountBeginLogin(gameId: string, index: number, id: string): Promise<AccountLoginSession>;
  accountLoginSession(index: number): Promise<AccountLoginSession | null>;
  accountLoginCommand(sessionId: string, command: AccountLoginCommand): Promise<AccountLoginSession>;
  accountVerifyLogin(sessionId: string, identityConfirmed: boolean): Promise<AccountLoginSession>;
  accountCancelLogin(sessionId: string): Promise<void>;
}

export const ACCOUNTS_METHODS = [
  'accountList', 'accountCreate', 'accountUpdate', 'accountDelete', 'accountBind', 'accountSetEnabled',
  'accountBeginLogin', 'accountLoginSession', 'accountLoginCommand', 'accountVerifyLogin', 'accountCancelLogin',
] as const satisfies readonly (keyof AccountsApi)[];

/** No push events yet; the accounts-login module adds them here (and to `ACCOUNTS_EVENTS`). */
export interface AccountsEvents {}

export const ACCOUNTS_EVENTS = [] as const satisfies readonly (keyof AccountsEvents)[];

export type AccountsContractCheck = [
  Assert<ListsExactly<AccountsApi, typeof ACCOUNTS_METHODS>>,
  Assert<ListsExactly<AccountsEvents, typeof ACCOUNTS_EVENTS>>,
];
