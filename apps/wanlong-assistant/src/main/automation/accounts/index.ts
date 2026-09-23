import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isAvdmError, withFileLock, type InstanceState } from '@avdm/core';
import type { ManagerHost } from '../../manager-host';
import type { AutomationHost } from '../host';
import { gamePlugin } from '../games';
import { gameLoginDriver } from './drivers';
import { AccountStore } from './store';
import { loginActive, type AccountDetails, type AccountLoginCommand,
  type AccountLoginSession, type GameAccount } from './types';

export type { AccountDetails, AccountLoginCommand, AccountLoginSession, GameAccount } from './types';

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
}

function validCommand(command: AccountLoginCommand): void {
  if (!command || typeof command !== 'object' || typeof command.requestId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(command.requestId)) throw new Error('登录请求编号无效');
  if (command.action === 'inspect' || command.action === 'resendCode') return;
  if (command.action === 'requestSms' && /^1[3-9]\d{9}$/.test(command.phone) && command.agreementAccepted === true) return;
  if (command.action === 'submitCode' && /^\d{6}$/.test(command.code)) return;
  throw new Error('登录操作无效，请检查手机号、验证码和协议确认');
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
  await Promise.race([
    acquired,
    lockDone.then(() => { throw new Error('登录实例占用异常'); }),
  ]);
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

/** Account metadata and an interactive, device-scoped login coordinator. */
export class AccountManager {
  readonly store: AccountStore;
  private readonly tasks = new Map<number, Task>();
  private closing = false;

  constructor(
    private readonly host: Pick<ManagerHost, 'get'>,
    private readonly automation: Pick<AutomationHost, 'setSchedule' | 'probe' | 'runs' | 'schedules'>,
    private readonly home: string,
  ) {
    this.store = new AccountStore(home);
  }

  list(gameId: string): Promise<GameAccount[]> {
    gamePlugin(gameId);
    return this.store.list(gameId);
  }

  private assertEditable(accountId: string, indices: Array<number | null | undefined> = []): void {
    for (const task of this.tasks.values()) {
      if (loginActive(task.view.phase) &&
        (task.view.accountId === accountId || indices.includes(task.view.index))) {
        throw new Error('该账号或实例正在登录，请先结束登录向导');
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
    const indices = [...new Set([before.binding?.index, ...extraIndices]
      .filter((index): index is number => index !== null && index !== undefined))].sort((a, b) => a - b);
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
      const current = await this.store.get(accountId);
      if (!current) throw new Error('账号已被其他进程删除，请刷新后重试');
      if (current.binding?.index !== before.binding?.index ||
          current.binding?.instanceCreatedAt !== before.binding?.instanceCreatedAt) {
        throw new Error('账号绑定已被其他进程修改，请刷新后重试');
      }
      return action(current);
    };
    return enter(0);
  }

  create(gameId: string, details: AccountDetails): Promise<GameAccount> {
    const game = gamePlugin(gameId);
    return this.store.create(gameId, game.packageName, details);
  }

  async update(accountId: string, patch: Partial<AccountDetails>): Promise<GameAccount> {
    return this.withAccountMutation(accountId, [], () => this.store.update(accountId, patch));
  }

  async remove(accountId: string): Promise<void> {
    await this.withAccountMutation(accountId, [], async (account) => {
      if (account.binding) await this.automation.setSchedule(account.gameId, account.binding.index, false);
      await this.store.remove(accountId);
    });
  }

  async bind(accountId: string, index: number | null): Promise<GameAccount> {
    return this.withAccountMutation(accountId, [index], async (account) => {
      if (account.binding && account.binding.index !== index) {
        await this.automation.setSchedule(account.gameId, account.binding.index, false);
      }
      if (index === null) return this.store.bind(accountId, null);
      const state = await (await this.host.get()).getState(index);
      if (state.status === 'error' || state.record.provisioning) throw new Error('实例未准备好');
      if (account.gameId !== gamePlugin(account.gameId).id) throw new Error('账号游戏不存在');
      return this.store.bind(accountId, { index, instanceCreatedAt: state.record.createdAt });
    });
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<GameAccount> {
    return this.withAccountMutation(accountId, [], async (account) => {
      if (enabled) {
        if (!account.binding) throw new Error('账号尚未绑定实例');
        const state = await (await this.host.get()).getState(account.binding.index);
        if (state.record.createdAt !== account.binding.instanceCreatedAt) throw new Error('原实例已被替换，请重新绑定并登录');
      } else if (account.binding) {
        await this.automation.setSchedule(account.gameId, account.binding.index, false);
      }
      return this.store.setEnabled(accountId, enabled);
    });
  }

  loginSession(index: number): AccountLoginSession | null {
    const task = this.tasks.get(index);
    return task ? structuredClone(task.view) : null;
  }

  /** Returns promptly; preparation continues in the background and the renderer polls the session. */
  beginLogin(gameId: string, index: number, accountId: string): AccountLoginSession {
    const game = gamePlugin(gameId);
    if (!Number.isInteger(index) || index < 0 || index > 63 || typeof accountId !== 'string') {
      throw new Error('登录目标无效');
    }
    if (this.closing) throw new Error('应用正在退出');
    const current = this.tasks.get(index);
    if (current && loginActive(current.view.phase)) {
      if (current.view.accountId === accountId && current.view.gameId === gameId) return structuredClone(current.view);
      throw new Error('该实例已有登录向导');
    }
    this.assertEditable(accountId);
    const task: Task = {
      view: { id: randomUUID(), gameId, index, accountId, accountName: '', phase: 'preparing',
        message: '正在检查账号、实例与采集状态…', updatedAt: Date.now() },
      controller: new AbortController(), tail: Promise.resolve(), commands: new Map(), committing: false,
    };
    this.tasks.set(index, task);
    task.tail = this.prepare(task, game.packageName).catch(async (error: unknown) => {
      if (task.controller.signal.aborted) return;
      this.updateSession(task, 'failed', (error as Error).message || '登录准备失败');
      await this.release(task);
    });
    return structuredClone(task.view);
  }

  private updateSession(task: Task, phase: AccountLoginSession['phase'], message: string): void {
    task.view = { ...task.view, phase, message, updatedAt: Math.max(Date.now(), task.view.updatedAt + 1) };
  }

  private check(task: Task): void {
    if (task.controller.signal.aborted) throw new Error('登录向导已取消');
  }

  private async release(task: Task): Promise<void> {
    const lease = task.lease;
    task.lease = undefined;
    await lease?.release();
  }

  private async prepare(task: Task, packageName: string): Promise<void> {
    const signal = task.controller.signal;
    const manager = await this.host.get();
    let state = await manager.getState(task.view.index);
    this.check(task);
    if (state.record.provisioning) throw new Error('实例仍在创建中');
    const account = await this.store.get(task.view.accountId);
    if (!account || account.gameId !== task.view.gameId || account.packageName !== packageName) {
      throw new Error('账号和游戏不匹配');
    }
    task.view.accountName = account.name;
    if (account.binding && (account.binding.index !== task.view.index ||
      account.binding.instanceCreatedAt !== state.record.createdAt)) {
      throw new Error('该账号已绑定其他实例，或原实例已被替换，请先解除绑定');
    }
    // Pausing every game scheduled on this AVD avoids a background task changing the login screen.
    const schedules = await this.automation.schedules();
    for (const schedule of schedules.filter((entry) => entry.index === task.view.index && entry.enabled)) {
      await this.automation.setSchedule(schedule.gameId, schedule.index, false);
    }
    this.check(task);
    if ((await this.automation.runs()).some((run) => run.index === task.view.index &&
      (run.status === 'running' || run.status === 'stopping'))) {
      throw new Error('该实例正在运行自动化任务，请结束后再登录');
    }
    const lease = await acquireLoginLease(this.home, task.view.index);
    task.lease = lease;
    this.check(task);
    await this.store.prepareLogin(account.id,
      { index: task.view.index, instanceCreatedAt: state.record.createdAt }, task.view.id);
    task.instanceCreatedAt = state.record.createdAt;
    this.updateSession(task, 'starting', '正在启动实例和游戏，首次开机可能需要一两分钟…');
    if (state.status !== 'running') {
      state = await manager.start(task.view.index, { wait: true, timeoutMs: 120_000 });
    }
    this.check(task);
    if (state.record.createdAt !== task.instanceCreatedAt) throw new Error('实例已被替换，请重新开始登录');
    const device = await manager.device(task.view.index);
    if (!(await device.listPackages()).includes(packageName)) throw new Error('游戏尚未安装到该实例');
    await device.startApp(packageName);
    this.check(task);
    this.updateSession(task, 'awaitingLogin', '游戏已启动。请完成手机号、服务器和角色登录，随后检查主界面。');
  }

  private require(sessionId: string): Task {
    const task = [...this.tasks.values()].find((entry) => entry.view.id === sessionId);
    if (!task || !loginActive(task.view.phase)) throw new Error('登录向导已结束，请重新打开');
    return task;
  }

  private async currentDevice(task: Task) {
    const manager = await this.host.get();
    const state: InstanceState = await manager.getState(task.view.index);
    this.check(task);
    if (state.status !== 'running' || state.record.createdAt !== task.instanceCreatedAt) {
      throw new Error('实例已关闭或被替换，请重新开始登录');
    }
    return manager.device(task.view.index);
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
    if (task.commands.size >= 200) throw new Error('本次向导操作过多，请重新开始');
    const operation = task.tail.then(async () => {
      this.check(task);
      if (task.view.phase !== 'awaitingLogin') throw new Error('请等待游戏启动完成');
      const device = await this.currentDevice(task);
      const screen = await driver.command(device, gamePlugin(task.view.gameId).packageName,
        command, task.controller.signal);
      this.check(task);
      task.view.screen = screen;
      this.updateSession(task, 'awaitingLogin', screen.message);
      return structuredClone(task.view);
    });
    task.commands.set(command.requestId, { fingerprint, result: operation });
    task.tail = operation.catch(() => undefined);
    return operation;
  }

  verifyLogin(sessionId: string, identityConfirmed: boolean): Promise<AccountLoginSession> {
    if (identityConfirmed !== true) return Promise.reject(new Error('请先确认游戏中的账号、服务器与角色正确'));
    const task = this.require(sessionId);
    const operation = task.tail.then(async () => {
      this.check(task);
      if (task.view.phase !== 'awaitingLogin') throw new Error('请先完成游戏登录');
      this.updateSession(task, 'verifying', '正在只读检查游戏主界面…');
      try {
        const device = await this.currentDevice(task);
        const game = gamePlugin(task.view.gameId);
        if (await device.foregroundPackage() !== game.packageName) throw new Error('游戏未处于前台');
        const probe = await this.automation.probe(task.view.gameId, task.view.index);
        this.check(task);
        const decision = gameLoginDriver(task.view.gameId)?.verifyHome(probe);
        if (!decision || !decision.ok) throw new Error(`尚未确认游戏主界面：${decision?.reason ?? '该游戏没有登录验证适配器'}`);
        task.committing = true;
        try {
          await this.store.completeLogin(task.view.accountId,
            { index: task.view.index, instanceCreatedAt: task.instanceCreatedAt! }, task.view.id);
        } finally { task.committing = false; }
        this.updateSession(task, 'completed', '游戏主界面已验证，账号已启用。');
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
    this.updateSession(task, 'cancelled', '登录已结束。账号与实例保留，可稍后继续。');
    await this.release(task);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.tasks.values()].map((task) => this.cancelLogin(task.view.id)));
  }
}
