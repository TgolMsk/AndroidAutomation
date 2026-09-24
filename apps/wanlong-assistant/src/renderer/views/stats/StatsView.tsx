/**
 * 数据统计 (original features/stats/StatsView.tsx): one Beijing day's dispatches / estimated amount / completed trips /
 * failures and circuit breaks / alerts / paused time, split by resource and by instance, the day's resource-table
 * snapshots and the last 14 days.
 *
 *  · Days are Beijing date keys (`shiftDateKey` on the key, never host dates). The page follows Beijing midnight
 *    through the main process's `stats-today` push.
 *  · 预计采集量 = Σ card storage read at dispatch (exact to the unit): the daily amount. Snapshots of the in-game
 *    resource table are only accurate to 0.1亿 and are shown for reconciliation, never as a difference.
 *  · The only device action is 「读一次资源统计」 (the instance lock; refused while a script runs or the game is not on
 *    the main screen). Everything else reads local day files: zero adb.
 */
import { useEffect, useMemo, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import { RESOURCE_NAME, RESOURCE_TYPES, formatCnAmount } from '@avdm/automation/wanlong/pure';
import { emptyDailyStats, formatPausedDuration, livePausedMs, type DailyStats, type InstanceDailyStats } from '../../../shared/stats';
import { cstDateKey, shiftDateKey, type DateKey } from '../../../shared/time';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { MetricStrip } from '../../components/MetricStrip';
import { ResourceBadge } from '../../components/ResourceBadge';
import { SemanticTag } from '../../components/SemanticTag';
import { StatTile } from '../../components/StatTile';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { formatCst, formatCstClock, isRunning } from '../../format';
import { useSelection, useSelectionLock } from '../../state/selection';
import { InsightsPanel } from '../automation/InsightsPanel';
import { useAccounts } from '../accounts/useAccounts';
import type { ViewProps } from '../types';
import { ResourceSnapshotTable } from './ResourceSnapshotTable';
import {
  LIVE_TICK_MS, RECENT_DAYS, exactAmount, hasAnyData, instanceEstimated, instanceRows, pausedNowCount, resourceRows,
  totalCompleted, totalEstimated, totalPausedMs, totalUnknownStorage,
} from './stats-model';
import { useStats } from './useStats';
import './StatsView.css';

/** The running pause is a duration, not a countdown: a slow tick while the page is shown is enough. */
function useSlowTick(visible: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), LIVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [visible]);
  return now;
}

/** Zero is dimmed so rows with data stand out. */
function Num({ v, tone }: { v: number; tone?: 'danger' | 'warning' }) {
  return <span className={`stats-num ${v === 0 ? 'stats-dim' : tone ? `stats-${tone}` : ''}`}>{v}</span>;
}

function Amount({ n }: { n: number }) {
  return <span className={`stats-mono ${n === 0 ? 'stats-dim' : ''}`} title={n > 0 ? exactAmount(n) : undefined}>{n === 0 ? '—' : formatCnAmount(n)}</span>;
}

/** The snapshot target: keep the current choice, else the global instance when running, else the first running one. */
export function pickSnapshotIndex(current: number | null, instances: readonly InstanceState[], preferred: number | null): number | null {
  if (current !== null && instances.some((item) => item.record.index === current)) return current;
  const running = instances.filter((item) => isRunning(item));
  const choice = running.find((item) => item.record.index === preferred) ?? running[0] ?? instances[0];
  return choice ? choice.record.index : null;
}

export function StatsView({ visible }: ViewProps) {
  const { gameId, instances, index: selectedIndex } = useSelection();
  const toast = useToast();
  const { accounts } = useAccounts(gameId);
  const store = useStats(gameId, visible);
  const now = useSlowTick(visible);
  const [snapIndex, setSnapIndex] = useState<number | null>(null);

  const todayKey: DateKey = store.today?.dateKey ?? cstDateKey(now);
  const selectedKey = store.selectedKey;
  const isToday = selectedKey === todayKey;
  // Before the bucket arrives an empty one keeps the layout from jumping.
  const selected: DailyStats = store.selected ?? emptyDailyStats(selectedKey, 0, gameId);
  const liveNow = isToday ? now : 0;

  useEffect(() => { setSnapIndex((current) => pickSnapshotIndex(current, instances, selectedIndex)); }, [instances, selectedIndex]);
  useSelectionLock(store.readingHere ? '正在读资源统计' : null);

  /** The account bound to this AVD (same index and, when known, the same instance identity). */
  const accountNameOf = useMemo(() => (index: number, createdAt?: string | null): string | null => {
    const account = accounts.find((item) => item.binding?.index === index &&
      (!createdAt || item.binding.instanceCreatedAt === createdAt));
    return account?.name ?? null;
  }, [accounts]);
  const currentIdentity = useMemo(() => new Map(instances.map((item) => [item.record.index, item.record.createdAt])), [instances]);
  const who = (index: number): string => {
    const name = accountNameOf(index, currentIdentity.get(index));
    return name ? `实例 ${index}「${name}」` : `实例 ${index}`;
  };

  const estimated = totalEstimated(selected);
  const completed = totalCompleted(selected);
  const unknown = totalUnknownStorage(selected);
  const paused = totalPausedMs(selected, liveNow);
  const pausedNow = isToday ? pausedNowCount(selected) : 0;
  const resources = useMemo(() => resourceRows(selected), [selected]);
  const rows = useMemo(() => instanceRows(selected), [selected]);
  const recentDesc = useMemo(() => store.recent.slice().reverse(), [store.recent]);
  const snapBusy = snapIndex !== null && store.reading.has(snapIndex);
  const snapInstance = instances.find((item) => item.record.index === snapIndex);
  const snapDisabledReason = snapIndex === null ? '没有可选的实例'
    : !snapInstance || !isRunning(snapInstance) ? '这个实例没有开机' : null;

  async function handleSnapshot(): Promise<void> {
    if (snapIndex === null) {
      toast.push({ kind: 'warn', title: '请先选一个实例。' });
      return;
    }
    const target = snapIndex;
    const failure = await store.snapshotNow(target);
    if (!failure) toast.push({ kind: 'success', title: `实例 #${target} 已读到一张资源统计快照`, detail: '已记入今天的日桶。' });
    else if (failure.retry) toast.push({ kind: 'warn', title: `实例 #${target} 正忙，稍后再读`, detail: failure.message });
    else toast.push({ kind: 'error', title: `实例 #${target} 读资源统计失败`, detail: failure.message });
  }

  const instanceName = (item: InstanceState): string => accountNameOf(item.record.index, item.record.createdAt) ?? item.record.name;

  return (
    <div className="stats-page">
      <header className="stats-head">
        <p className="stats-note">按北京时间每天 0 点分桶。预计采集量来自派兵时读到的卡片储量（按「自动采集至清空」估算）。</p>
        <div className="stats-head-actions">
          <div className="stats-datenav" role="group" aria-label="切换日期">
            <button type="button" className="icon-btn small" aria-label="前一天" title="前一天" onClick={() => void store.selectDay(shiftDateKey(selectedKey, -1))}>
              <Icon name="back" />
            </button>
            <span className={`stats-datenav-key ${isToday ? 'is-today' : ''}`} aria-live="polite">{selectedKey}</span>
            <button type="button" className="icon-btn small stats-flip" aria-label="后一天" title={isToday ? '已经是今天' : '后一天'}
              disabled={isToday} onClick={() => void store.selectDay(shiftDateKey(selectedKey, 1))}>
              <Icon name="back" />
            </button>
            <button type="button" className="btn xs" disabled={isToday} onClick={() => void store.selectDay(todayKey)}>今天</button>
          </div>
          <button type="button" className="btn sm" disabled={store.loading} onClick={() => void store.load()}>
            {store.loading ? <Spinner size={14} /> : <Icon name="refresh" />}重新拉取
          </button>
        </div>
      </header>

      {store.loaded && store.error && (
        <div className="notice warn" role="alert"><Icon name="alert" /><div><strong>统计数据没能拉到</strong><p>{store.error}</p></div></div>
      )}

      <Card
        title={`${isToday ? '今日' : '当日'}（北京）· ${selectedKey}`}
        icon="gauge"
        extra={<span className="stats-micro">{selected.updatedAt > 0 ? `最后写入 ${formatCst(selected.updatedAt)}` : '这一天还没有任何记录'}</span>}
        footer={hasAnyData(selected) ? undefined : (
          isToday
            ? '今天还没有派兵记录。自动调度派出第一支队伍后，这里会实时更新。'
            : '这一天没有任何统计记录（可能当时助手没在运行，或早于统计功能上线）。'
        )}
      >
        <MetricStrip label="当日汇总">
          <StatTile label="派兵次数" value={selected.dispatches} unit="次" tone={selected.dispatches > 0 ? 'accent' : 'neutral'} hint="本引擎派出、复验队列 +1 的那些" />
          <StatTile
            label="预计采集量" value={estimated > 0 ? formatCnAmount(estimated) : '—'} tone={estimated > 0 ? 'accent' : 'neutral'}
            hint={unknown > 0 ? `有 ${unknown} 趟储量没读出来，实际会比这个多` : 'Σ 派兵时卡片储量，精确到个位'}
          />
          <StatTile label="完成趟数" value={completed} unit="趟" hint="派出去的队伍从部队管理面板上消失（回城）" />
          <StatTile
            label="失败 / 熔断" value={`${selected.failures} / ${selected.circuitBreaks}`}
            tone={selected.failures + selected.circuitBreaks > 0 ? 'danger' : 'neutral'} hint="以失败收场的采集轮数 / 熔断次数"
          />
          <StatTile label="告警" value={selected.alerts} unit="条" tone={selected.alerts > 0 ? 'danger' : 'neutral'} hint="含被冷却压掉未推送的" />
          <StatTile
            label="暂停时长" value={formatPausedDuration(paused)} tone={pausedNow > 0 ? 'danger' : 'neutral'}
            hint={pausedNow > 0 ? `${pausedNow} 个实例仍在暂停中，时长在走` : '各实例暂停时长之和，跨天在 0 点切开'}
          />
        </MetricStrip>
      </Card>

      <div className="stats-grid-2">
        <Card title="按资源" padding="sm">
          <div className="stats-res-list">
            {resources.map((r) => (
              <div className="stats-res-row" key={r.type}>
                <ResourceBadge type={r.type} size={22} />
                <div className="stats-res-main">
                  <div className="stats-res-line">
                    <span className="stats-res-name">{RESOURCE_NAME[r.type]}</span>
                    <span className="stats-res-meta">
                      派兵 {r.dispatches} 次 · 完成 {r.completed} 趟
                      {r.unknownStorageDispatches > 0 && ` · ${r.unknownStorageDispatches} 趟储量未知`}
                      {r.share > 0 && ` · 占 ${Math.round(r.share * 100)}%`}
                    </span>
                  </div>
                  <div className="stats-bar" role="progressbar" aria-label={`${RESOURCE_NAME[r.type]}占比`}
                    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.share * 100)}>
                    <div className="stats-bar-fill" style={{ width: `${Math.round(r.share * 100)}%` }} />
                  </div>
                </div>
                <span className={`stats-res-amount ${r.estimatedAmount > 0 ? 'is-accent' : 'is-zero'}`}
                  title={r.estimatedAmount > 0 ? exactAmount(r.estimatedAmount) : undefined}>
                  {r.estimatedAmount > 0 ? formatCnAmount(r.estimatedAmount) : '—'}
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="按实例" padding="sm">
          {rows.length === 0 ? (
            <div className="stats-empty">
              <div className="stats-empty-title">这一天没有实例产生记录</div>
              <div className="stats-empty-desc">派兵、失败、告警、暂停任一发生时实例才会出现在这里。</div>
            </div>
          ) : (
            <div className="table-wrap stats-table-scroll">
              <table className="inst-table stats-table">
                <thead>
                  <tr>
                    <th scope="col">实例</th>
                    <th scope="col" className="stats-right">派兵</th>
                    <th scope="col" className="stats-right">预计采集量</th>
                    <th scope="col" className="stats-right">失败 / 熔断</th>
                    <th scope="col" className="stats-right">告警</th>
                    <th scope="col" className="stats-right">暂停时长</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row: InstanceDailyStats) => {
                    const name = row.accountName ?? (row.replaced ? null : accountNameOf(row.instanceIndex, row.instanceCreatedAt));
                    const pausedMs = livePausedMs(row, liveNow);
                    return (
                      <tr key={row.key}>
                        <td>
                          <span className="stats-instance">
                            <span>实例 {row.instanceIndex}</span>
                            {name && <span className="stats-micro">「{name}」</span>}
                            {row.replaced && <SemanticTag tone="neutral" title={`创建于 ${row.instanceCreatedAt ?? '未知'} 的实例，当天被替换`}>旧实例</SemanticTag>}
                            {row.pausedSince != null && isToday && <SemanticTag tone="danger">暂停中</SemanticTag>}
                          </span>
                        </td>
                        <td className="stats-right"><Num v={row.dispatches} /></td>
                        <td className="stats-right"><Amount n={instanceEstimated(row)} /></td>
                        <td className="stats-right stats-pair"><Num v={row.failures} tone="danger" /> / <Num v={row.circuitBreaks} tone="danger" /></td>
                        <td className="stats-right"><Num v={row.alerts} tone="warning" /></td>
                        <td className="stats-right"><span className={pausedMs > 0 ? 'stats-warning' : 'stats-dim'}>{formatPausedDuration(pausedMs)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        title={`资源统计快照 · ${selected.snapshots.length} 张`}
        icon="camera"
        padding="sm"
        extra={(
          <div className="stats-snap-actions">
            <label className="stats-snap-select">
              <span className="stats-micro">实例</span>
              <select value={snapIndex ?? ''} onChange={(event) => setSnapIndex(event.target.value === '' ? null : Number(event.target.value))} disabled={instances.length === 0}>
                {instances.length === 0 && <option value="">没有实例</option>}
                {instances.map((item) => (
                  <option key={item.record.index} value={item.record.index} disabled={!isRunning(item)}>
                    {`${item.record.index} · ${instanceName(item)}${isRunning(item) ? '' : '（未开机）'}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button" className="btn sm" disabled={snapBusy || snapDisabledReason !== null} onClick={() => void handleSnapshot()}
              title={snapDisabledReason ?? '会占用模拟器几秒：打开「道具 → 资源统计」读一遍再退回主界面。脚本正在跑、或游戏不在城内 / 世界地图时会被拒绝，稍后再点。'}
            >
              {snapBusy ? <Spinner size={14} /> : <Icon name="camera" />}读一次资源统计
            </button>
          </div>
        )}
      >
        {snapDisabledReason && instances.length > 0 && <p className="stats-micro" role="note">{snapDisabledReason}，先在「模拟器实例」页启动它。</p>}
        {selected.snapshots.length === 0 ? (
          <div className="stats-empty">
            <div className="stats-empty-title">这一天还没有资源统计快照</div>
            <div className="stats-empty-desc">
              快照来自游戏「道具 → 资源统计」弹窗（精度 0.1亿，只作对账）。点右上角「读一次资源统计」，读到的都会记到当天这里。
            </div>
          </div>
        ) : (
          <ResourceSnapshotTable snapshots={selected.snapshots} who={who} />
        )}
        <div className="stats-snap-hint">
          {isToday && cstDateKey(now) !== todayKey
            ? '北京时间已过 0 点，页面会随主进程推送自动换到新的一天。'
            : `最近一张：${selected.snapshots.length > 0 ? formatCstClock(selected.snapshots[selected.snapshots.length - 1]!.at) : '无'}`}
        </div>
      </Card>

      <Card title={`近 ${RECENT_DAYS} 天`} padding="sm" extra={<span className="stats-micro">点一行切换到那一天</span>}>
        {recentDesc.length === 0 ? (
          <div className="stats-empty">
            <div className="stats-empty-title">还没有历史数据</div>
            <div className="stats-empty-desc">{store.loaded ? (store.error ? '统计数据没能读出来，排除问题后点「重新拉取」。' : '这几天没有统计记录。') : '正在拉取…'}</div>
          </div>
        ) : (
          <div className="table-wrap stats-table-scroll">
            <table className="inst-table stats-table stats-table-wide">
              <thead>
                <tr>
                  <th scope="col">日期（北京）</th>
                  <th scope="col" className="stats-right">派兵</th>
                  <th scope="col" className="stats-right">预计采集量</th>
                  {RESOURCE_TYPES.map((t) => <th key={t} scope="col" className="stats-right">{RESOURCE_NAME[t]}</th>)}
                  <th scope="col" className="stats-right">完成</th>
                  <th scope="col" className="stats-right">失败 / 熔断</th>
                  <th scope="col" className="stats-right">告警</th>
                  <th scope="col" className="stats-right">暂停</th>
                </tr>
              </thead>
              <tbody>
                {recentDesc.map((day) => {
                  const selectedRow = day.dateKey === selectedKey;
                  const dayPaused = totalPausedMs(day, day.dateKey === todayKey ? now : 0);
                  return (
                    <tr
                      key={day.dateKey}
                      className={`stats-row-clickable ${selectedRow ? 'selected' : ''}`}
                      tabIndex={0}
                      aria-selected={selectedRow}
                      onClick={() => void store.selectDay(day.dateKey)}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void store.selectDay(day.dateKey); } }}
                    >
                      <td className="stats-mono">{day.dateKey}{day.dateKey === todayKey && <span className="stats-accent"> 今天</span>}</td>
                      <td className="stats-right"><Num v={day.dispatches} /></td>
                      <td className="stats-right"><Amount n={totalEstimated(day)} /></td>
                      {RESOURCE_TYPES.map((t) => {
                        const r = day.byResource[t];
                        return (
                          <td key={t} className="stats-right">
                            {r.dispatches === 0
                              ? <span className="stats-dim">—</span>
                              : <span className="stats-mono" title={`${r.dispatches} 次派兵，完成 ${r.completed} 趟`}>{formatCnAmount(r.estimatedAmount)}</span>}
                          </td>
                        );
                      })}
                      <td className="stats-right"><Num v={totalCompleted(day)} /></td>
                      <td className="stats-right stats-pair"><Num v={day.failures} tone="danger" /> / <Num v={day.circuitBreaks} tone="danger" /></td>
                      <td className="stats-right"><Num v={day.alerts} tone="warning" /></td>
                      <td className="stats-right"><span className={dayPaused > 0 ? 'stats-warning' : 'stats-dim'}>{formatPausedDuration(dayPaused)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {gameId && <InsightsPanel gameId={gameId} index={selectedIndex} mode="alerts" />}
    </div>
  );
}
