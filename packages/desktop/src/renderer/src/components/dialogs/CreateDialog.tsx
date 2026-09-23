import { useMemo, useState } from 'react';
import type { DeviceIdentityInput, InstanceRecord, InstanceSpec, SdkInfo, Settings } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { formatMb, imageLabel } from '../../format';
import { Icon } from '../Icon';
import { IdentityFields } from '../IdentityFields';
import { Modal } from '../Modal';
import { SpecFields, specProblems } from '../SpecFields';
import { Spinner } from '../StatusBadge';

export function CreateDialog({
  settings,
  sdk,
  freeSlots,
  onClose,
  onCreated,
  onInstallImages,
}: {
  settings: Settings;
  sdk: SdkInfo;
  freeSlots: number;
  onClose: () => void;
  onCreated: (records: InstanceRecord[], startNow: boolean) => void;
  onInstallImages: () => void;
}) {
  const images = sdk.images;
  const initialImage = images.some((i) => i.packagePath === settings.defaultImage) ? settings.defaultImage : (images[0]?.packagePath ?? '');
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState('');
  const [image, setImage] = useState(initialImage);
  const [spec, setSpec] = useState<InstanceSpec>(() => ({ ...settings.defaultSpec, extraArgs: [...settings.defaultSpec.extraArgs] }));
  const [autoRestart, setAutoRestart] = useState(false);
  const [identity, setIdentity] = useState<DeviceIdentityInput>('random');
  const [startNow, setStartNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const maxCount = Math.max(1, Math.min(freeSlots, 32));
  const problems = useMemo(() => {
    const p = specProblems(spec);
    if (!Number.isInteger(count) || count < 1 || count > maxCount) p.unshift(`数量需为 1–${maxCount}`);
    if (!image) p.unshift('请选择系统镜像');
    return p;
  }, [spec, count, image, maxCount]);

  const submit = async () => {
    if (problems.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const records = await avdm.create({
        count,
        namePrefix: prefix.trim() || undefined,
        image,
        spec,
        autoRestart,
        identity,
      });
      onCreated(records, startNow);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建实例"
      subtitle="从已安装的系统镜像创建全新的模拟器实例"
      onClose={onClose}
      busy={busy}
      width={620}
      footer={
        <>
          <label className="check footer-left">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} disabled={busy} />
            创建后立即启动
          </label>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || problems.length > 0}>
            {busy ? <Spinner size={12} /> : <Icon name="plus" />}
            {busy ? '正在创建…' : `创建 ${Number.isFinite(count) ? count : ''} 个实例`}
          </button>
        </>
      }
    >
      {images.length === 0 ? (
        <div className="notice warn">
          <Icon name="alert" />
          <div>
            尚未安装任何系统镜像，无法创建实例。
            <button className="link-btn" onClick={onInstallImages}>
              安装系统镜像…
            </button>
          </div>
        </div>
      ) : null}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">数量</span>
          <input type="number" min={1} max={maxCount} value={Number.isFinite(count) ? count : ''} onChange={(e) => setCount(e.target.value === '' ? NaN : Number(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">名称前缀</span>
          <input type="text" placeholder="实例" value={prefix} maxLength={40} onChange={(e) => setPrefix(e.target.value)} />
        </label>
        <label className="field span-2">
          <span className="field-label">系统镜像</span>
          <select value={image} onChange={(e) => setImage(e.target.value)} disabled={images.length === 0}>
            {images.map((img) => (
              <option key={img.packagePath} value={img.packagePath}>
                {imageLabel(img.packagePath, img)}
                {img.revision ? `（r${img.revision}）` : ''}
                {img.packagePath === settings.defaultImage ? ' · 默认' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="section-title">硬件与启动</div>
      <SpecFields value={spec} onChange={setSpec} />
      <IdentityFields value={identity} onChange={setIdentity} />
      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={autoRestart} onChange={(e) => setAutoRestart(e.target.checked)} />
        崩溃后自动重启
        <span className="hint">（10 分钟内最多 3 次）</span>
      </label>
      <div className="form-summary">
        名称将为「{prefix.trim() || '实例'}-编号」。运行时每个实例约占用 {formatMb(spec.ramMb)} 内存
        {Number.isFinite(count) && count > 1 ? `，${count} 个合计约 ${formatMb(spec.ramMb * count)}` : ''}。
      </div>
      {problems.length > 0 && !busy && <div className="form-problems">{problems.join('；')}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
