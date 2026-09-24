import type { AccountsApi } from '../../shared/ipc';
import type { AccountManager } from '../automation/accounts';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, optionalIndex, text } from './validate';

export interface AccountsServices {
  accounts: AccountManager;
}

export const accountsHandlers: DomainHandlers<AccountsApi, AccountsServices> = {
  async accountList({ accounts }, gameId) { return accounts.list(game(gameId)); },
  async accountCreate({ accounts }, gameId, details) {
    return accounts.create(game(gameId), details);
  },
  async accountUpdate({ accounts }, id, patch) {
    return accounts.update(text(id, '账号 ID'), patch);
  },
  async accountDelete({ accounts }, id) { await accounts.remove(text(id, '账号 ID')); },
  async accountBind({ accounts }, id, index) {
    return accounts.bind(text(id, '账号 ID'), optionalIndex(index));
  },
  async accountSetEnabled({ accounts }, id, enabled) {
    return accounts.setEnabled(text(id, '账号 ID'), flag(enabled, '账号开关'));
  },
  async accountBeginLogin({ accounts }, gameId, index, id) {
    return accounts.beginLogin(game(gameId), asIndex(index), text(id, '账号 ID'));
  },
  async accountLoginSession({ accounts }, index) { return accounts.loginSession(asIndex(index)); },
  async accountLoginCommand({ accounts }, sessionId, command) {
    return accounts.loginCommand(text(sessionId, '登录会话 ID'), command);
  },
  async accountVerifyLogin({ accounts }, sessionId, identityConfirmed) {
    flag(identityConfirmed, '登录确认');
    return accounts.verifyLogin(text(sessionId, '登录会话 ID'), identityConfirmed);
  },
  async accountCancelLogin({ accounts }, sessionId) {
    await accounts.cancelLogin(text(sessionId, '登录会话 ID'));
  },
};
