import { beijingTime } from '../../format';
import type { GatherPauseInfo } from './pause-port';

/**
 * 「这个实例已被异常暂停」 block of the pause port (original features/alerts/PauseBanner, standalone and without its
 * own resume button — the 「恢复」 action stays on the card / table row so it appears once). Shown only when
 * `pause.paused` (never for a user switching auto off). Times are Beijing time.
 * ★ The alerts module replaces this with its full PauseBanner (scene shot, push result) during integration.
 */
export function PauseDetails({ pause, instanceName }: { pause: GatherPauseInfo; instanceName?: string | null }) {
  if (!pause.paused) return null;
  return (
    <section className="gather-pause" aria-label={`实例 #${pause.instanceIndex}${instanceName ? `（${instanceName}）` : ''} 已暂停`}>
      <div className="gather-pause-head">
        <strong>{pause.title || '已暂停'}</strong>
        <span className="gather-micro">自动调度已关闭，不会再排唤醒</span>
      </div>
      <details className="gather-pause-details" open>
        <summary>查看暂停原因</summary>
        <div className="gather-pause-reason">{pause.reason ?? '没有记录原因。'}</div>
      </details>
      {pause.advice && <div className="gather-pause-advice">处置：{pause.advice}</div>}
      <div className="gather-micro">
        {pause.at ? `暂停于 ${beijingTime(pause.at, 'full')}（北京时间）` : '暂停时刻未记录'}
        {pause.source === 'scheduler' && ' · 调度器连续失败后自动关闭了自动采集'}
      </div>
    </section>
  );
}
