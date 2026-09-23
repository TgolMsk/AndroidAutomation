import { useState } from 'react';
import type { DeviceIdentityInput, InstanceRecord, InstanceState } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { shortImageLabel, specSummary } from '../../format';
import { Icon } from '../Icon';
import { IdentityFields } from '../IdentityFields';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';

export function CloneDialog({
  source,
  freeSlots,
  onClose,
  onCloned,
}: {
  source: InstanceState;
  freeSlots: number;
  onClose: () => void;
  onCloned: (records: InstanceRecord[]) => void;
}) {
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [keepSnapshots, setKeepSnapshots] = useState(false);
  const [identity, setIdentity] = useState<DeviceIdentityInput>(source.record.identity ? 'random' : 'system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stopped = source.status === 'stopped' || source.status === 'error';
  const maxCount = Math.max(1, Math.min(freeSlots, 32));
  const valid = Number.isInteger(count) && count >= 1 && count <= maxCount;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const records = await avdm.clone(source.record.index, { count, namePrefix: prefix.trim() || undefined, keepSnapshots, identity });
      onCloned(records);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="克隆实例"
      subtitle={`源：${source.record.name} #${source.record.index}`}
      onClose={onClose}
      busy={busy}
      width={500}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !stopped || !valid}>
            {busy ? <Spinner size={12} /> : <Icon name="copy" />}
            {busy ? '正在克隆…' : '开始克隆'}
          </button>
        </>
      }
    >
      {!stopped && (
        <div className="notice warn">
          <Icon name="alert" />
          <div>源实例正在运行，请先停止后再克隆。</div>
        </div>
      )}
      <div className="kv">
        <span>镜像</span>
        <span>{shortImageLabel(source.record.image)}</span>
        <span>规格</span>
        <span>{specSummary(source.record.spec)}</span>
      </div>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">数量</span>
          <input type="number" min={1} max={maxCount} value={Number.isFinite(count) ? count : ''} onChange={(e) => setCount(e.target.value === '' ? NaN : Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">名称前缀</span>
          <input type="text" placeholder="实例" value={prefix} maxLength={40} onChange={(e) => setPrefix(e.target.value)} />
        </label>
      </div>
      <IdentityFields value={identity} onChange={setIdentity} />
      <label className="check" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={keepSnapshots} onChange={(e) => setKeepSnapshots(e.target.checked)} />
        保留快速启动快照
      </label>
      <div className="hint block">
        克隆使用 APFS 写时复制，几乎不占额外空间，应用与数据会一并复制。不保留快照时，克隆体首次启动为冷启动。
      </div>
      {!valid && <div className="form-problems">数量需为 1–{maxCount}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
