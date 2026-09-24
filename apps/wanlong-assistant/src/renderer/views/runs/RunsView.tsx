import { useEffect, useMemo, useState } from 'react';
import type { MatchResult } from '@avdm/automation';
import type { ScriptRunSnapshot } from '../../../main/plans/types';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime, isRunning } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { RUN_LABEL, isRunActive, useActivity } from '../../state/activity';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import { RunLogPane } from './RunLogPane';
import {
  buildRunRows, formatDuration, hitRate, LOW_HIT_RATE, progressLabel, ROW_STATUS_LABEL, SLOW_TICK_MS, type RunRow,
} from './run-rows';
import { StartRunDialog } from './StartRunDialog';
import './RunsView.css';

/** Faster than the shell's shared poll while this page is on screen. */
const PLAN_POLL_MS = 5_000;
const MAX_MATCHES_SHOWN = 60;

function StatsTags({ snapshot }: { snapshot: ScriptRunSnapshot }) {
  const { stats } = snapshot;
  const rate = hitRate(stats);
  return (
    <div className="runs-tags">
      <span className="tag" title="截图次数">截图 {stats.captures}</span>
      <span className={`tag ${rate !== null && rate < LOW_HIT_RATE ? 'warn' : ''}`} title="模板匹配次数 / 命中次数">
        命中 {stats.matchHits}/{stats.matches}{rate !== null ? `（${rate}%）` : ''}
      </span>
      <span className="tag">点击 {stats.taps}</span>
      {stats.retries > 0 && <span className="tag warn">重试 {stats.retries}</span>}
      <span className={`tag ${stats.lastTickMs > SLOW_TICK_MS ? 'warn' : ''}`} title="最近一次完整步骤耗时 / 平均截图耗时">
        tick {stats.lastTickMs}ms｜截图 {Math.round(stats.avgCaptureMs)}ms
      </span>
    </div>
  );
}

function Tile({ label, value, unit, hint, tone }: { label: string; value: string | number; unit?: string; hint?: string; tone?: 'bad' | 'good' }) {
  return (
    <div className={`runs-tile ${tone ? `is-${tone}` : ''}`}>
      <span className="runs-tile-label">{label}</span>
      <span className="runs-tile-value">{value}{unit && <small>{unit}</small>}</span>
      {hint && <span className="runs-tile-hint">{hint}</span>}
    </div>
  );
}

function Progress({ row }: { row: RunRow }) {
  if (!row.snapshot) return <span className="runs-muted">{row.message || '—'}</span>;
  const progress = progressLabel(row.snapshot);
  return (
    <div className="runs-progress">
      {progress.percent !== null && (
        <div className={`progress runs-progress-bar ${row.status === 'failed' ? 'is-failed' : ''}`} role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      <span className="runs-muted" title={progress.text}>{progress.percent !== null ? `${progress.percent}%｜` : ''}{progress.text}</span>
    </div>
  );
}

/** 执行监控: script executions (live progress, controls, logs, shots) and gather rounds on every instance. */
export function RunsView({ visible }: ViewProps) {
  const toast = useToast();
  const { game, instances, index: selectedIndex } = useSelection();
  const { runs, refreshRuns } = useActivity();
  const { planRuns, scriptRuns, planRunsError: planError, refreshPlanRuns: refreshPlans } = usePlanRuns();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [tab, setTab] = useState<'logs' | 'matches'>('logs');
  const [debugRuns, setDebugRuns] = useState<ReadonlySet<string>>(new Set());
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [, setClock] = useState(0);
  const gameId = game?.id ?? '';

  useEffect(() => {
    if (!visible) return;
    void refreshPlans();
    const timer = window.setInterval(() => { void refreshPlans(); }, PLAN_POLL_MS);
    // Durations of running rows tick every second.
    const clock = window.setInterval(() => setClock((n) => n + 1), 1000);
    return () => { window.clearInterval(timer); window.clearInterval(clock); };
  }, [refreshPlans, visible]);

  const scriptNames = useMemo(() => new Map(scriptRuns.map((run) => [run.scriptId, run.scriptName])), [scriptRuns]);
  const rows = useMemo(() => buildRunRows(planRuns, scriptRuns, (id) => scriptNames.get(id) ?? id), [planRuns, scriptRuns, scriptNames]);
  const selected = rows.find((row) => row.runId === selectedRunId) ?? rows.find((row) => row.active) ?? rows[0] ?? null;
  const busyByIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of rows) if (row.active) map.set(row.instanceIndex, row.scriptName);
    return map;
  }, [rows]);
  const idleInstance = instances.some((instance) => isRunning(instance) && !busyByIndex.has(instance.record.index));
  const startReason = !gameId ? '游戏模块尚未加载' : !idleInstance ? '没有空闲且已开机的实例。请先到「模拟器实例」启动一个实例。' : null;

  useAvdmEvent('run-matches', (event) => {
    if (event.runId !== selected?.runId) return;
    setMatches((current) => [...event.results, ...current].slice(0, MAX_MATCHES_SHOWN));
  });
  useEffect(() => { setMatches([]); }, [selected?.runId]);

  async function act(label: string, id: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(id);
    try { await work(); }
    catch (error) { toast.error(`${label}失败`, errMsg(error)); }
    finally { setBusy(null); }
  }

  const control = (label: string, row: RunRow, work: () => Promise<void>): Promise<void> => act(label, row.runId, async () => {
    await work();
    await refreshPlans();
  });

  async function toggleDebug(row: RunRow): Promise<void> {
    const enabled = !debugRuns.has(row.runId);
    await act('切换匹配调试', `debug-${row.runId}`, async () => {
      await avdm.runDebugMatches(gameId, row.runId, enabled);
      setDebugRuns((current) => {
        const next = new Set(current);
        if (enabled) next.add(row.runId); else next.delete(row.runId);
        return next;
      });
    });
  }

  const gatherRuns = runs.filter((run) => !gameId || run.gameId === gameId).slice(0, 30);
  const taskName = (taskId: string): string => game?.tasks.find((task) => task.id === taskId)?.name ?? taskId;
  const activeGather = gatherRuns.filter(isRunActive).length;
  const activeScripts = rows.filter((row) => row.active).length;
  const snapshot = selected?.snapshot ?? null;
  const rate = snapshot ? hitRate(snapshot.stats) : null;

  return (
    <div className="runs-view">
      <section className="runs-section" aria-labelledby="runs-script-title">
        <header className="runs-head">
          <div>
            <h2 id="runs-script-title">脚本执行</h2>
            <span>{activeScripts} 个排队或运行中 · 计划任务与临时运行都在这里</span>
          </div>
          <div className="runs-head-actions">
            <button className="btn sm" onClick={() => void act('刷新', 'refresh', refreshPlans)} disabled={busy !== null}>
              {busy === 'refresh' ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}刷新
            </button>
            <button className="btn sm primary" onClick={() => setStartOpen(true)} disabled={startReason !== null} title={startReason ?? '在一个实例上立即运行脚本'}>
              <Icon name="play" size={14} />启动执行
            </button>
          </div>
        </header>
        {startReason && gameId && <p className="runs-muted">{startReason}</p>}
        {planError && <p className="runs-error" role="alert">脚本执行记录读取失败：{planError}</p>}
        {rows.length === 0 ? <p className="runs-empty">还没有脚本执行记录。点右上角「启动执行」在实例上试跑一个脚本，或在「任务计划」里立即运行。</p> : (
          <div className="table-wrap runs-scroll">
            <table className="inst-table runs-table">
              <thead><tr><th>实例</th><th>脚本 / 账号</th><th>状态</th><th>进度</th><th>运行时长</th><th>运行统计</th><th aria-label="操作" /></tr></thead>
              <tbody>{rows.slice(0, 80).map((row) => (
                <tr key={row.runId} className={`runs-row ${selected?.runId === row.runId ? 'is-selected' : ''}`} onClick={() => setSelectedRunId(row.runId)}>
                  <td className="mono">#{row.instanceIndex}</td>
                  <td>
                    <div className="runs-cell-main">{row.scriptName}</div>
                    <div className="runs-muted">{row.accountName ?? '未绑定账号'} · {row.source === 'plan' ? '计划任务' : '临时运行'}</div>
                  </td>
                  <td><span className={`runs-status is-${row.status}`}>{ROW_STATUS_LABEL[row.status]}</span></td>
                  <td className="runs-progress-cell"><Progress row={row} /></td>
                  <td className="mono">{formatDuration(row.startedAt, row.endedAt)}</td>
                  <td>{row.snapshot ? <StatsTags snapshot={row.snapshot} /> : <span className="runs-muted">—</span>}</td>
                  <td className="runs-actions" onClick={(event) => event.stopPropagation()}>
                    {row.snapshot && row.active && (row.status === 'paused'
                      ? <button className="btn xs" disabled={busy !== null} onClick={() => void control('继续执行', row, () => avdm.runResume(gameId, row.runId))}><Icon name="play" size={12} />继续</button>
                      : <button className="btn xs" disabled={busy !== null || row.status !== 'running'} onClick={() => void control('暂停执行', row, () => avdm.runPause(gameId, row.runId))}>暂停</button>)}
                    {row.active && (confirmStop === row.runId
                      ? <span className="runs-confirm">
                        <span>跑完当前步骤后退出？</span>
                        <button className="btn xs danger" disabled={busy !== null} onClick={() => void control('停止执行', row, async () => { setConfirmStop(null); await avdm.runStop(gameId, row.runId); })}>
                          {busy === row.runId ? <Spinner size={12} /> : null}确认停止
                        </button>
                        <button className="btn xs" onClick={() => setConfirmStop(null)}>取消</button>
                      </span>
                      : <button className="btn xs danger-ghost" disabled={busy !== null || row.status === 'stopping'} onClick={() => setConfirmStop(row.runId)}><Icon name="stop" size={12} />停止</button>)}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <section className="runs-section runs-detail" aria-labelledby="runs-detail-title">
          <header className="runs-head">
            <div>
              <h2 id="runs-detail-title">{selected.scriptName}</h2>
              <span>
                实例 #{selected.instanceIndex} · {ROW_STATUS_LABEL[selected.status]} · 开始 {beijingTime(selected.startedAt, 'full')}
                {selected.endedAt ? ` · 结束 ${beijingTime(selected.endedAt, 'full')}` : ''}
              </span>
            </div>
            <div className="runs-head-actions">
              <button className="btn sm ghost" title="复制执行 id" onClick={() => void navigator.clipboard?.writeText(selected.runId).then(() => toast.push({ kind: 'success', title: '已复制执行 id' }), () => undefined)}>
                <Icon name="copy" size={14} /><span className="mono runs-run-id">{selected.runId.slice(0, 8)}</span>
              </button>
              <button className="btn sm" onClick={() => void act('打开实时画面', 'live', () => avdm.openLiveView(selected.instanceIndex))}>
                <Icon name="screen" size={14} />打开实时画面
              </button>
            </div>
          </header>
          {selected.status === 'failed' && selected.message && <p className="notice bad" role="alert">执行失败：{selected.message}</p>}
          {(selected.status === 'skipped' || selected.status === 'cancelled') && selected.message && <p className="notice">{selected.message}</p>}
          {snapshot && (
            <div className="runs-tiles">
              <Tile label="截图次数" value={snapshot.stats.captures} />
              <Tile label="匹配命中" value={`${snapshot.stats.matchHits}/${snapshot.stats.matches}`} tone={rate !== null && rate < LOW_HIT_RATE ? 'bad' : undefined}
                hint={rate !== null ? `命中率 ${rate}%${rate < LOW_HIT_RATE ? '（低于 30% 多半是模板或 ROI 不对）' : ''}` : '还没有匹配记录'} />
              <Tile label="点击次数" value={snapshot.stats.taps} />
              <Tile label="重试次数" value={snapshot.stats.retries} tone={snapshot.stats.retries > 0 ? 'bad' : undefined} />
              <Tile label="tick 耗时" value={snapshot.stats.lastTickMs} unit="ms" tone={snapshot.stats.lastTickMs > SLOW_TICK_MS ? 'bad' : undefined} hint="最近一次完整步骤" />
              <Tile label="平均截图" value={Math.round(snapshot.stats.avgCaptureMs)} unit="ms" hint="游戏在前台约 300–750ms 属正常" />
              {snapshot.stepTotal === null && <Tile label="已完成轮次" value={snapshot.iteration} />}
            </div>
          )}
          <div className="runs-tabs" role="tablist" aria-label="执行详情">
            <button role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'is-active' : ''} onClick={() => setTab('logs')}>实时日志</button>
            <button role="tab" aria-selected={tab === 'matches'} className={tab === 'matches' ? 'is-active' : ''} onClick={() => setTab('matches')}>匹配调试</button>
          </div>
          {tab === 'logs' && gameId && <RunLogPane gameId={gameId} runId={selected.runId} />}
          {tab === 'matches' && (
            <div className="runs-matches">
              <div className="runs-log-toolbar">
                <label className="check small">
                  <input type="checkbox" checked={debugRuns.has(selected.runId)} disabled={!selected.snapshot || !selected.active || busy !== null}
                    onChange={() => void toggleDebug(selected)} />
                  推送这次执行的每次模板匹配（仅调试时打开，最多每秒 3 批）
                </label>
                {!selected.active && <span className="runs-muted">执行已结束，无法再打开匹配调试。</span>}
              </div>
              {matches.length === 0 ? <p className="runs-log-empty">还没有匹配记录。打开上面的开关后，脚本每次匹配模板都会出现在这里；画面请看「打开实时画面」。</p> : (
                <div className="table-wrap runs-scroll">
                  <table className="inst-table runs-match-table">
                    <thead><tr><th>模板</th><th>结果</th><th>分数 / 阈值</th><th>中心（参考坐标）</th><th>耗时</th></tr></thead>
                    <tbody>{matches.map((match, i) => (
                      <tr key={`${match.templateId}-${i}`}>
                        <td className="mono">{match.templateId}</td>
                        <td><span className={`runs-status ${match.found ? 'is-succeeded' : 'is-failed'}`}>{match.found ? '命中' : match.reason ?? '未命中'}</span></td>
                        <td className="mono">{match.score} / {match.threshold}</td>
                        <td className="mono">{match.found ? `${Math.round(match.centerX)}, ${Math.round(match.centerY)}` : '—'}</td>
                        <td className="mono">{match.elapsedMs}ms</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="runs-section" aria-labelledby="runs-gather-title">
        <header className="runs-head"><div><h2 id="runs-gather-title">采集运行</h2><span>{activeGather} 个进行中 · 显示最近 {gatherRuns.length} 条</span></div></header>
        {gatherRuns.length === 0 ? <p className="runs-empty">还没有采集运行记录。</p> : <div className="table-wrap runs-scroll">
          <table className="inst-table">
            <thead><tr><th>实例</th><th>任务</th><th>状态</th><th>开始（北京）</th><th>结束</th><th>说明</th><th aria-label="操作" /></tr></thead>
            <tbody>{gatherRuns.map((run) => <tr key={run.runId}>
              <td className="mono">#{run.index}</td>
              <td>{taskName(run.taskId)}</td>
              <td><span className={`runs-status is-${run.status}`}>{RUN_LABEL[run.status]}</span></td>
              <td>{beijingTime(run.startedAt)}</td>
              <td>{beijingTime(run.endedAt)}</td>
              <td className="runs-message" title={run.message}>{run.message || '—'}</td>
              <td>{isRunActive(run) && <button className="btn xs danger-ghost" disabled={busy !== null || run.status === 'stopping'} onClick={() => void act('停止采集', run.runId, async () => { await avdm.stopAutomation(run.runId); await refreshRuns(); })}>{busy === run.runId ? <Spinner size={12} /> : null}停止</button>}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>

      {startOpen && gameId && (
        <StartRunDialog gameId={gameId} instances={instances} busy={busyByIndex} initialIndex={selectedIndex}
          onStarted={(started) => { setSelectedRunId(started.runId); setTab('logs'); void refreshPlans(); }}
          onClose={() => setStartOpen(false)} />
      )}
    </div>
  );
}
