import { useMemo, useState } from 'react';
import type { DeviceIdentityInput, InstanceRecord, InstanceSpec, InstanceState, UpdateOptions } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { imageLabel } from '../../format';
import { Icon } from '../Icon';
import { IdentityFields } from '../IdentityFields';
import { Modal } from '../Modal';
import { SpecFields, specProblems } from '../SpecFields';
import { Spinner } from '../StatusBadge';

function specDiff(before: InstanceSpec, after: InstanceSpec): Partial<InstanceSpec> | undefined {
  const diff: Partial<InstanceSpec> = {};
  let changed = false;
  for (const key of Object.keys(after) as Array<keyof InstanceSpec>) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      (diff as Record<string, unknown>)[key] = after[key];
      changed = true;
    }
  }
  return changed ? diff : undefined;
}

export function EditDialog({ state, onClose, onSaved }: { state: InstanceState; onClose: () => void; onSaved: (record: InstanceRecord) => void }) {
  const { record } = state;
  const [name, setName] = useState(record.name);
  const [notes, setNotes] = useState(record.notes ?? '');
  const [autoRestart, setAutoRestart] = useState(record.autoRestart);
  const [spec, setSpec] = useState<InstanceSpec>(() => ({ ...record.spec, extraArgs: [...record.spec.extraArgs] }));
  const [identity, setIdentity] = useState<DeviceIdentityInput>(record.identity ?? 'system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stopped = state.status === 'stopped' || state.status === 'error';
  const diff = useMemo(() => specDiff(record.spec, spec), [record.spec, spec]);
  const problems = useMemo(() => {
    const p = stopped ? specProblems(spec) : [];
    if (!name.trim()) p.unshift('名称不能为空');
    return p;
  }, [spec, name, stopped]);

  const submit = async () => {
    const opts: UpdateOptions = {};
    if (name.trim() !== record.name) opts.name = name.trim();
    if (notes !== (record.notes ?? '')) opts.notes = notes;
    if (autoRestart !== record.autoRestart) opts.autoRestart = autoRestart;
    if (stopped && diff) opts.spec = diff;
    if (stopped && JSON.stringify(identity) !== JSON.stringify(record.identity ?? 'system')) opts.identity = identity;
    if (Object.keys(opts).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const updated = await avdm.update(record.index, opts);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="编辑配置"
      subtitle={`${record.name} #${record.index} · ${imageLabel(record.image)}`}
      onClose={onClose}
      busy={busy}
      width={620}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || problems.length > 0}>
            {busy ? <Spinner size={12} /> : <Icon name="check" />}
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field-label">名称</span>
          <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field check-field">
          <span className="field-label">&nbsp;</span>
          <label className="check">
            <input type="checkbox" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} />
            崩溃后自动重启
          </label>
        </div>
        <label className="field span-2">
          <span className="field-label">备注</span>
          <textarea rows={2} value={notes} maxLength={500} placeholder="例如：这个实例登录的账号" onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="section-title">硬件与启动</div>
      {!stopped && (
        <div className="notice info">
          <Icon name="info" />
          <div>实例运行中，硬件配置不可修改。请先停止实例。</div>
        </div>
      )}
      <SpecFields value={spec} onChange={setSpec} disabled={!stopped} showExtraArgs />
      <IdentityFields value={identity} onChange={setIdentity} disabled={!stopped} />
      {stopped && diff && (diff.dataPartitionGb ?? record.spec.dataPartitionGb) < record.spec.dataPartitionGb && (
        <div className="form-warning">数据盘通常只能扩大，缩小可能不会生效。</div>
      )}
      {problems.length > 0 && <div className="form-problems">{problems.join('；')}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
