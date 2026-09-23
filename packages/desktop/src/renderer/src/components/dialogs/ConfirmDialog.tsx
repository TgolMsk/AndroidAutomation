import { useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确定',
  danger = false,
  option,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Optional checkbox (e.g. "强制删除"); its value is passed to onConfirm. */
  option?: { label: string; hint?: string; defaultChecked?: boolean };
  onConfirm: (optionChecked: boolean) => Promise<void> | void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState(option?.defaultChecked ?? false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm(checked);
      onClose();
    } catch {
      // The caller reports failures (toast); keep the dialog open for a retry.
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      width={460}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => void go()} disabled={busy} autoFocus>
            {busy && <Spinner size={12} />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
      {option && (
        <label className="check" style={{ marginTop: 14 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} disabled={busy} />
          {option.label}
          {option.hint && <span className="hint">{option.hint}</span>}
        </label>
      )}
    </Modal>
  );
}
