import { useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { BaseInstanceView } from '../../../main/instances/types';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner, StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { displayStatus } from '../../format';
import './AccountsView.css';

/**
 * 基础实例 (original InstancesView base banner + 新建 dialog): pick the prepared instance new copies are cloned
 * from, cancel it, and clone 1–8 copies that go straight into the login wizard.
 */
export function BaseInstanceCard({ gameId, base, baseError, instances, onCloned, onChanged }: {
  gameId: string;
  base: BaseInstanceView | null;
  baseError?: string;
  instances: InstanceState[];
  /** New copies (in order); `login` = the user ticked 「创建后设置账号并登录游戏」. */
  onCloned(indices: number[], login: boolean): void;
  onChanged?(): void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<number | ''>('');
  const [cloning, setCloning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const selection = base?.base ?? null;
  const baseInstance = selection ? instances.find((item) => item.record.index === selection.index) : undefined;
  const candidates = instances.filter((item) => !item.record.provisioning && item.status !== 'error');

  async function setBase(index: number | null): Promise<void> {
    setBusy(true);
    try {
      const next = await avdm.instanceSetBase(gameId, index);
      toast.push({ kind: 'success', title: next.base ? `已将 #${next.base.index}「${next.base.name}」设为基础实例` : '已取消基础实例' });
      setPick('');
      onChanged?.();
    } catch (error) {
      toast.error(index === null ? '取消基础实例失败' : '设为基础实例失败', errMsg(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="accounts-base" aria-labelledby="accounts-base-title">
      <div className="accounts-base-head">
        <div>
          <h3 id="accounts-base-title">基础实例</h3>
          <p>装好游戏的实例设为基础实例后，可一次克隆 1–8 个副本，并直接进入账号登录向导。基础实例本身不绑定账号、不运行自动任务。</p>
        </div>
      </div>
      {baseError && <div className="notice bad" role="alert"><Icon name="alert" />{baseError}</div>}
      {selection ? (
        <div className="accounts-base-row">
          <div className="accounts-base-name">
            <strong>#{selection.index} · {selection.name}</strong>
            {baseInstance && <StatusBadge status={displayStatus(baseInstance)} />}
            <span className="accounts-dim">克隆时使用</span>
          </div>
          <div className="accounts-base-actions">
            <button type="button" className="btn sm primary" disabled={busy || Boolean(base?.cloneBlocked)} onClick={() => setCloning(true)}
              title={base?.cloneBlocked ?? undefined}><Icon name="copy" size={14} /> 克隆副本…</button>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setCancelling(true)}>取消基础实例</button>
          </div>
          {base?.cloneBlocked && <p className="accounts-inline-warn">{base.cloneBlocked}。</p>}
        </div>
      ) : (
        <div className="accounts-base-row">
          <select value={pick} onChange={(event) => setPick(event.target.value === '' ? '' : Number(event.target.value))} aria-label="选择基础实例" disabled={busy}>
            <option value="">选择一个已装好游戏的实例…</option>
            {candidates.map((item) => <option key={item.record.index} value={item.record.index}>#{item.record.index} · {item.record.name}</option>)}
          </select>
          <button type="button" className="btn sm" disabled={busy || pick === ''} onClick={() => void setBase(pick as number)}>
            {busy && <Spinner size={12} />}设为基础实例
          </button>
          <span className="accounts-dim">还没有基础实例。已绑定账号的实例不能设为基础实例。</span>
        </div>
      )}
      {cloning && selection && (
        <CloneFromBaseDialog gameId={gameId} expectedBaseIndex={selection.index} baseName={selection.name}
          onClose={() => setCloning(false)}
          onCloned={(indices, login) => { setCloning(false); onChanged?.(); onCloned(indices, login); }} />
      )}
      {cancelling && selection && (
        <ConfirmDialog title="取消基础实例" confirmLabel="取消基础实例"
          message={`取消后 #${selection.index}「${selection.name}」恢复为普通实例，不会删除任何数据。之后克隆前需要重新设置基础实例。`}
          onClose={() => setCancelling(false)} onConfirm={() => setBase(null)} />
      )}
    </section>
  );
}

/** 从基础实例克隆: count 1–8, identity rotation, 「创建后设置账号并登录游戏」 (on by default). */
export function CloneFromBaseDialog({ gameId, expectedBaseIndex, baseName, onClose, onCloned }: {
  gameId: string;
  /** Captured when the dialog opened: a base changed meanwhile is refused by the main process. */
  expectedBaseIndex: number;
  baseName: string;
  onClose(): void;
  onCloned(indices: number[], login: boolean): void;
}) {
  const toast = useToast();
  const [count, setCount] = useState(1);
  const [rotate, setRotate] = useState(true);
  const [loginAfter, setLoginAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Number.isInteger(count) && count >= 1 && count <= 8;

  async function submit(): Promise<void> {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await avdm.instanceCloneFromBase(gameId, { count, expectedBaseIndex, rotateIdentity: rotate });
      toast.push({ kind: 'success', title: `已克隆 ${result.created.length} 个实例`,
        detail: result.created.map((item) => `#${item.index}`).join('、') });
      for (const warning of result.warnings) toast.push({ kind: 'warn', title: '副本设置未完整继承', detail: warning });
      onCloned(result.created.map((item) => item.index), loginAfter);
    } catch (cause) {
      setError(errMsg(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="从基础实例克隆" subtitle={`源实例 #${expectedBaseIndex} · ${baseName}`} onClose={onClose} busy={busy} width={520}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !valid}>
          {busy && <Spinner size={12} />}{busy ? '正在克隆…' : `克隆 ${valid ? count : ''} 个`}
        </button>
      </>}>
      <div className="accounts-clone-form">
        <label className="field">
          <span className="field-label">数量（1–8）</span>
          <input type="number" min={1} max={8} step={1} value={Number.isNaN(count) ? '' : count}
            onChange={(event) => setCount(event.target.valueAsNumber)} />
        </label>
        <label className="check"><input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} />
          每个副本使用新的设备标识（推荐）</label>
        <p className="hint">新标识会更换序列号、MAC 与 Android ID，游戏会把副本当成新设备，通常需要重新登录；关闭后沿用模拟器默认标识，可能继承源实例的登录状态。</p>
        <label className="check"><input type="checkbox" checked={loginAfter} onChange={(event) => setLoginAfter(event.target.checked)} />
          创建后设置账号并登录游戏</label>
        <div className="notice info"><Icon name="info" />
          <span>每个副本约占用 4 GB 磁盘，克隆前会检查剩余空间。克隆沿用基础实例的应用、游戏数据和模板集；源实例必须保持关闭，克隆期间不能启动。失败会自动回滚，不留下半成品实例。</span></div>
        {error && <div className="notice bad" role="alert"><Icon name="alert" />{error}</div>}
      </div>
    </Modal>
  );
}
