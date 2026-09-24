import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAvdmError, withFileLock, type AdbDevice, type InstanceState } from '@avdm/core';
import type { RawFrame } from '@avdm/automation';
import type { ManagerHost } from '../../manager-host';
import type { AutomationHost } from '../host';
import { gamePlugin } from '../games';
import { gameLoginDriver } from './drivers';
import { previewLegacyAccounts } from './legacy';
import { LoginPreviewEncoder, type EncodedPreview } from './login-preview';
import { inputLoginDigits, LoginUserError } from './native-ui';
import { AccountError, AccountStore, accountDetails, isAccountId, isNewAccountId, slotTakenError, type BindOutcome } from './store';
import {
  GATHER_PARAM_KEY, GATHER_PARAM_SCOPE, LOGIN_INPUT_KEYS, loginActive,
  type AccountBindOptions, type AccountBindResult, type AccountDetails, type AccountLoginCommand,
  type AccountLoginSession, type AccountPatch, type AccountsChangedEvent, type AutomationReadiness, type GameAccount,
  type HomeVerdict, type LegacyAccountImport, type LoginFrame, type LoginInput, type LoginInputKey, type ScriptParamValue,
} from './types';

export type {
  AccountBindOptions, AccountBindResult, AccountDetails, AccountLoginCommand, AccountLoginSession, AccountPatch,
  AccountsChangedEvent, AutomationReadiness, GameAccount, LegacyAccountImport, LoginFrame, LoginInput,
} from './types';
export { AccountError } from './store';
export { LoginPreviewEncoder } from './login-preview';

/** Reference space of login preview coordinates (the game's 2560×1440 layout). */
const REF_WIDTH = 2560;
const REF_HEIGHT = 1440;
const MAX_LEGACY_FILE_BYTES = 4 * 1024 * 1024;
const INPUT_FAILED = '登录输入未完成，请检查设备连接后重试。';
const COMMAND_FAILED = '登录操作未完成，请检查实例连接后重试。';
const FRAME_FAILED = '画面读取失败，请检查实例连接后重试。';

/** A legacy-file refusal whose message is already the Chinese reason. */
class AccountFileError extends Error {}

interface Lease {
  release(): Promise<void>;
}

interface Task {
  view: AccountLoginSession;
  controller: AbortController;
  tail: Promise<unknown>;
  lease?: Lease;
  instanceCreatedAt?: string;
  commands: Map<string, { fingerprint: string; result: Promise<AccountLoginSession> }>;
  committing: boolean;
  /** Screencap size of the device, for converting reference coordinates; refreshed by every preview frame. */
  frameSize?: { width: number; height: number };
  frameInFlight?: Promise<LoginFrame>;
}

/** Ports the composition root wires; every one is optional so the manager stays testable with fakes. */
export interface AccountManagerPorts {
  /** Base instance of a game (index + creation identity), for 「基础实例不能登录 / 绑定 / 自动化」. */
  base?(gameId: string): Promise<{ index: number; createdAt: string } | null>;
  /** Read-only home proof of the game (city / world-map templates). Required to finish a login. */
  verifyHome?(gameId: string, index: number): Promise<HomeVerdict>;
  /**
   * Why the home proof cannot run on this instance (no template set), or null. Checked before the wizard takes the
   * instance: choosing a template set needs the same device lease the wizard holds until it ends.
   */
  homeCheckIssue?(gameId: string, index: number): Promise<string | null>;
  /**
   * The gather config saved on the instance, moved into an account when it is bound (original afterAccountBind).
   * ★ Wire it only together with gather settings that read the bound account first and fall back to the instance
   * (DECISIONS B「调度器」, see `gatherConfigFor` / `saveGatherConfig`). Unwired, binding copies nothing and says
   * nothing about the gather config, so there is never a second copy that nothing reads.
   */
  instanceGatherConfig?(gameId: string, index: number): Promise<Record<string, unknown> | null>;
  /** Preview encoder; defaults to a JPEG at 960 px width from the long-lived `login-preview-worker`. */
  encodePreview?(frame: RawFrame): Promise<EncodedPreview>;
  onAccountsChanged?(event: AccountsChangedEvent): void;
  onLoginChanged?(session: AccountLoginSession): void;
}

type AutomationPort = Pick<AutomationHost, 'setSchedule' | 'runs' | 'schedules'>;

function validCommand(command: AccountLoginCommand): void {
  if (!command || typeof command !== 'object' || typeof command.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(command.requestId)) throw new Error('登录请求编号无效');
  if (command.action === 'inspect' || command.action === 'resendCode') return;
  if (command.action === 'requestSms' && typeof command.phone === 'string' && /^1[3-9]\d{9}$/.test(command.phone) &&
    command.agreementAccepted === true) return;
  if (command.action === 'submitCode' && typeof command.code === 'string' && /^\d{6}$/.test(command.code)) return;
  throw new Error('登录操作无效，请检查手机号、验证码和协议确认');
}

function validPoint(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== 'object') return false;
  const { x, y } = value as { x: unknown; y: unknown };
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) &&
    x >= 0 && x <= REF_WIDTH && y >= 0 && y <= REF_HEIGHT;
}

/**
 * Manual preview input allowed during a login (original `login:input`): reference-space tap / swipe (50–2000 ms),
 * an allow-listed key, or digits only (phone number / SMS code). Rejects without echoing the input.
 */
export function validateLoginInput(input: unknown): LoginInput {
  const bad = (): never => { throw new Error('登录输入无效：只能点击、滑动画面、发送允许的按键或最多 32 位数字'); };
  if (!input || typeof input !== 'object') return bad();
  const value = input as Record<string, unknown>;
  switch (value.kind) {
    case 'tap':
      return validPoint(value.at) ? { kind: 'tap', at: { x: value.at.x, y: value.at.y } } : bad();
    case 'swipe': {
      const duration = value.durationMs;
      if (!validPoint(value.at) || !validPoint(value.to) || typeof duration !== 'number' || !Number.isInteger(duration) ||
        duration < 50 || duration > 2000) return bad();
      return { kind: 'swipe', at: { x: value.at.x, y: value.at.y }, to: { x: value.to.x, y: value.to.y }, durationMs: duration };
    }
    case 'key':
      return typeof value.key === 'string' && (LOGIN_INPUT_KEYS as readonly string[]).includes(value.key)
        ? { kind: 'key', key: value.key as LoginInputKey } : bad();
    case 'text':
      return typeof value.text === 'string' && /^\d{1,32}$/.test(value.text) ? { kind: 'text', text: value.text } : bad();
    default:
      return bad();
  }
}

/** Reference (2560×1440) → device pixels of the actual screencap, clamped inside the frame. */
export function toDevicePoint(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.min(size.width - 1, Math.max(0, Math.round(point.x * size.width / REF_WIDTH))),
    y: Math.min(size.height - 1, Math.max(0, Math.round(point.y * size.height / REF_HEIGHT))),
  };
}

/**
 * Resolves with `work`, or rejects as soon as the wizard is cancelled (original prepare polled with an abortable
 * sleep). The work itself keeps running: a boot that was already requested is not undone.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new LoginUserError('登录向导已结束。'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LoginUserError('登录向导已结束。'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function bindResult(result: BindOutcome & { notice?: string }): AccountBindResult {
  return {
    account: result.account,
    displaced: result.displaced ? { id: result.displaced.id, name: result.displaced.name } : null,
    ...(result.notice ? { notice: result.notice } : {}),
  };
}

/** A long-held lease stops a second process from running automation during account login. */
async function acquireLoginLease(home: string, index: number): Promise<Lease> {
  const lock = path.join(home, 'run', `automation-instance-${index}.lock`);
  let entered!: () => void;
  let exit!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { exit = resolve; });
  const lockDone = withFileLock(lock, async () => {
    entered();
    await held;
  }, { timeoutMs: 150 });
  try {
    await Promise.race([
      acquired,
      lockDone.then(() => { throw new Error('登录实例占用异常'); }),
    ]);
  } catch (error) {
    if (isAvdmError(error, 'LOCK_TIMEOUT')) {
      throw new Error(`实例 #${index} 正被采集、脚本计划或模板操作占用，请先结束后再登录`);
    }
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      exit();
      await lockDone;
    },
  };
}

/** Account metadata, the automation readiness gate and an interactive, device-scoped login coordinator. */
export class AccountManager {
  readonly store: AccountStore;
  private readonly tasks = new Map<number, Task>();
  private closing = false;
  private previewEncoder: LoginPreviewEncoder | null = null;

  constructor(
    private readonly host: Pick<ManagerHost, 'get'>,
    private readonly automation: AutomationPort,
    private readonly home: string,
    private readonly ports: AccountManagerPorts = {},
  ) {
    this.store = new AccountStore(home);
  }

  list(gameId: string): Promise<GameAccount[]> {
    gamePlugin(gameId);
    return this.store.list(gameId);
  }

  /** Push the full list of one game; observers never break the caller. */
  private notifyAccounts(gameId: string): void {
    const notify = this.ports.onAccountsChanged;
    if (!notify) return;
    void this.store.list(gameId).then((accounts) => {
      try { notify({ gameId, accounts }); } catch { /* Observers cannot break account edits. */ }
    }).catch((error: unknown) => console.warn('[wanlong/accounts] 刷新账号列表失败', error));
  }

  private notifyLogin(task: Task): void {
    try { this.ports.onLoginChanged?.(structuredClone(task.view)); } catch { /* Observers cannot break the wizard. */ }
  }

  private async isBase(gameId: string, index: number, createdAt: string): Promise<boolean> {
    const base = await this.ports.base?.(gameId);
    return Boolean(base && base.index === index && base.createdAt === createdAt);
  }

  /** The account bound to this instance whose binding still matches the AVD's creation identity. */
  async accountForInstance(gameId: string, index: number): Promise<GameAccount | null> {
    gamePlugin(gameId);
    let createdAt: string;
    try { createdAt = (await (await this.host.get()).getState(index)).record.createdAt; }
    catch (error) {
      if (isAvdmError(error, 'INSTANCE_NOT_FOUND')) return null;
      throw error;
    }
    return (await this.store.list(gameId)).find((account) => account.binding?.index === index &&
      account.binding.instanceCreatedAt === createdAt) ?? null;
  }

  /** Whether a login wizard is running on the instance (any game). */
  loginActiveOn(index: number): boolean {
    const task = this.tasks.get(index);
    return Boolean(task && loginActive(task.view.phase));
  }

  /**
   * Original `assertInstanceAutomationReady`: gather and plans must not start on the base instance, during a
   * login, or for a bound account whose login check is pending or whose AVD was replaced. An unbound instance
   * passes (gather then only reads the panel; plans need a ready account anyway).
   */
  async readiness(gameId: string, index: number): Promise<AutomationReadiness> {
    gamePlugin(gameId);
    if (this.loginActiveOn(index)) return { ready: false, reason: `实例 #${index} 正在进行账号登录，请先完成或结束登录向导` };
    let state: InstanceState;
    try { state = await (await this.host.get()).getState(index); }
    catch (error) {
      if (isAvdmError(error, 'INSTANCE_NOT_FOUND')) return { ready: false, reason: `实例 #${index} 不存在，请刷新实例列表` };
      throw error;
    }
    if (await this.isBase(gameId, index, state.record.createdAt)) {
      return { ready: false, reason: '基础实例用于克隆，请在副本中配置自动任务。' };
    }
    const account = (await this.store.list(gameId)).find((item) => item.binding?.index === index);
    if (account && (account.login.status !== 'ready' || account.binding?.instanceCreatedAt !== state.record.createdAt)) {
      return { ready: false, reason: `账号「${account.name}」尚未完成登录检查，或绑定实例已改变。请在账号登录向导中继续。` };
    }
    return { ready: true };
  }

  /** Throws the readiness reason; the scheduler / plans call this before any automatic device work. */
  async assertInstanceAutomationReady(gameId: string, index: number): Promise<void> {
    const result = await this.readiness(gameId, index);
    if (!result.ready) throw new Error(result.reason);
  }

  private assertEditable(accountId: string, indices: Array<number | null | undefined> = []): void {
    for (const task of this.tasks.values()) {
      if (loginActive(task.view.phase) &&
        (task.view.accountId === accountId || indices.includes(task.view.index))) {
        throw new Error('该账号或实例正在登录，请先结束登录向导再修改。');
      }
    }
  }

  /** Account edits share the device lease with login, gather and script plans, including other processes. */
  private async withAccountMutation<T>(
    accountId: string,
    extraIndices: Array<number | null | undefined>,
    action: (account: GameAccount) => Promise<T>,
  ): Promise<T> {
    const before = await this.store.get(accountId);
    if (!before) throw new Error('账号不存在');
    const indices = [before.binding?.index, ...extraIndices]
      .filter((index): index is number => index !== null && index !== undefined);
    return this.withLeases(accountId, indices, async () => {
      const current = await this.store.get(accountId);
      if (!current) throw new Error('账号已被其他进程删除，请刷新后重试');
      if (current.binding?.index !== before.binding?.index ||
          current.binding?.instanceCreatedAt !== before.binding?.instanceCreatedAt) {
        throw new Error('账号绑定已被其他进程修改，请刷新后重试');
      }
      return action(current);
    });
  }

  /** Take the device leases of `indices` in ascending order (no deadlock), re-checking the login guard inside. */
  private async withLeases<T>(accountId: string, list: number[], action: () => Promise<T>): Promise<T> {
    const indices = [...new Set(list)].sort((a, b) => a - b);
    this.assertEditable(accountId, indices);
    const enter = async (position: number): Promise<T> => {
      if (position < indices.length) {
        const index = indices[position]!;
        try {
          return await withFileLock(path.join(this.home, 'run', `automation-instance-${index}.lock`),
            () => enter(position + 1), { timeoutMs: 150 });
        } catch (error) {
          if (isAvdmError(error, 'LOCK_TIMEOUT')) {
            throw new Error(`实例 #${index} 正被登录、采集或脚本计划占用，请先结束任务后再修改账号`);
          }
          throw error;
        }
      }
      this.assertEditable(accountId, indices);
      return action();
    };
    return enter(0);
  }

  async create(gameId: string, details: AccountDetails & { defaultScriptId?: string | null }): Promise<GameAccount> {
    const game = gamePlugin(gameId);
    const account = await this.store.create(gameId, game.packageName, details, { defaultScriptId: details?.defaultScriptId });
    this.notifyAccounts(gameId);
    return account;
  }

  /**
   * Details and the default script never touch a device, so (like the original `account:save`) only a running
   * login blocks them, not a gather cycle or plan run holding the instance lease. Binding changes keep the lease.
   */
  async update(accountId: string, patch: AccountPatch): Promise<GameAccount> {
    const current = await this.store.get(accountId);
    if (!current) throw new Error('账号不存在');
    this.assertEditable(accountId, [current.binding?.index]);
    const account = await this.store.update(accountId, patch);
    this.notifyAccounts(account.gameId);
    return account;
  }

  /** Replace (or with `null` remove) the account's parameter overrides for one script. */
  async setScriptParams(accountId: string, scriptId: string, params: Record<string, ScriptParamValue> | null): Promise<GameAccount> {
    const account = await this.store.setScriptParams(accountId, scriptId, params);
    this.notifyAccounts(account.gameId);
    return account;
  }

  /** The account's overrides for one script (empty when none). */
  async scriptParams(accountId: string, scriptId: string): Promise<Record<string, ScriptParamValue>> {
    const account = await this.store.get(accountId);
    if (!account) throw new Error('账号不存在');
    return { ...(account.scriptParams?.[scriptId] ?? {}) };
  }

  async remove(accountId: string): Promise<void> {
    const gameId = await this.withAccountMutation(accountId, [], async (account) => {
      if (account.binding) await this.automation.setSchedule(account.gameId, account.binding.index, false);
      await this.store.remove(accountId);
      return account.gameId;
    });
    this.notifyAccounts(gameId);
  }

  /**
   * Bind (any instance, running or not) or unbind. Binding an instance owned by another account needs the user's
   * explicit `takeOver`; the displaced account's schedule on that instance is switched off first.
   */
  async bind(accountId: string, index: number | null, opts: AccountBindOptions = {}): Promise<AccountBindResult> {
    const takeOver = opts?.takeOver === true;
    const result = await this.withAccountMutation(accountId, [index], async (account) => {
      if (index === null) {
        if (account.binding) await this.automation.setSchedule(account.gameId, account.binding.index, false);
        const outcome = await this.store.bind(accountId, null);
        const hasGather = typeof outcome.account.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY] === 'string';
        const notice = hasGather && this.ports.instanceGatherConfig
          ? `已解除绑定。采集配置仍留在账号「${outcome.account.name}」里，绑回它就会回来。` : undefined;
        return { ...outcome, notice };
      }
      return this.bindInstance(account.gameId, account.id, account, index, takeOver);
    });
    this.notifyAccounts(result.account.gameId);
    return bindResult(result);
  }

  /**
   * Create an account and bind it in one transaction (original account:save with an instance). `accountId` is a
   * renderer-generated UUID kept across retries: a refused bind leaves no orphan account, and a retry after a lost
   * reply finds the account and binds (or keeps) it instead of creating a second one.
   */
  async createAndBind(gameId: string, index: number, accountId: string, details: AccountDetails,
    opts: AccountBindOptions = {}): Promise<AccountBindResult> {
    gamePlugin(gameId);
    if (!isNewAccountId(accountId)) throw new Error('账号编号无效');
    if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效');
    const names = accountDetails(details); // before any side effect (a takeover switches schedules off)
    const existing = await this.store.get(accountId);
    if (existing) {
      if (existing.gameId !== gameId) throw new AccountError('ACCOUNT_ID_TAKEN', '账号编号已被其他游戏的账号占用');
      return this.bind(accountId, index, opts);
    }
    const result = await this.withLeases(accountId, [index], () =>
      this.bindInstance(gameId, accountId, null, index, opts?.takeOver === true, names));
    this.notifyAccounts(gameId);
    return bindResult(result);
  }

  /**
   * The bind itself, inside the leases. ★ An owned instance is refused before any side effect, so a refused or
   * cancelled takeover leaves every schedule as it was; schedules are switched off only once the bind will happen.
   */
  private async bindInstance(gameId: string, accountId: string, account: GameAccount | null, index: number, takeOver: boolean,
    create?: AccountDetails): Promise<BindOutcome & { notice?: string }> {
    const game = gamePlugin(gameId);
    const state = await (await this.host.get()).getState(index);
    if (state.status === 'error' || state.record.provisioning) throw new Error(`实例 #${index} 未准备好（正在创建或处于错误状态）`);
    if (await this.isBase(gameId, index, state.record.createdAt)) {
      throw new Error('基础实例只用于克隆，不需要绑定账号。请在克隆出的副本中绑定并登录。');
    }
    const owner = (await this.store.list(gameId)).find((item) => item.id !== accountId && item.binding?.index === index);
    if (owner && !takeOver) throw slotTakenError(index, owner.name);
    const scheduled = new Set((await this.automation.schedules())
      .filter((entry) => entry.gameId === gameId && entry.enabled).map((entry) => entry.index));
    const notices: string[] = [];
    if (account?.binding && account.binding.index !== index) {
      await this.automation.setSchedule(gameId, account.binding.index, false);
      if (scheduled.has(account.binding.index)) notices.push(`原实例 #${account.binding.index} 的自动采集已随改绑关闭。`);
    }
    // ★ Unless this is the identical binding of a verified account, the bind leaves the account 「待登录」 and the
    // readiness gate would refuse every scheduled wake on this instance: switch its gather off now, say so.
    const pending = !(account && account.login.status === 'ready' && account.binding?.index === index &&
      account.binding.instanceCreatedAt === state.record.createdAt);
    if (owner || (pending && scheduled.has(index))) await this.automation.setSchedule(gameId, index, false);
    if (pending && scheduled.has(index)) {
      notices.push(`实例 #${index} 的自动采集已关闭：账号需要先在登录向导中完成登录检查，之后可在采集总览重新开启。`);
    }
    const binding = { index, instanceCreatedAt: state.record.createdAt };
    const outcome = await this.store.bind(accountId, binding,
      { takeOver, ...(create ? { create: { gameId, packageName: game.packageName, details: create } } : {}) });
    const gatherNotice = await this.moveGatherConfig(outcome.account, index);
    if (gatherNotice) notices.push(gatherNotice);
    return { ...outcome, ...(notices.length ? { notice: notices.join(' ') } : {}) };
  }

  /**
   * Original afterAccountBind: the instance's gather config moves into a newly bound account that has none, so
   * binding never looks like the settings were lost. An existing account config is never overwritten.
   */
  private async moveGatherConfig(account: GameAccount, index: number): Promise<string | undefined> {
    const read = this.ports.instanceGatherConfig;
    if (!read) return undefined;
    let config: Record<string, unknown> | null;
    try { config = await read(account.gameId, index); }
    catch { return '账号已绑定，但实例上保存的采集配置没能读取，请打开采集配置核对后重新保存。'; }
    if (!config || Object.keys(config).length === 0) return undefined;
    const existing = account.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY];
    const json = JSON.stringify(config);
    if (typeof existing === 'string' && existing.trim()) {
      return existing === json ? undefined
        : `账号「${account.name}」里本来就有一份采集配置，没有用实例上的那份覆盖。要用实例那份，请打开采集配置核对后重新保存。`;
    }
    try {
      const next = { ...(account.scriptParams?.[GATHER_PARAM_SCOPE] ?? {}), [GATHER_PARAM_KEY]: json };
      const saved = await this.store.setScriptParams(account.id, GATHER_PARAM_SCOPE, next);
      account.scriptParams = saved.scriptParams;
      return `实例上保存的采集配置已搬到账号「${account.name}」，以后跟着账号走。`;
    } catch (error) {
      return `账号已绑定，但采集配置没能搬进账号：${(error as Error).message}。打开采集配置点一次「保存」即可。`;
    }
  }

  /**
   * The gather config of the account bound to this instance (identity-checked), or null when the instance has no
   * current account or the account holds none. For gather settings: account first, instance config as fallback
   * (DECISIONS B「调度器」). A corrupt copy throws instead of silently falling back to the instance config.
   */
  async gatherConfigFor(gameId: string, index: number): Promise<{ accountId: string; accountName: string; config: Record<string, unknown> } | null> {
    const account = await this.accountForInstance(gameId, index);
    const json = account?.scriptParams?.[GATHER_PARAM_SCOPE]?.[GATHER_PARAM_KEY];
    if (!account || typeof json !== 'string' || !json.trim()) return null;
    let config: unknown;
    try { config = JSON.parse(json); } catch { config = null; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`账号「${account.name}」里保存的采集配置已损坏，请打开采集配置重新保存。`);
    }
    return { accountId: account.id, accountName: account.name, config: config as Record<string, unknown> };
  }

  /** Replace (or with `null` remove) the gather config stored on an account (`scriptParams.gather.configJson`). */
  async saveGatherConfig(accountId: string, config: Record<string, unknown> | null): Promise<GameAccount> {
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) throw new Error('采集配置无效');
    const account = await this.store.get(accountId);
    if (!account) throw new Error('账号不存在');
    const next: Record<string, ScriptParamValue> = { ...(account.scriptParams?.[GATHER_PARAM_SCOPE] ?? {}) };
    if (config === null) delete next[GATHER_PARAM_KEY];
    else next[GATHER_PARAM_KEY] = JSON.stringify(config);
    return this.setScriptParams(accountId, GATHER_PARAM_SCOPE, Object.keys(next).length > 0 ? next : null);
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<GameAccount> {
    const account = await this.withAccountMutation(accountId, [], async (current) => {
      if (enabled) {
        if (!current.binding) throw new Error('账号尚未绑定实例');
        const state = await (await this.host.get()).getState(current.binding.index);
        if (state.record.createdAt !== current.binding.instanceCreatedAt) throw new Error('原实例已被替换，请重新绑定并登录');
      } else if (current.binding) {
        await this.automation.setSchedule(current.gameId, current.binding.index, false);
      }
      return this.store.setEnabled(accountId, enabled);
    });
    this.notifyAccounts(account.gameId);
    return account;
  }

  /**
   * Preview (and with `apply`, import) a wanlong-panel accounts.json. Imported accounts are unbound, pending and
   * disabled; the returned id map lets the legacy plan importer point old plans at the new accounts. Import the
   * old scripts first and pass their old → new id map as `scriptIdMap`, so default scripts and parameter keys
   * point at the imported scripts (order: scripts, accounts, plans).
   */
  async importLegacyAccounts(gameId: string, file: string,
    opts: { apply: boolean; scriptIdMap?: Record<string, string> }): Promise<LegacyAccountImport> {
    const game = gamePlugin(gameId);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('旧账号文件路径必须是绝对路径');
    let json: string;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new AccountFileError(`所选路径不是文件，请选择旧版数据目录里的 accounts.json：${file}`);
      if (info.size > MAX_LEGACY_FILE_BYTES) throw new AccountFileError('旧账号文件超过 4 MB，未导入');
      json = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof AccountFileError) throw new Error(error.message);
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOENT' ? `找不到旧账号文件，请确认选择的是旧版数据目录里的 accounts.json：${file}`
        : code === 'EACCES' || code === 'EPERM' ? `没有权限读取旧账号文件，请检查文件权限：${file}`
          : `无法读取旧账号文件，请确认文件可以打开：${file}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(json); }
    catch { throw new Error(`旧账号文件不是合法 JSON：${file}`); }
    // ★ Import only adds (DECISIONS B「导入旧版数据」): rows imported before are skipped and mapped to that account.
    const imported = new Map((await this.store.list(gameId)).filter((item) => item.legacyId)
      .map((item) => [item.legacyId!, { id: item.id, name: item.name }]));
    const { entries, rows } = previewLegacyAccounts(raw, game.packageName, opts?.scriptIdMap, imported);
    const known = Object.fromEntries(entries.filter((entry) => entry.importedAs).map((entry) => [entry.oldId, entry.importedAs!]));
    if (!opts?.apply) return { entries, idMap: {}, applied: false, created: 0 };
    const result = rows.length ? await this.store.importLegacy(gameId, game.packageName, rows) : { idMap: {}, created: 0 };
    if (result.created > 0) this.notifyAccounts(gameId);
    return { entries, idMap: { ...known, ...result.idMap }, applied: true, created: result.created };
  }

  loginSession(index: number): AccountLoginSession | null {
    const task = this.tasks.get(index);
    return task ? structuredClone(task.view) : null;
  }

  /** The latest session of every instance (terminal ones included until the next begin). */
  loginSessions(): AccountLoginSession[] {
    return [...this.tasks.values()].map((task) => structuredClone(task.view)).sort((a, b) => a.index - b.index);
  }

  /**
   * Returns promptly; preparation continues in the background and pushes `login-changed`. For a new account the
   * renderer generates the UUID once, so 「继续登录」 after a failure reuses it instead of creating a duplicate.
   */
  beginLogin(gameId: string, index: number, accountId: string, newAccountName?: string): AccountLoginSession {
    const game = gamePlugin(gameId);
    if (!Number.isInteger(index) || index < 0 || index > 63 || !isAccountId(accountId)) {
      throw new Error('登录目标无效');
    }
    let newName: string | undefined;
    if (newAccountName !== undefined && newAccountName !== null) {
      if (typeof newAccountName !== 'string' || !newAccountName.trim() || newAccountName.trim().length > 100 ||
        /[\0\r\n]/.test(newAccountName) || !isNewAccountId(accountId)) throw new Error('新账号名称无效');
      newName = newAccountName.trim();
    }
    if (this.closing) throw new Error('应用正在退出');
    const current = this.tasks.get(index);
    if (current && loginActive(current.view.phase)) {
      if (current.view.accountId === accountId && current.view.gameId === gameId) return structuredClone(current.view);
      throw new Error('该实例已有登录向导');
    }
    this.assertEditable(accountId);
    const task: Task = {
      view: { id: randomUUID(), gameId, index, accountId, accountName: newName ?? '', phase: 'preparing',
        message: '正在检查基础实例、账号绑定与自动任务…', updatedAt: Date.now() },
      controller: new AbortController(), tail: Promise.resolve(), commands: new Map(), committing: false,
    };
    this.tasks.set(index, task);
    task.tail = this.prepare(task, game.packageName, newName).catch(async (error: unknown) => {
      if (task.controller.signal.aborted) return;
      this.updateSession(task, 'failed', (error as Error).message || '登录准备失败');
      await this.release(task);
    });
    this.notifyLogin(task);
    return structuredClone(task.view);
  }

  private updateSession(task: Task, phase: AccountLoginSession['phase'], message: string): void {
    task.view = { ...task.view, phase, message, updatedAt: Math.max(Date.now(), task.view.updatedAt + 1) };
    this.notifyLogin(task);
  }

  private check(task: Task): void {
    if (task.controller.signal.aborted) throw new LoginUserError('登录向导已结束。');
  }

  private async release(task: Task): Promise<void> {
    const lease = task.lease;
    task.lease = undefined;
    await lease?.release();
  }

  private async prepare(task: Task, packageName: string, newAccountName: string | undefined): Promise<void> {
    const { gameId, index, accountId } = task.view;
    const manager = await this.host.get();
    let state: InstanceState;
    try { state = await manager.getState(index); }
    catch (error) {
      if (isAvdmError(error, 'INSTANCE_NOT_FOUND')) throw new Error('实例不存在，请刷新实例列表。');
      throw error;
    }
    this.check(task);
    if (state.record.provisioning) throw new Error('实例仍在创建或克隆中，请稍后再登录。');
    // ★ Before any side effect: the base instance only serves as a clone source.
    if (await this.isBase(gameId, index, state.record.createdAt)) {
      throw new Error('这是基础实例，请先克隆副本，再在副本中登录账号。');
    }
    this.check(task);
    const account = await this.store.get(accountId);
    if (account) {
      if (account.gameId !== gameId || account.packageName !== packageName) throw new Error('账号和游戏不匹配');
      if (account.binding && (account.binding.index !== index || account.binding.instanceCreatedAt !== state.record.createdAt)) {
        throw new Error('该账号已绑定其他实例，或原实例已被替换，请先解除绑定。');
      }
    } else if (!newAccountName) {
      throw new Error('账号不存在，请刷新账号列表');
    }
    const owner = (await this.store.list(gameId)).find((item) => item.id !== accountId && item.binding?.index === index);
    if (owner) throw new Error(`实例已绑定「${owner.name}」，请使用该账号继续登录，或先解除原绑定。`);
    // Before the lease: once the wizard holds the instance, a template set can no longer be chosen for it.
    const issue = await this.ports.homeCheckIssue?.(gameId, index).catch(() => null);
    if (issue) throw new Error(issue);
    this.check(task);
    task.view.accountName = account?.name ?? newAccountName ?? '';
    // Pausing every game scheduled on this AVD avoids a background task changing the login screen; never auto-resumed.
    const schedules = await this.automation.schedules();
    for (const schedule of schedules.filter((entry) => entry.index === index && entry.enabled)) {
      await this.automation.setSchedule(schedule.gameId, schedule.index, false);
    }
    this.check(task);
    if ((await this.automation.runs()).some((run) => run.index === index &&
      (run.status === 'running' || run.status === 'stopping'))) {
      throw new Error('该实例正在运行自动化任务，请结束后再登录');
    }
    const lease = await acquireLoginLease(this.home, index);
    task.lease = lease;
    this.check(task);
    const prepared = await this.store.prepareLogin(accountId, { index, instanceCreatedAt: state.record.createdAt }, task.view.id,
      newAccountName ? { gameId, packageName, details: { name: newAccountName } } : undefined);
    task.view.accountName = prepared.name;
    task.instanceCreatedAt = state.record.createdAt;
    this.notifyAccounts(gameId);
    this.check(task);
    this.updateSession(task, 'starting', '正在启动实例和游戏，首次开机可能需要一两分钟…');
    if (state.status !== 'running') {
      // Core admission control (maxRunning / memory) refuses with its own Chinese message; the account stays pending.
      // A cancel (「稍后继续」, closing the drawer, quitting) lands at once instead of after the boot.
      state = await untilAborted(manager.start(index, { wait: true, timeoutMs: 120_000 }), task.controller.signal);
    }
    this.check(task);
    if (state.record.createdAt !== task.instanceCreatedAt) throw new Error('实例已被替换，请重新开始登录。');
    const device = await manager.device(index);
    if (!(await device.listPackages()).includes(packageName)) throw new Error('游戏尚未安装到该实例');
    this.check(task);
    // ★ Only monkey launches this game (am start "succeeds" without a process): startApp(pkg) with no activity.
    await device.startApp(packageName);
    this.check(task);
    this.updateSession(task, 'awaitingLogin', '请在游戏画面中完成登录、选择服务器与角色，再回到城内或世界地图检查。');
  }

  private require(sessionId: string): Task {
    const task = [...this.tasks.values()].find((entry) => entry.view.id === sessionId);
    if (!task || !loginActive(task.view.phase)) throw new Error('登录向导已结束，请重新打开');
    return task;
  }

  private async currentDevice(task: Task): Promise<AdbDevice> {
    const manager = await this.host.get();
    const state: InstanceState = await manager.getState(task.view.index);
    this.check(task);
    if (state.status !== 'running' || state.record.createdAt !== task.instanceCreatedAt) {
      throw new LoginUserError('实例已关闭或被替换，请重新开始登录');
    }
    const device = await manager.device(task.view.index);
    this.check(task);
    return device;
  }

  loginCommand(sessionId: string, command: AccountLoginCommand): Promise<AccountLoginSession> {
    validCommand(command);
    const task = this.require(sessionId);
    const driver = gameLoginDriver(task.view.gameId);
    if (!driver) throw new Error('该游戏尚未配置手机号登录步骤');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const previous = task.commands.get(command.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('同一请求编号不能用于不同操作');
      return previous.result;
    }
    if (task.commands.size >= 200) throw new Error('本次向导操作过多，请关闭后重新继续登录');
    const operation = task.tail.then(async () => {
      this.check(task);
      if (task.view.phase !== 'awaitingLogin') throw new LoginUserError('请等待游戏启动完成');
      try {
        const device = await this.currentDevice(task);
        const screen = await driver.command(device, gamePlugin(task.view.gameId).packageName,
          command, task.controller.signal);
        this.check(task);
        task.view.screen = screen;
        this.updateSession(task, 'awaitingLogin', screen.message);
        return structuredClone(task.view);
      } catch (error) {
        // ★ Core adb errors quote the full argv (`input text <phone>`): only our own messages may leave.
        if (error instanceof LoginUserError) throw error;
        if (task.controller.signal.aborted) throw new LoginUserError('登录向导已结束。');
        throw new LoginUserError(COMMAND_FAILED);
      }
    });
    task.commands.set(command.requestId, { fingerprint, result: operation });
    task.tail = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Manual input from the embedded preview. Queued on the session tail (serialized with SDK commands), re-checks
   * the phase and the AVD identity before touching the device, and never echoes the input in an error.
   */
  loginInput(sessionId: string, raw: LoginInput): Promise<void> {
    let input: LoginInput;
    let task: Task;
    try { input = validateLoginInput(raw); task = this.require(sessionId); }
    catch (error) { return Promise.reject(error); }
    const packageName = gamePlugin(task.view.gameId).packageName;
    const operation = task.tail.then(async () => {
      this.check(task);
      if (task.view.phase !== 'awaitingLogin') throw new LoginUserError('请等待游戏启动完成再操作。');
      try {
        const device = await this.currentDevice(task);
        if (input.kind !== 'key' && await device.foregroundPackage() !== packageName) {
          throw new LoginUserError('游戏未处于前台，已拒绝点击和输入。可先发送「返回」键回到游戏。');
        }
        if (input.kind === 'text') await inputLoginDigits(device, input.text);
        else if (input.kind === 'key') await device.keyevent(input.key);
        else {
          const size = task.frameSize ?? await (async () => {
            const frame = await device.screencapRaw();
            return (task.frameSize = { width: frame.width, height: frame.height });
          })();
          const at = toDevicePoint(input.at, size);
          if (input.kind === 'tap') await device.tap(at.x, at.y);
          else {
            const to = toDevicePoint(input.to, size);
            await device.swipe(at.x, at.y, to.x, to.y, input.durationMs);
          }
        }
      } catch (error) {
        if (error instanceof LoginUserError) throw error;
        throw new LoginUserError(INPUT_FAILED);
      }
      this.check(task);
    });
    task.tail = operation.catch(() => undefined);
    return operation;
  }

  /** One read-only preview frame (any foreground app, so system dialogs stay visible). Never stored. */
  loginFrame(sessionId: string): Promise<LoginFrame> {
    let task: Task;
    try { task = this.require(sessionId); }
    catch (error) { return Promise.reject(error); }
    if (task.view.phase !== 'awaitingLogin' && task.view.phase !== 'verifying') {
      return Promise.reject(new LoginUserError('游戏启动后才能显示画面'));
    }
    if (task.frameInFlight) return task.frameInFlight;
    const encode = this.ports.encodePreview ?? ((raw: RawFrame) => (this.previewEncoder ??= new LoginPreviewEncoder()).encode(raw));
    const frame = (async (): Promise<LoginFrame> => {
      try {
        const device = await this.currentDevice(task);
        const foregroundPackage = await device.foregroundPackage().catch(() => undefined) ?? null;
        const raw = await device.screencapRaw();
        task.frameSize = { width: raw.width, height: raw.height };
        const preview = await encode(raw);
        return { ...preview, deviceWidth: raw.width, deviceHeight: raw.height, capturedAt: raw.capturedAt, foregroundPackage };
      } catch (error) {
        if (error instanceof LoginUserError) throw error;
        throw new LoginUserError(FRAME_FAILED);
      }
    })().finally(() => { task.frameInFlight = undefined; });
    task.frameInFlight = frame;
    return frame;
  }

  verifyLogin(sessionId: string, identityConfirmed: boolean): Promise<AccountLoginSession> {
    if (identityConfirmed !== true) return Promise.reject(new Error('请先确认游戏中的账号、服务器与角色正确。'));
    const task = this.require(sessionId);
    const operation = task.tail.then(async () => {
      this.check(task);
      if (task.view.phase !== 'awaitingLogin') throw new Error('请先完成游戏登录');
      this.updateSession(task, 'verifying', '正在检查是否已进入城内或世界地图…');
      try {
        await this.currentDevice(task);
        const verify = this.ports.verifyHome;
        if (!verify) throw new Error('该游戏没有登录验证适配器');
        const verdict = await verify(task.view.gameId, task.view.index);
        this.check(task);
        if (!verdict.ok) throw new Error(verdict.reason);
        // Home verified: the write below is a commit phase. A cancel waits for it, so an enabled account never
        // shows as cancelled.
        task.committing = true;
        try {
          await this.store.completeLogin(task.view.accountId,
            { index: task.view.index, instanceCreatedAt: task.instanceCreatedAt! }, task.view.id);
        } finally { task.committing = false; }
        this.notifyAccounts(task.view.gameId);
        this.updateSession(task, 'completed', '已检查游戏主界面并启用账号。自动采集不会自动开启，可前往采集总览设置。');
        await this.release(task);
      } catch (error) {
        if (!task.controller.signal.aborted) this.updateSession(task, 'awaitingLogin', (error as Error).message);
        throw error;
      }
      return structuredClone(task.view);
    });
    task.tail = operation.catch(() => undefined);
    return operation;
  }

  async cancelLogin(sessionId: string): Promise<void> {
    const task = [...this.tasks.values()].find((entry) => entry.view.id === sessionId);
    if (!task || !loginActive(task.view.phase)) return;
    if (task.committing) {
      await task.tail;
      if (!loginActive(task.view.phase)) return;
    }
    task.controller.abort();
    await task.tail;
    if (!loginActive(task.view.phase)) return;
    this.updateSession(task, 'cancelled', '登录向导已结束，账号和实例已保留，可稍后继续。');
    await this.release(task);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.tasks.values()].map((task) => this.cancelLogin(task.view.id)));
    await this.previewEncoder?.dispose();
  }
}
