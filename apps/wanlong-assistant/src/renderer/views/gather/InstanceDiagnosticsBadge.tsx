import { useMemo, useState } from 'react';
import type { InstanceQueueState } from '@avdm/automation/wanlong/pure';
import { Icon } from '../../components/Icon';
import { beijingTime } from '../../format';
import { attentionCount, collectDiagnostics, diagnosticsTip, worstLevel, type DiagnosticItem } from './diagnostics';
import { MaskedDrawer } from './MaskedDrawer';
import type { GatherPauseInfo } from './pause-port';
import { PauseDetails } from './PauseDetails';
import { CountPill } from './widgets';

const LEVEL_TEXT: Record<DiagnosticItem['level'], string> = { error: '故障', warning: '提醒', info: '说明' };

export interface InstanceDiagnosticsBadgeProps {
  index: number;
  name: string;
  state: InstanceQueueState;
  pause: GatherPauseInfo;
  /** The table has no MarchRow: collect row reasons too. The cards show them on the rows already. */
  rowReasons?: boolean;
  imminentMs?: number;
  staleAfterMs?: number;
}

/**
 * Diagnostics badge (original InstanceDiagnosticsBadge): folded it only says how many and how bad; clicking opens a
 * drawer with the pause details and every item. Nothing to report → nothing rendered. ★ Actions are not hidden in
 * here: 「恢复」 stays on the card / row, so the pause block is shown without its own resume button.
 */
export function InstanceDiagnosticsBadge({ index, name, state, pause, rowReasons = false, imminentMs = 60_000, staleAfterMs = 60_000 }: InstanceDiagnosticsBadgeProps) {
  const [open, setOpen] = useState(false);
  // Row reasons need a time but do not change by the second: one Date.now() per change, no ticker subscription.
  const items = useMemo(
    () => collectDiagnostics({ state, pause, rowReasons, now: Date.now(), imminentMs, staleAfterMs }),
    [state, pause, rowReasons, imminentMs, staleAfterMs],
  );
  const worst = worstLevel(items);
  if (worst === null) return null;
  const count = attentionCount(items);
  const tone = worst === 'error' ? 'danger' : 'warning';

  return (
    <>
      <button type="button" className={`gather-diag-btn is-${tone}`} title={diagnosticsTip(items, pause.paused)}
        aria-label={`实例 #${index} 诊断信息：${diagnosticsTip(items, pause.paused)}`} onClick={() => setOpen(true)}>
        <Icon name="alert" size={15} />
        <CountPill count={count > 0 ? count : undefined} dot={count === 0} tone={tone} />
      </button>
      {open && (
        <MaskedDrawer label={`实例 #${index} 诊断`} title={`诊断 · #${index} ${name}`} width={560} onClose={() => setOpen(false)}>
          <div className="gather-diag-sections">
            <PauseDetails pause={pause} instanceName={name} />
            {items.map((item, i) => (
              <div key={`${item.title}-${i}`} className="gather-diag-text">
                <span className={`gather-diag-level is-${item.level}`}>{LEVEL_TEXT[item.level]} · {item.title}</span>
                <div>{item.text}</div>
              </div>
            ))}
            <div className="gather-micro">
              上次采样{state.lastSampledAt > 0 ? ` ${beijingTime(state.lastSampledAt, 'minute')}（北京时间）` : '：还没采过'}
              {state.backoffStep > 0 && ` · 正在退避重试（第 ${state.backoffStep} 次）`}
            </div>
          </div>
        </MaskedDrawer>
      )}
    </>
  );
}
