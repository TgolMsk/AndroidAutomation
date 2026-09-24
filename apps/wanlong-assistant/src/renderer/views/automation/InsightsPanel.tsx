import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  InsightAlert, InsightAlertKind, InsightDay, NotificationConfigPatch,
  NotificationConfigView, RemoteBotConfigView,
} from '../../../main/automation/insights/contracts';
import { avdm, errMsg } from '../../api';
import { beijingTime } from '../../format';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import './InsightsPanel.css';


const RESOURCE_LABEL: Record<keyof InsightDay['byResource'], string> = {
  wood: '木材', gold: '金币', iron: '铁矿石', mana: '魔水',
};
const ALERT_KIND: Record<InsightAlertKind, string> = {
  runFailed: '运行失败', circuitBroken: '采集熔断', schedulePaused: '自动续跑暂停',
  consecutiveFailures: '连续失败', recoveryExhausted: '恢复次数耗尽', dispatchStalled: '派兵停滞',
  suspectedKicked: '疑似被踢', maintenanceRequired: '游戏维护', updateRequired: '需要更新',
  suspectedFreeze: '疑似卡死',
};
const ALERT_KINDS: readonly InsightAlertKind[] = [
  'runFailed', 'circuitBroken', 'schedulePaused', 'consecutiveFailures', 'recoveryExhausted',
  'dispatchStalled', 'suspectedKicked', 'maintenanceRequired', 'updateRequired', 'suspectedFreeze',
];
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
  const toast = useToast();
  const [tab, setTab] = useState<'overview' | 'alerts' | 'notifications'>('overview');
  const [range, setRange] = useState<7 | 30>(7);
  const [days, setDays] = useState<InsightDay[]>([]);
  const [alerts, setAlerts] = useState<InsightAlert[]>([]);
  const [config, setConfig] = useState<NotificationConfigView | null>(null);
  const [draft, setDraft] = useState<NotificationConfigView | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [remoteConfig, setRemoteConfig] = useState<RemoteBotConfigView | null>(null);
  const [remoteDraft, setRemoteDraft] = useState<RemoteBotConfigView | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<'save' | 'test' | null>(null);
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'save' | 'local' | 'telegram' | 'clear' | null>(null);
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

  useEffect(() => {
    setConfig(null);
    setDraft(null);
    setTokenInput('');
    if (!gameId || index === null) { setConfigLoading(false); return; }
    let active = true;
    setConfigLoading(true);
    avdm.getNotificationConfig(gameId, index).then((value) => {
      if (!active) return;
      setConfig(value);
      setDraft(value);
    }).catch((cause: unknown) => {
      if (active) setError(errMsg(cause));
    }).finally(() => {
      if (active) setConfigLoading(false);
    });
    return () => { active = false; };
  }, [gameId, index]);

  useEffect(() => {
    let active = true;
    avdm.remoteBotConfig().then((value) => {
      if (!active) return;
      setRemoteConfig(value);
      setRemoteDraft(value);
    }).catch((cause: unknown) => {
      if (active) setError(errMsg(cause));
    });
    return () => { active = false; };
  }, []);

  useAvdmEvent('automation-run', (run) => {
    if (run.gameId !== gameId || (index !== null && run.index !== index) || run.endedAt === null) return;
    window.setTimeout(() => void refresh(), 750);
  });

  const total = useMemo(() => summarize(days), [days]);
  const today = days[days.length - 1];
  const maxDaily = Math.max(1, ...days.map((day) => day.dispatches));
  const dirty = Boolean(config && draft && (
    config.localEnabled !== draft.localEnabled ||
    config.telegram.enabled !== draft.telegram.enabled ||
    config.telegram.chatId !== draft.telegram.chatId ||
    config.telegram.cooldownSeconds !== draft.telegram.cooldownSeconds ||
    config.telegram.retryCount !== draft.telegram.retryCount ||
    config.telegram.timeoutMs !== draft.telegram.timeoutMs ||
    JSON.stringify(config.telegram.subscribedKinds) !== JSON.stringify(draft.telegram.subscribedKinds) ||
    tokenInput.trim() !== ''
  ));
  const remoteDirty = Boolean(remoteConfig && remoteDraft && (
    remoteConfig.enabled !== remoteDraft.enabled ||
    remoteConfig.authorizedUserId !== remoteDraft.authorizedUserId
  ));

  async function refreshRemote(): Promise<void> {
    const value = await avdm.remoteBotConfig();
    setRemoteConfig(value);
    setRemoteDraft(value);
  }

  function changeTelegram(patch: Partial<NotificationConfigView['telegram']>): void {
    if (!draft) return;
    setDraft({ ...draft, telegram: { ...draft.telegram, ...patch } });
  }

  async function save(): Promise<void> {
    if (index === null || !draft || !dirty || busy) return;
    setBusy('save');
    try {
      const patch: NotificationConfigPatch = {
        localEnabled: draft.localEnabled,
        telegram: {
          enabled: draft.telegram.enabled,
          chatId: draft.telegram.chatId,
          cooldownSeconds: draft.telegram.cooldownSeconds,
          retryCount: draft.telegram.retryCount,
          timeoutMs: draft.telegram.timeoutMs,
          subscribedKinds: draft.telegram.subscribedKinds,
          ...(tokenInput.trim() ? { botToken: tokenInput.trim() } : {}),
        },
      };
      const saved = await avdm.saveNotificationConfig(gameId, index, patch);
      setConfig(saved);
      setDraft(saved);
      setTokenInput('');
      await refreshRemote();
      toast.push({ kind: 'success', title: '通知设置已保存' });
    } catch (cause) {
      toast.error('无法保存通知设置', errMsg(cause));
    } finally {
      setBusy(null);
    }
  }

  async function clearToken(): Promise<void> {
    if (index === null || busy) return;
    setBusy('clear');
    try {
      const saved = await avdm.saveNotificationConfig(gameId, index, { telegram: { enabled: false, botToken: '' } });
      setConfig(saved);
      setDraft(saved);
      setTokenInput('');
      await refreshRemote();
      toast.push({ kind: 'success', title: 'Bot Token 已清除，Telegram 推送与只读查询已关闭' });
    } catch (cause) {
      toast.error('无法清除 Bot Token', errMsg(cause));
    } finally {
      setBusy(null);
    }
  }

  async function test(channel: 'local' | 'telegram'): Promise<void> {
    if (index === null || busy) return;
    setBusy(channel);
    try {
      const result = await avdm.testNotification(gameId, index, channel);
      if (result.ok) toast.push({ kind: 'success', title: result.message });
      else toast.error('测试未通过', result.message);
    } catch (cause) {
      toast.error('无法测试通知', errMsg(cause));
    } finally {
      setBusy(null);
    }
  }

  async function saveRemote(): Promise<void> {
    if (!remoteDraft || !remoteDirty || remoteBusy || busy) return;
    setRemoteBusy('save');
    try {
      const saved = await avdm.saveRemoteBotConfig({
        enabled: remoteDraft.enabled, authorizedUserId: remoteDraft.authorizedUserId,
      });
      setRemoteConfig(saved);
      setRemoteDraft(saved);
      toast.push({ kind: 'success', title: saved.enabled ? '只读查询已启用' : '只读查询设置已保存' });
    } catch (cause) {
      toast.error('无法保存只读查询设置', errMsg(cause));
    } finally {
      setRemoteBusy(null);
    }
  }

  async function testRemote(): Promise<void> {
    if (remoteBusy || busy) return;
    setRemoteBusy('test');
    try {
      const result = await avdm.testRemoteBot();
      if (result.ok) toast.push({ kind: 'success', title: result.message });
      else toast.error('只读查询测试未通过', result.message);
      await refreshRemote();
    } catch (cause) {
      toast.error('无法测试只读查询', errMsg(cause));
    } finally {
      setRemoteBusy(null);
    }
  }

  return (
    <section className="insights-panel" aria-label="自动化统计与通知">
      <div className="insights-topline">
        <div><span className="insights-eyebrow">INSIGHTS</span><h3>统计与通知</h3><p>根据已记录的采集运行与派兵事实生成。日期按北京时间归属。</p></div>
        <button className="btn xs" onClick={() => void refresh(true)} disabled={loading || Boolean(busy)}><Icon name="refresh" />刷新</button>
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
          <div className="insights-alert-row" key={alert.id}><span className={`insights-alert-icon is-${alert.severity}`}><Icon name="alert" size={15} /></span><div><strong>{ALERT_KIND[alert.kind]} <small>#{alert.index}</small></strong><p>{alert.message}</p></div><time>{timeLabel(alert.at)}</time></div>)}
      </div>}
      {!loading && tab === 'notifications' && (index === null ? <p className="insights-empty">选择一个实例后可设置通知。</p> : configLoading ? <p className="insights-loading"><Spinner size={15} />正在读取通知配置…</p> : draft && <div className="insights-notification-grid">
        <div className="insights-card"><div className="insights-card-title"><strong>通知方式</strong><span>每个游戏与实例独立启用</span></div>
          <label className="insights-toggle"><span><strong>macOS 本地通知</strong><small>系统原生通知；关闭时仍保留面板告警记录</small></span><input type="checkbox" checked={draft.localEnabled} onChange={(event) => setDraft({ ...draft, localEnabled: event.target.checked })} disabled={Boolean(busy)} /></label>
          <label className="insights-toggle"><span><strong>Telegram 推送</strong><small>仅向下方 Chat ID 发送已订阅的告警</small></span><input type="checkbox" checked={draft.telegram.enabled} onChange={(event) => changeTelegram({ enabled: event.target.checked })} disabled={Boolean(busy)} /></label>
          <div className="insights-notification-actions"><button className="btn" onClick={() => void test('local')} disabled={Boolean(busy)}>{busy === 'local' ? <Spinner size={14} /> : <Icon name="alert" />}测试本地通知</button><button className="btn" onClick={() => void test('telegram')} disabled={Boolean(busy) || !draft.telegram.botTokenSet}>{busy === 'telegram' ? <Spinner size={14} /> : <Icon name="external" />}测试 Telegram</button></div>
        </div>
        <div className="insights-card"><div className="insights-card-title"><strong>Telegram 通道</strong><span>凭据在本机共用，推送开关按实例保存</span></div>
          <div className="insights-fields">
            <label><span>Bot Token <small>{draft.telegram.botTokenSet ? `已保存 ${draft.telegram.botTokenMasked}` : '尚未保存'}</small></span><input type="password" autoComplete="off" value={tokenInput} placeholder={draft.telegram.botTokenSet ? '留空表示沿用现有 Token' : '从 BotFather 获取'} onChange={(event) => setTokenInput(event.target.value)} disabled={Boolean(busy)} /></label>
            <label><span>Chat ID</span><input type="text" inputMode="numeric" value={draft.telegram.chatId} placeholder="个人或群组的数字 ID" onChange={(event) => changeTelegram({ chatId: event.target.value })} disabled={Boolean(busy)} /></label>
            <label><span>同类告警冷却 · 秒</span><input type="number" min={0} max={86400} value={draft.telegram.cooldownSeconds} onChange={(event) => changeTelegram({ cooldownSeconds: Number(event.target.value) })} disabled={Boolean(busy)} /></label>
            <label><span>发送失败重试次数</span><input type="number" min={0} max={5} value={draft.telegram.retryCount} onChange={(event) => changeTelegram({ retryCount: Number(event.target.value) })} disabled={Boolean(busy)} /></label>
          </div>
          <div className="insights-subscriptions"><strong>订阅事件</strong>{ALERT_KINDS.map((kind) => <label key={kind}><input type="checkbox" checked={draft.telegram.subscribedKinds.includes(kind)} onChange={(event) => changeTelegram({ subscribedKinds: event.target.checked ? [...draft.telegram.subscribedKinds, kind] : draft.telegram.subscribedKinds.filter((item) => item !== kind) })} disabled={Boolean(busy)} />{ALERT_KIND[kind]}</label>)}</div>
          <div className="insights-save-row"><span>{dirty ? '设置尚未保存' : '已保存到本机'}</span><button className="btn primary" onClick={() => void save()} disabled={!dirty || Boolean(busy)}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}保存通知设置</button></div>
          {draft.telegram.botTokenSet && <button className="insights-clear" onClick={() => void clearToken()} disabled={Boolean(busy)}>清除已保存的 Bot Token</button>}
        </div>
        <div className="insights-card insights-remote"><div className="insights-card-title"><strong>Telegram 只读查询</strong><span>{remoteDraft?.running ? '正在接收命令' : remoteDraft?.enabled ? '已启用 · 等待连接' : '默认关闭'}</span></div>
          <p className="insights-remote-copy">在授权会话中使用 <code>/status</code> 查看实例状态，或用 <code>/shot 1</code> 获取实例 #1 的当前游戏画面。机器人无法点击、重启、登录或运行脚本。启用前先保存上方的 Bot Token 与 Chat ID。</p>
          {remoteDraft ? <>
            <label className="insights-toggle"><span><strong>允许只读查询</strong><small>全局设置；仅响应指定 Chat ID 和授权用户 ID</small></span><input type="checkbox" checked={remoteDraft.enabled} onChange={(event) => setRemoteDraft({ ...remoteDraft, enabled: event.target.checked })} disabled={Boolean(busy || remoteBusy)} /></label>
            <div className="insights-fields insights-remote-fields"><label><span>授权用户 ID</span><input type="text" inputMode="numeric" value={remoteDraft.authorizedUserId} placeholder="发命令的 Telegram 用户数字 ID" onChange={(event) => setRemoteDraft({ ...remoteDraft, authorizedUserId: event.target.value })} disabled={Boolean(busy || remoteBusy)} /></label></div>
            <div className="insights-save-row"><span>{remoteDirty ? '只读查询设置尚未保存' : remoteDraft.running ? '轮询已启动' : '当前未轮询'}</span><div className="insights-notification-actions"><button className="btn" onClick={() => void testRemote()} disabled={Boolean(busy || remoteBusy) || remoteDirty || !remoteDraft.enabled || !remoteDraft.botTokenSet || !remoteDraft.chatId || !remoteDraft.authorizedUserId}>{remoteBusy === 'test' ? <Spinner size={14} /> : <Icon name="external" />}测试连接并发送消息</button><button className="btn primary" onClick={() => void saveRemote()} disabled={!remoteDirty || Boolean(busy || remoteBusy)}>{remoteBusy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}保存只读查询</button></div></div>
          </> : <p className="insights-loading"><Spinner size={14} />正在读取只读查询设置…</p>}
        </div>
      </div>)}
    </section>
  );
}
