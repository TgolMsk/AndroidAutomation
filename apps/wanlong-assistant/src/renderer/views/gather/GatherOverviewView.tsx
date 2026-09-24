import { useMemo, useState } from 'react';
import { formatDuration } from '@avdm/automation/wanlong/pure';
import { Icon } from '../../components/Icon';
import { MetricStrip } from '../../components/MetricStrip';
import { StatTile } from '../../components/StatTile';
import { Spinner } from '../../components/StatusBadge';
import { useCountdownTick } from '../../hooks/useCountdownTick';
import { isRunActive, useActivity } from '../../state/activity';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { accountOfIndex, boundTo, isBaseInstance } from '../accounts/account-model';
import { useAccounts, useBaseInstance } from '../accounts/useAccounts';
import type { ViewProps } from '../types';
import { GatherConfigDrawer } from './GatherConfigDrawer';
import { InstanceMarchCard } from './InstanceMarchCard';
import { InstanceRunDrawer } from './InstanceRunDrawer';
import { pauseInfoOf, pausedIndexes } from './pause-port';
import { countdownWindows, formatAgo, formatClock, formatShort, summarizeQueues } from './present';
import { useGatherConfigBadges } from './useGatherConfigBadges';
import { useGatherControls } from './useGatherControls';
import { useGatherQueues } from './queue-store';
import { CountPill } from './widgets';
import './gather.css';

/**
 * 采集总览 / 群控倒计时 (original features/gather/GatherOverviewView). Every countdown on screen shares one per-second
 * clock and is derived locally from the samples' absolute times — zero adb cost. Gathering shows 「采集中 HH:MM:SS」 and
 * flips to 「返回中 MM:SS」 at gatherDoneAt by itself (freeAt = gatherDoneAt + travel time is known since the dispatch).
 * Only two things touch the emulator: 「立即采样」 and the scheduler's own wakes / calibrations.
 */
export function GatherOverviewView({ visible }: ViewProps) {
  const { game, gameId, targets, index: selectedIndex, instancesLoaded, instancesError, reloadInstances } = useSelection();
  const { accounts } = useAccounts(gameId || undefined);
  const base = useBaseInstance(gameId || undefined);
  const queues = useGatherQueues(gameId);
  const { runs } = useActivity();
  const { activePlanRuns } = usePlanRuns();
  const now = useCountdownTick(visible);
  const [configFor, setConfigFor] = useState<number | null>(null);
  const [runFor, setRunFor] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const instanceOf = (i: number) => targets.find((target) => target.index === i)?.instance;
  const nameOf = (i: number) => instanceOf(i)?.record.name ?? `实例 #${i}`;
  const boundAccountOf = (i: number) => {
    const account = accountOfIndex(accounts, i);
    return account && boundTo(account, instanceOf(i)) ? account : null;
  };
  const controls = useGatherControls(gameId, game?.packageName ?? '', queues, nameOf);
  const indices = targets.map((target) => target.index);
  const { badges, problemCount, refresh: refreshBadges } = useGatherConfigBadges(gameId, indices,
    (i) => queues.byInstance[i]?.auto === true, (i) => boundAccountOf(i) !== null);

  const { imminentMs, staleAfterMs } = countdownWindows(queues.config);
  const states = useMemo(() => targets.map((target) => queues.stateOf(target.index, boundAccountOf(target.index)?.id ?? null)),
    // stateOf is a fresh closure each render; what it reads is the snapshot map and the accounts.
    [targets, queues.byInstance, accounts]);
  const pauses = useMemo(() => states.map((state) => pauseInfoOf(state)), [states]);
  const sum = useMemo(() => summarizeQueues(states), [states]);
  const pausedList = pausedIndexes(pauses);
  const activeTasks = runs.filter(isRunActive).length + activePlanRuns;

  if (!game) return null;

  const nextFreeText = sum.nextFreeAt == null ? '—' : sum.nextFreeAt <= now ? '已到期' : formatShort(sum.nextFreeAt - now);
  const configTarget = configFor === null ? null : { index: configFor, name: nameOf(configFor), account: boundAccountOf(configFor)?.name ?? null };

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try { await queues.reload(); refreshBadges(); }
    finally { setRefreshing(false); }
  }

  return (
    <div className="gather-page">
      <header className="gather-page-head">
        <div>
          <h2>采集总览</h2>
          <p>查看各账号的队伍进度、空闲队列与下一次采集时间。</p>
        </div>
        <div className="gather-inline">
          <button type="button" className="btn sm gather-pill-host" disabled={targets.length === 0}
            onClick={() => setConfigFor(selectedIndex ?? targets[0]?.index ?? null)}
            title={targets.length === 0 ? '还没有实例，先到「设备与账号」添加或刷新实例。'
              : `打开的是当前选中实例的采集配置 —— 配置按实例（绑定账号时按账号）存，没有全局配置。角标数字 = 有几个开着自动调度的实例配置有问题（现在 ${problemCount} 个），具体是哪个看下面卡片上的角标。`}>
            <Icon name="settings" />采集配置<CountPill count={problemCount} />
          </button>
          <button type="button" className="btn sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? <Spinner size={12} /> : <Icon name="refresh" />}刷新状态
          </button>
          <button type="button" className="btn sm" onClick={() => void reloadInstances()}>刷新实例列表</button>
        </div>
      </header>

      {queues.loaded && queues.error && (
        <div className="notice warn" role="alert"><Icon name="alert" /><div><strong>调度状态没能拉到</strong><div>{queues.error}</div>
          <button type="button" className="btn xs" onClick={() => void queues.reload()}>重试</button></div></div>
      )}
      {instancesError && <p className="gather-inline-error" role="alert">实例列表加载失败：{instancesError}</p>}
      {queues.status && !queues.status.owner && (
        <div className="notice info" role="status"><Icon name="info" /><div>{queues.status.message ?? '另一个万龙助手进程正在管理自动采集调度，本窗口只显示状态。'}</div></div>
      )}
      {pausedList.length > 0 && (
        <div className="notice bad" role="alert"><Icon name="alert" /><div>
          <strong>{pausedList.length} 个实例已被暂停，需要人工介入</strong>
          <div>已暂停：{pausedList.map((i) => `#${i}`).join('、')}。自动调度已关掉，不会再操作这些实例的游戏；原因点下面红框卡片右上角的角标查看，处理完在卡片底部点「恢复」。</div>
        </div></div>
      )}

      <section className="gather-summary" aria-label="采集汇总">
        <MetricStrip label="采集汇总">
          <StatTile label="总队列占用" value={sum.queueTotal > 0 ? `${sum.queueUsed}/${sum.queueTotal}` : '—'}
            hint={sum.queueTotal > 0 ? `已读到队列数据的 ${sum.instanceCount} 个实例合计` : '还没有实例读到面板右上角的队列 N/M'} />
          <StatTile label="最近到期" value={nextFreeText} tone="accent"
            hint={sum.nextFreeAt == null ? '当前没有能算出释放时刻的在途队伍'
              : `实例 #${sum.nextFreeInstance} 于 ${formatClock(sum.nextFreeAt)}（北京时间）释放队列，唤醒还会再加 ${queues.config.slackSeconds} 秒冗余`} />
          <StatTile label="在途队伍" value={sum.activeMarches} unit="支" hint="正在行军 / 采集 / 返程，不含空闲行与读不出的行" />
          <StatTile label="执行中任务" value={activeTasks} unit="个" hint="正在运行的采集任务与脚本任务" />
          {(sum.unreadableMarches > 0 || sum.failedInstances > 0) && (
            <StatTile label="识别异常" value={sum.unreadableMarches + sum.failedInstances} unit="处" tone="danger"
              hint={`${sum.unreadableMarches} 行倒计时读不出、${sum.failedInstances} 个实例采样失败，原因见各卡片`} />
          )}
        </MetricStrip>
        <div className="gather-summary-foot">
          <span className="gather-micro">
            {sum.autoInstances} 个实例已开自动调度
            {sum.nextWakeAt != null && ` · 下次唤醒 ${formatClock(sum.nextWakeAt)}（实例 #${sum.nextWakeInstance}${sum.nextWakeReason ? ` · ${sum.nextWakeReason}` : ''}）`}
          </span>
          <span className="gather-micro">
            {sum.oldestSampledAt == null ? '尚无采样' : `最旧一份采样于 ${formatAgo(now - sum.oldestSampledAt)}`}
            {` · 校准间隔 ${formatDuration(queues.config.calibrateIntervalMin * 60_000)} · 时间均为北京时间`}
          </span>
        </div>
      </section>

      {!instancesLoaded && targets.length === 0 ? <p className="gather-empty"><Spinner /> 正在读取实例…</p>
        : targets.length === 0 ? (
          <div className="gather-empty">
            <div className="gather-empty-title">没有可显示的实例</div>
            <div className="gather-empty-desc">到「设备与账号 → 模拟器实例」新建或刷新实例。</div>
          </div>
        ) : (
          <div className="gather-cards">
            {targets.map((target, i) => {
              const account = accountOfIndex(accounts, target.index);
              const bound = account && boundTo(account, target.instance);
              return (
                <InstanceMarchCard key={target.index} index={target.index} name={nameOf(target.index)} instance={target.instance}
                  accountLabel={account ? bound ? account.name : `${account.name}（实例已替换）` : '未绑定账号'}
                  state={states[i]!} now={now} imminentMs={imminentMs} staleAfterMs={staleAfterMs}
                  sampling={queues.sampling[target.index] === true} toggling={queues.autoBusy[target.index] === true}
                  resuming={queues.resuming[target.index] === true} pause={pauses[i]!}
                  isBase={isBaseInstance(base.view, target.instance)} badge={badges[target.index] ?? null}
                  onToggleAuto={(idx, on) => void controls.toggleAuto(idx, on)} onSample={(idx) => void controls.sample(idx)}
                  onResume={controls.resume} onOpenConfig={setConfigFor} onOpenRun={setRunFor} />
              );
            })}
          </div>
        )}

      {configTarget && (
        <GatherConfigDrawer gameId={gameId} index={configTarget.index} instanceName={configTarget.name} boundAccount={configTarget.account}
          autoOn={queues.byInstance[configTarget.index]?.auto === true} onClose={() => setConfigFor(null)}
          onSaved={() => { refreshBadges(); void queues.reload(); }} />
      )}
      {runFor !== null && (
        <InstanceRunDrawer game={game} index={runFor} instance={instanceOf(runFor)} autoOn={queues.byInstance[runFor]?.auto === true}
          status={queues.status} onClose={() => setRunFor(null)} />
      )}
      {controls.dialog}
    </div>
  );
}
