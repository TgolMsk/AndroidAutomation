import type { AccountsApi } from '../../shared/ipc';
import type { AccountManager } from '../automation/accounts';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, optionalIndex, patchObject, text } from './validate';

export interface AccountsServices {
  accounts: AccountManager;
}

/** Arguments are untrusted: shapes are checked here, contents again (strictly) in the store and the manager. */
export const accountsHandlers: DomainHandlers<AccountsApi, AccountsServices> = {
  async accountList({ accounts }, gameId) { return accounts.list(game(gameId)); },
  async accountCreate({ accounts }, gameId, details) {
    return accounts.create(game(gameId), patchObject(details, '账号资料'));
  },
  async accountUpdate({ accounts }, id, patch) {
    return accounts.update(text(id, '账号 ID'), patchObject(patch, '账号资料'));
  },
  async accountDelete({ accounts }, id) { await accounts.remove(text(id, '账号 ID')); },
  async accountBind({ accounts }, id, index, options) {
    if (options !== undefined && options !== null) patchObject(options, '绑定选项');
    const takeOver = options?.takeOver === undefined ? false : flag(options.takeOver, '改绑确认');
    return accounts.bind(text(id, '账号 ID'), optionalIndex(index), { takeOver });
  },
  async accountSetEnabled({ accounts }, id, enabled) {
    return accounts.setEnabled(text(id, '账号 ID'), flag(enabled, '账号开关'));
  },
  async accountSetScriptParams({ accounts }, id, scriptId, params) {
    return accounts.setScriptParams(text(id, '账号 ID'), text(scriptId, '脚本 ID'),
      params === null ? null : patchObject(params, '脚本参数'));
  },
  async accountInstanceReadiness({ accounts }, gameId, index) {
    return accounts.readiness(game(gameId), asIndex(index));
  },
  async accountBeginLogin({ accounts }, gameId, index, id, newAccountName) {
    const name = newAccountName === undefined || newAccountName === null ? undefined : text(newAccountName, '新账号名称');
    return accounts.beginLogin(game(gameId), asIndex(index), text(id, '账号 ID'), name);
  },
  async accountLoginSession({ accounts }, index) { return accounts.loginSession(asIndex(index)); },
  async accountLoginSessions({ accounts }) { return accounts.loginSessions(); },
  async accountLoginCommand({ accounts }, sessionId, command) {
    return accounts.loginCommand(text(sessionId, '登录会话 ID'), patchObject(command, '登录操作'));
  },
  async accountLoginInput({ accounts }, sessionId, input) {
    await accounts.loginInput(text(sessionId, '登录会话 ID'), patchObject(input, '登录输入'));
  },
  async accountLoginFrame({ accounts }, sessionId) {
    return accounts.loginFrame(text(sessionId, '登录会话 ID'));
  },
  async accountVerifyLogin({ accounts }, sessionId, identityConfirmed) {
    flag(identityConfirmed, '登录确认');
    return accounts.verifyLogin(text(sessionId, '登录会话 ID'), identityConfirmed);
  },
  async accountCancelLogin({ accounts }, sessionId) {
    await accounts.cancelLogin(text(sessionId, '登录会话 ID'));
  },
};
