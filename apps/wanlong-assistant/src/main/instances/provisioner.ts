import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { isAvdmError, withFileLock, type InstanceRecord, type InstanceState } from '@avdm/core';
import type { AutomationSettings } from '../../shared/ipc/automation';
import type { ManagerHost } from '../manager-host';
import { BaseInstanceStore } from './base-store';
import type {
  BaseInstanceSelection, BaseInstanceView, CloneFromBaseRequest, CloneFromBaseResult, InstanceBaseChangedEvent,
} from './types';

export type {
  BaseInstanceSelection, BaseInstanceView, CloneFromBaseRequest, CloneFromBaseResult, InstanceBaseChangedEvent,
} from './types';

/** Rough disk cost of one AVD copy (system + userdata + game data), checked before a batch clone. */
export const CLONE_BYTES_ESTIMATE = 4 * 1024 ** 3;
const MAX_CLONES = 8;

export interface ProvisionerPorts {
  settings(gameId: string, index: number): Promise<AutomationSettings>;
  saveSettings(gameId: string, index: number, patch: Partial<AutomationSettings>): Promise<AutomationSettings>;
  /** Switch off this game's gather schedule on the index (the base never runs automation). */
  disableSchedule(gameId: string, index: number): Promise<void>;
  /** Chinese description of in-process work on the index (登录 / 采集 / 脚本计划), or null when idle. */
  busyReason(index: number): Promise<string | null> | string | null;
  /** Name of the account of this game bound to the AVD, or null. */
  boundAccountName(gameId: string, index: number, createdAt: string): Promise<string | null>;
  /** Free bytes on the volume holding `dir`; defaults to statfs. */
  freeBytes?(dir: string): Promise<number>;
  onChanged?(event: InstanceBaseChangedEvent): void;
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

function gib(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/**
 * Base instance and batch cloning (original `instanceProvisioner.ts`), on AVDs: the selection is per game and
 * bound to the AVD's creation identity; cloning goes through `AvdManager.clone` (atomic, rolls back on failure)
 * while the assistant holds the source's device lease. setBase and clone are mutually exclusive.
 */
export class InstanceProvisioner {
  readonly store: BaseInstanceStore;
  private busy = false;

  constructor(
    private readonly host: Pick<ManagerHost, 'get'>,
    private readonly home: string,
    private readonly ports: ProvisionerPorts,
  ) {
    this.store = new BaseInstanceStore(home);
  }

  private emit(view: BaseInstanceView): void {
    try { this.ports.onChanged?.({ gameId: view.gameId, view: structuredClone(view) }); }
    catch { /* Observers cannot break provisioning. */ }
  }

  /** Claimed synchronously, before the first await, so two requests can never interleave. */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('正在设置基础实例或克隆实例，请等待完成后再试。');
    this.busy = true;
    try { return await action(); }
    finally { this.busy = false; }
  }

  private async stateOf(index: number): Promise<InstanceState | null> {
    try { return await (await this.host.get()).getState(index); }
    catch (error) {
      if (isAvdmError(error, 'INSTANCE_NOT_FOUND')) return null;
      throw error;
    }
  }

  /** Clear a stored base whose AVD disappeared or was replaced (only if nobody changed the selection meanwhile). */
  private async autoClear(gameId: string, base: BaseInstanceSelection, reason: string): Promise<BaseInstanceView> {
    await this.store.write(gameId, null, base);
    const view: BaseInstanceView = {
      gameId, base: null, status: null, cloneBlocked: null, cleared: { index: base.index, name: base.name, reason },
    };
    this.emit(view);
    return view;
  }

  private async describe(gameId: string, base: BaseInstanceSelection, state: InstanceState): Promise<BaseInstanceView> {
    let cloneBlocked: string | null = null;
    if (state.record.provisioning) cloneBlocked = '基础实例仍在创建或克隆中';
    else if (state.status !== 'stopped') cloneBlocked = '基础实例仍在运行，克隆前请先关闭';
    else {
      const busy = await this.ports.busyReason(base.index);
      if (busy) cloneBlocked = `基础实例${busy}`;
    }
    return { gameId, base: { ...base, name: state.record.name }, status: state.status, cloneBlocked };
  }

  /**
   * The base of a game, validated against the live instance. A base whose AVD was deleted, or whose index now
   * holds a different AVD, is cleared automatically and reported once through `cleared`.
   */
  async view(gameId: string): Promise<BaseInstanceView> {
    const base = await this.store.read(gameId);
    if (!base) return { gameId, base: null, status: null, cloneBlocked: null };
    const state = await this.stateOf(base.index);
    if (!state) return this.autoClear(gameId, base, '基础实例已被删除');
    if (state.record.createdAt !== base.createdAt) return this.autoClear(gameId, base, '该编号已被新的实例使用，原基础实例已不存在');
    return this.describe(gameId, base, state);
  }

  /** Index + identity of a valid base (for the login / bind / automation guards), or null. */
  async baseIdentity(gameId: string): Promise<{ index: number; createdAt: string } | null> {
    const view = await this.view(gameId);
    return view.base ? { index: view.base.index, createdAt: view.base.createdAt } : null;
  }

  /** Template set of the base instance, the fallback of a copy that has none of its own. */
  async baseTemplateDir(gameId: string): Promise<string> {
    const base = await this.baseIdentity(gameId);
    return base ? (await this.ports.settings(gameId, base.index)).templateDir : '';
  }

  setBase(gameId: string, index: number | null): Promise<BaseInstanceView> {
    return this.exclusive(async () => {
      // A corrupt file must not be silently replaced by one click.
      await this.store.read(gameId);
      if (index === null) {
        await this.store.write(gameId, null);
        const view: BaseInstanceView = { gameId, base: null, status: null, cloneBlocked: null };
        this.emit(view);
        return view;
      }
      if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error('实例编号无效。');
      const state = await this.stateOf(index);
      if (!state) throw new Error(`实例 #${index} 不存在，请刷新列表。`);
      if (state.record.provisioning) throw new Error(`实例 #${index} 仍在创建或克隆中，请完成后再设为基础实例。`);
      const busy = await this.ports.busyReason(index);
      if (busy) throw new Error(`实例 #${index} ${busy}，请结束后再设为基础实例。`);
      const owner = await this.ports.boundAccountName(gameId, index, state.record.createdAt);
      if (owner) throw new Error(`实例 #${index} 已绑定账号「${owner}」。基础实例只用于克隆，请先解除绑定再设为基础实例。`);
      await this.ports.disableSchedule(gameId, index);
      const base: BaseInstanceSelection = { index, name: state.record.name, createdAt: state.record.createdAt, setAt: Date.now() };
      await this.store.write(gameId, base);
      const view = await this.describe(gameId, base, state);
      this.emit(view);
      return view;
    });
  }

  /**
   * Clone 1–8 copies from the stopped base (every copy from the same source, never from a fresh copy), then let
   * each copy inherit the base's template set and gather settings. Nothing is started; the login wizard follows.
   */
  cloneFromBase(gameId: string, request: CloneFromBaseRequest): Promise<CloneFromBaseResult> {
    return this.exclusive(async () => {
      const count = request?.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_CLONES) throw new Error('克隆数量必须是 1–8 的整数。');
      const base = await this.store.read(gameId);
      if (!base) throw new Error('尚未设置基础实例，请先把准备好的实例设为基础实例。');
      if (request.expectedBaseIndex !== base.index) throw new Error('基础实例已改变，请重新打开克隆窗口确认。');
      const state = await this.stateOf(base.index);
      if (!state) {
        await this.autoClear(gameId, base, '基础实例已被删除');
        throw new Error(`源实例 #${base.index} 已不存在，请重新设置基础实例。`);
      }
      if (state.record.createdAt !== base.createdAt) {
        await this.autoClear(gameId, base, '该编号已被新的实例使用，原基础实例已不存在');
        throw new Error(`实例 #${base.index} 已被替换，请重新设置基础实例后再克隆。`);
      }
      if (state.record.provisioning) throw new Error(`源实例 #${base.index} 仍在创建或克隆中，请稍后再试。`);
      if (state.status !== 'stopped') {
        throw new Error(`请先关闭源实例 #${base.index}「${state.record.name}」再克隆，确保磁盘数据完整。`);
      }
      const busy = await this.ports.busyReason(base.index);
      if (busy) throw new Error(`源实例 #${base.index} ${busy}，请结束后再克隆。`);
      await this.checkDisk(count);
      const records = await this.withSourceLease(base.index, () => this.clone(base.index, count, state.record.name, request.rotateIdentity !== false));
      const warnings = await this.inherit(gameId, base.index, records);
      this.emit(await this.describe(gameId, base, state));
      return { baseIndex: base.index, created: records.map((item) => ({ index: item.index, name: item.name })), warnings };
    });
  }

  private async checkDisk(count: number): Promise<void> {
    let free: number;
    try { free = await (this.ports.freeBytes ?? defaultFreeBytes)(this.home); }
    catch { return; /* An unknown free size never blocks; core still fails cleanly and rolls back. */ }
    const needed = count * CLONE_BYTES_ESTIMATE;
    if (free < needed) {
      throw new Error(`磁盘剩余约 ${gib(free)} GB，克隆 ${count} 个实例预计需要 ${gib(needed)} GB（每个约 4 GB）。请先清理磁盘或减少数量。`);
    }
  }

  /** Login, gather and plans take the same lease, so none can start the source while it is copied. */
  private async withSourceLease<T>(index: number, action: () => Promise<T>): Promise<T> {
    try {
      return await withFileLock(path.join(this.home, 'run', `automation-instance-${index}.lock`), action, { timeoutMs: 150 });
    } catch (error) {
      // clone() maps core's own LOCK_TIMEOUT to a plain error, so this one is the lease.
      if (isAvdmError(error, 'LOCK_TIMEOUT')) {
        throw new Error(`源实例 #${index} 正被登录、采集或脚本计划占用，请先结束后再克隆。`);
      }
      throw error;
    }
  }

  private async clone(index: number, count: number, name: string, rotate: boolean): Promise<InstanceRecord[]> {
    const manager = await this.host.get();
    try {
      return await manager.clone(index, {
        count, namePrefix: name.trim().slice(0, 40) || undefined, ...(rotate ? { identity: 'random' as const } : {}),
      });
    } catch (error) {
      if (isAvdmError(error, 'INSTANCE_RUNNING')) {
        throw new Error(`请先关闭源实例 #${index}「${name}」再克隆，确保磁盘数据完整。`);
      }
      if (isAvdmError(error, 'NO_FREE_INDEX')) throw new Error('没有可用的实例编号，请先删除不再使用的实例。');
      if (isAvdmError(error, 'LOCK_TIMEOUT')) throw new Error(`源实例 #${index} 正被启动、克隆或删除操作占用，请稍后再试。`);
      throw new Error(`克隆失败，已自动回滚，没有留下半成品实例：${(error as Error).message}`);
    }
  }

  private async inherit(gameId: string, baseIndex: number, records: InstanceRecord[]): Promise<string[]> {
    let settings: AutomationSettings;
    try { settings = await this.ports.settings(gameId, baseIndex); }
    catch (error) { return [`副本未能继承基础实例的模板集设置：${(error as Error).message}`]; }
    if (!settings.templateDir && Object.keys(settings.config).length === 0) return [];
    const warnings: string[] = [];
    for (const record of records) {
      try { await this.ports.saveSettings(gameId, record.index, { templateDir: settings.templateDir, config: settings.config }); }
      catch (error) { warnings.push(`实例 #${record.index} 未能继承基础实例的模板集设置：${(error as Error).message}`); }
    }
    return warnings;
  }
}
