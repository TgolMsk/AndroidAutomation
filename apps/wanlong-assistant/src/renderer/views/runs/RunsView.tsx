import { useCallback, useEffect, useState } from 'react';
import type { PlanRun } from '../../../main/plans/types';
import { avdm, errMsg } from '../../api';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { RUN_LABEL, isRunActive, useActivity } from '../../state/activity';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import './RunsView.css';

const PLAN_RUN_LABEL: Record<PlanRun['status'], string> = {
  queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过',
};

const PLAN_POLL_MS = 5_000;

/** 执行监控: what is running right now on every instance — gather rounds and plan script runs. */
export function RunsView({ visible }: ViewProps) {
  const toast = useToast();
  const { game } = useSelection();
  const { runs, refreshRuns } = useActivity();
  const [planRuns, setPlanRuns] = useState<PlanRun[]>([]);
  const [planError, setPlanError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const gameId = game?.id ?? '';

  const refreshPlans = useCallback(async () => {
    if (!gameId) return;
    try {
      setPlanRuns((await avdm.planOverview(gameId)).runs);
      setPlanError(undefined);
    } catch (error) {
      setPlanError(errMsg(error));
    }
  }, [gameId]);

  useEffect(() => {
    if (!visible) return;
    void refreshPlans();
    const timer = window.setInterval(() => void refreshPlans(), PLAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshPlans, visible]);

  async function stop(label: string, id: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(id);
    try { await work(); }
    catch (error) { toast.error(`${label}失败`, errMsg(error)); }
    finally { setBusy(null); }
  }

  const gatherRuns = runs.filter((run) => !gameId || run.gameId === gameId).slice(0, 30);
  const taskName = (taskId: string): string => game?.tasks.find((task) => task.id === taskId)?.name ?? taskId;
  const activeGather = gatherRuns.filter(isRunActive).length;
  const activePlans = planRuns.filter((run) => run.status === 'queued' || run.status === 'running').length;

  return (
    <div className="runs-view">
      <section className="runs-section" aria-labelledby="runs-gather-title">
        <header className="runs-head"><h2 id="runs-gather-title">采集运行</h2><span>{activeGather} 个进行中 · 显示最近 {gatherRuns.length} 条</span></header>
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
              <td>{isRunActive(run) && <button className="btn xs danger-ghost" disabled={busy !== null || run.status === 'stopping'} onClick={() => void stop('停止采集', run.runId, async () => { await avdm.stopAutomation(run.runId); await refreshRuns(); })}>{busy === run.runId ? <Spinner size={12} /> : null}停止</button>}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>

      <section className="runs-section" aria-labelledby="runs-plan-title">
        <header className="runs-head"><h2 id="runs-plan-title">脚本执行</h2><span>{activePlans} 个排队或运行中</span></header>
        {planError && <p className="runs-error" role="alert">脚本执行记录读取失败：{planError}</p>}
        {planRuns.length === 0 ? <p className="runs-empty">还没有脚本执行记录。在「任务计划」里立即运行或按时间触发后会出现在这里。</p> : <div className="table-wrap runs-scroll">
          <table className="inst-table">
            <thead><tr><th>实例</th><th>账号</th><th>脚本</th><th>状态</th><th>排队 / 开始（北京）</th><th>说明</th><th aria-label="操作" /></tr></thead>
            <tbody>{planRuns.slice(0, 50).map((run) => <tr key={run.runId}>
              <td className="mono">#{run.instanceIndex}</td>
              <td>{run.accountName}</td>
              <td className="mono">{run.scriptId}</td>
              <td><span className={`runs-status is-${run.status}`}>{PLAN_RUN_LABEL[run.status]}</span></td>
              <td>{beijingTime(run.startedAt ?? run.queuedAt)}</td>
              <td className="runs-message" title={run.message}>{run.message || '—'}</td>
              <td>{(run.status === 'queued' || run.status === 'running') && <button className="btn xs danger-ghost" disabled={busy !== null} onClick={() => void stop('停止脚本', run.runId, async () => { await avdm.planCancelRun(gameId, run.runId); await refreshPlans(); })}>{busy === run.runId ? <Spinner size={12} /> : null}停止</button>}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </section>
    </div>
  );
}
