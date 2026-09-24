import { useCallback, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GatherConfigView } from './GatherConfigView';
import { MaskedDrawer } from './MaskedDrawer';

export interface GatherConfigDrawerProps {
  gameId: string;
  /** Instance to configure; the drawer is mounted only while one is chosen. It never changes the global selection. */
  index: number;
  instanceName: string;
  /** Account bound to this AVD (identity-checked), or null. */
  boundAccount: string | null;
  autoOn: boolean;
  onClose(): void;
  /** After a successful save (refresh badges / queues). */
  onSaved?(index: number): void;
  /** A script run holds the instance (plans module): saving waits until it ends. */
  saveBlockedReason?: string | null;
}

/**
 * The config drawer (original GatherConfigDrawer): the full form opened in place from a card, the page header or the
 * instance table — no page switch, so it is always clear which instance it configures.
 * ★ The form is 「改完点保存」 and a drawer closes easily (mask, Esc, ×), so closing with unsaved edits asks first.
 */
export function GatherConfigDrawer({ gameId, index, instanceName, boundAccount, autoOn, onClose, onSaved, saveBlockedReason = null }: GatherConfigDrawerProps) {
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  /** Mask, Esc and × all come here. While the question is open, a second Esc belongs to the question. */
  const requestClose = (): void => {
    if (asking) return;
    if (!dirty) onClose();
    else setAsking(true);
  };

  return (
    <MaskedDrawer label={`实例 #${index} 采集配置`} width={780} onClose={requestClose}
      title={`采集配置 · #${index} ${instanceName}${boundAccount ? ` · ${boundAccount}` : ' · 未绑账号'}`}>
      <p className="gather-drawer-hint">改完要点右下角的「保存」，直接关掉不会保存。</p>
      <GatherConfigView gameId={gameId} index={index} boundAccount={boundAccount} autoOn={autoOn} onSaved={onSaved} onDirtyChange={onDirtyChange}
        saveBlockedReason={saveBlockedReason} />
      {asking && (
        <ConfirmDialog title="有未保存的修改" confirmLabel="放弃修改" danger
          message="直接关掉会丢弃这些改动（配置要点右下角「保存」才会落盘）。确定放弃吗？选「取消」回去保存。"
          onClose={() => setAsking(false)} onConfirm={() => { setDirty(false); onClose(); }} />
      )}
    </MaskedDrawer>
  );
}
