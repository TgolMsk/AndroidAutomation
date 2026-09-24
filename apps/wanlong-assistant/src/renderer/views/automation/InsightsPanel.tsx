import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InsightAlert, InsightAlertKind, InsightDay } from '../../../main/automation/insights/contracts';
import { ledgerKindLabel } from '../../../shared/alerts';
import { avdm, errMsg } from '../../api';
import { beijingTime } from '../../format';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useNavigation } from '../../state/navigation';
import './InsightsPanel.css';


const RESOURCE_LABEL: Record<keyof InsightDay['byResource'], string> = {
  wood: '木材', gold: '金币', iron: '铁矿石', mana: '魔水',
};
/** Ledger kind labels come from the single alert table (src/shared/alerts.ts). */
const alertKindLabel = (kind: InsightAlertKind): string => ledgerKindLabel(kind);
const number = new Intl.NumberFormat('zh-CN');
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });

function timeLabel(at: number): string {
  return beijingTime(at);
}

function summarize(days: InsightDay[]): InsightDay | null {
  if (!days.length) return null;
  const last = days[days.length - 1]!;
  const summary: InsightDay = {
    ...last,
    cycles: 0, succeeded: 0, failed: 0, cancelled: 0, circuitBreaks: 0,
    dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0, alerts: 0,
    byResource: {
      wood: { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0 },
      gold: { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0 },
      iron: { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0 },
      mana: { dispatches: 0, estimatedAmount: 0, unknownStorageDispatches: 0 },
    },
  };
  for (const day of days) {
    for (const key of ['cycles', 'succeeded', 'failed', 'cancelled', 'circuitBreaks', 'dispatches', 'estimatedAmount', 'unknownStorageDispatches', 'alerts'] as const) {
      summary[key] += day[key];
    }
    for (const resource of Object.keys(summary.byResource) as (keyof InsightDay['byResource'])[]) {
      for (const key of ['dispatches', 'estimatedAmount', 'unknownStorageDispatches'] as const) {
        summary.byResource[resource][key] += day.byResource[resource][key];
      }
    }
  }
  return summary;
}

export function InsightsPanel({ gameId, index }: { gameId: string; index: number | null }) {
  const { navigate } = useNavigation();
  const [tab, setTab] = useState<'overview' | 'alerts' | 'notifications'>('overview');
  const [range, setRange] = useState<7 | 30>(7);
  const [days, setDays] = useState<InsightDay[]>([]);
  const [alerts, setAlerts] = useState<InsightAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refreshSequence = useRef(0);

  const refresh = useCallback(async (showLoading = false) => {
    if (!gameId) return;
    const sequence = ++refreshSequence.current;
    if (showLoading) setLoading(true);
    try {
      const [nextDays, nextAlerts] = await Promise.all([
        avdm.insightDays(gameId, index, range),
        avdm.insightAlerts(gameId, index, 50),
      ]);
      if (sequence !== refreshSequence.current) return;
      setDays(nextDays);
      setAlerts(nextAlerts);
      setError('');
    } catch (cause) {
      if (sequence === refreshSequence.current) setError(errMsg(cause));
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }, [gameId, index, range]);

  useEffect(() => {
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { refreshSequence.current++; window.clearInterval(timer); };
  }, [refresh]);

  useAvdmEvent('automation-run', (run) => {
    if (run.gameId !== gameId || (index !== null && run.index !== index) || run.endedAt === null) return;
    window.setTimeout(() => void refresh(), 750);
  });

  const total = useMemo(() => summarize(days), [days]);
  const today = days[days.length - 1];
  const maxDaily = Math.max(1, ...days.map((day) => day.dispatches));
  return (
    <section className="insights-panel" aria-label="自动化统计与通知">
      <div className="insights-topline">
        <div><span className="insights-eyebrow">INSIGHTS</span><h3>统计与通知</h3><p>根据已记录的采集运行与派兵事实生成。日期按北京时间归属。</p></div>
        <button className="btn xs" onClick={() => void refresh(true)} disabled={loading}><Icon name="refresh" />刷新</button>
      </div>
      <nav className="insights-tabs" aria-label="统计与通知页面">
        {([['overview', '数据概览'], ['alerts', '告警记录'], ['notifications', '通知设置']] as const).map(([key, label]) =>
          <button key={key} type="button" className={tab === key ? 'is-active' : ''} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{label}</button>)}
      </nav>
      {error && <div className="insights-inline-error" role="alert">数据读取失败：{error}<button className="btn xs" onClick={() => void refresh(true)}>重试</button></div>}
      {loading && <p className="insights-loading"><Spinner size={15} />正在读取统计与通知设置…</p>}
      {!loading && tab === 'overview' && <>
        <div className="insights-range"><span>{index === null ? '当前游戏 · 全部实例' : `当前游戏 · 实例 #${index}`}</span><label>时间范围<select value={range} onChange={(event) => setRange(Number(event.target.value) as 7 | 30)}><option value={7}>最近 7 天</option><option value={30}>最近 30 天</option></select></label></div>
        <div className="insights-kpis">
          <div><span>已确认派兵</span><strong>{number.format(total?.dispatches ?? 0)}</strong><small>今日 {today?.dispatches ?? 0} 次</small></div>
          <div><span>预计采集量</span><strong>{compact.format(total?.estimatedAmount ?? 0)}</strong><small>按派兵时卡片储量估算</small></div>
          <div><span>完成轮数</span><strong>{number.format(total?.succeeded ?? 0)}</strong><small>共 {total?.cycles ?? 0} 轮</small></div>
          <div><span>失败 / 熔断</span><strong className={(total?.failed ?? 0) > 0 ? 'is-alert' : ''}>{total?.failed ?? 0} / {total?.circuitBreaks ?? 0}</strong><small>近 {range} 天</small></div>
        </div>
        <div className="insights-grid">
          <div className="insights-card"><div className="insights-card-title"><strong>每日派兵</strong><span>北京时间 00:00 切日</span></div>
            {days.every((day) => day.dispatches === 0) ? <p className="insights-empty">尚无已确认的派兵记录。运行采集后这里会显示趋势。</p> :
              <div className="insights-chart" role="img" aria-label={`最近 ${range} 天每日派兵次数`}>
                {days.map((day) => <div className="insights-bar-column" key={day.dateKey} title={`${day.dateKey}：${day.dispatches} 次派兵`}><div className="insights-bar-track"><div style={{ height: `${Math.max(day.dispatches > 0 ? 6 : 0, day.dispatches / maxDaily * 100)}%` }} /></div><span>{Number(day.dateKey.slice(-2))}日</span></div>)}
              </div>}
          </div>
          <div className="insights-card"><div className="insights-card-title"><strong>资源构成</strong><span>按已确认派兵记录</span></div>
            <div className="insights-resource-list">{total && (Object.keys(total.byResource) as (keyof InsightDay['byResource'])[]).map((resource) =>
              <div key={resource}><span>{RESOURCE_LABEL[resource]}</span><strong>{total.byResource[resource].dispatches} 趟</strong><small>预计 {compact.format(total.byResource[resource].estimatedAmount)}</small></div>)}</div>
            {(total?.unknownStorageDispatches ?? 0) > 0 && <p className="insights-caveat">{total!.unknownStorageDispatches} 趟未读到储量，预计量偏低。</p>}
          </div>
        </div>
        <p className="insights-disclaimer"><Icon name="info" size={15} />“预计采集量”取派兵时资源点卡片的储量，不代表队伍已回城或实际入账。</p>
      </>}
      {!loading && tab === 'alerts' && <div className="insights-card insights-alerts"><div className="insights-card-title"><strong>最近告警</strong><span>最多显示 50 条 · 本机保留 90 天</span></div>
        {alerts.length === 0 ? <p className="insights-empty">当前范围暂无告警。</p> : alerts.map((alert) =>
          <div className="insights-alert-row" key={alert.id}><span className={`insights-alert-icon is-${alert.severity}`}><Icon name="alert" size={15} /></span><div><strong>{alertKindLabel(alert.kind)} <small>#{alert.index}</small></strong><p>{alert.message}</p></div><time>{timeLabel(alert.at)}</time></div>)}
      </div>}
      {!loading && tab === 'notifications' && <div className="insights-card"><div className="insights-card-title"><strong>通知与推送</strong><span>全部实例共用一份设置</span></div>
        <p className="insights-remote-copy">Telegram 推送、本机通知、订阅哪些事件、推送冷却、异常判定阈值、卡死自动重启与手机远程操作，现在统一在「设置 → 通知与推送」里设置（Bot Token 仍用系统钥匙串加密保存）。被异常暂停的实例在「采集总览」上显示红色横幅，处理好后点「恢复」。</p>
        <div className="insights-notification-actions"><button className="btn primary" onClick={() => navigate('settings')}><Icon name="settings" />前往通知与推送设置</button></div>
      </div>}
    </section>
  );
}
