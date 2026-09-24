import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { ScriptMeta } from '../../../main/plans/types';
import { describeTrigger, emptyTask, makeTaskId, PLAN_PHASE_TEXT, type PlanOverview, type PlanTaskState } from '../../../shared/plan';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useNavigation } from '../../state/navigation';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import { LegacyPlanImport } from './LegacyPlanImport';
import { PlanConfigDialog } from './PlanConfigDialog';
import {
  accountOptions, cleanTask, lastRunText, limitText, nextRunText, PHASE_TONE, queueLines, runNowBlocked, scriptOptions,
  taskDraftProblem, taskSwitchTitle, waitedText, withTask,
} from './plans-model';
import { TaskDialog, type TaskDraft } from './TaskDialog';
import './PlansView.css';

/** Safety-net refresh while the page is shown; `plan-changed` pushes keep it live in between. */
const POLL_MS = 15_000;

/**
 * 任务计划 (original PlansView): every account's tasks in one table — switches, Beijing-time triggers, phase,
 * next-run countdown, last run, run now / stop, edit, delete — plus the plan settings and the legacy import.
 * The page holds no rule of its own: when a task runs, who goes first and the preemption of gathering are all
 * decided by the planner in the main process (the same rule written twice drifts into two behaviours).
 */
export function PlansView({ visible }: ViewProps) {
  const toast = useToast();
  const { gameId, game } = useSelection();
  const { navigate } = useNavigation();
  const { refreshPlanRuns } = usePlanRuns();
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskDraft | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [removing, setRemoving] = useState<PlanTaskState | null>(null);
  /** Ticks every second so countdowns move: local extrapolation, no IPC. */
  const [now, setNow] = useState(Date.now());
  const current = useRef(gameId);
  current.current = gameId;

  const reload = useCallback(async () => {
    if (!gameId) return;
    setLoading(true);
    try {
      const [next, accountList, scriptList] = await Promise.all([avdm.planOverview(gameId), avdm.accountList(gameId), avdm.scriptList(gameId)]);
      if (current.current !== gameId) return;
      setOverview(next);
      setAccounts(accountList);
      setScripts(scriptList);
      setError('');
    } catch (cause) {
      if (current.current === gameId) setError(errMsg(cause));
    } finally { setLoading(false); }
  }, [gameId]);

  // Another game's plans are never shown under this one.
  useEffect(() => { setOverview(null); setError(''); }, [gameId]);

  useEffect(() => {
    if (!visible) return;
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload, visible]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);

  useAvdmEvent('plan-changed', (next) => { if (next.gameId === current.current) setOverview(next); });
  useAvdmEvent('plan-config-changed', (event) => {
    if (event.gameId === current.current) setOverview((prev) => (prev ? { ...prev, config: event.config } : prev));
  });
  // Bindings, logins and account switches change what a row can do.
  useAvdmEvent('account-changed', () => { if (visible) void reload(); });

  const rows = overview?.tasks ?? [];
  const config = overview?.config ?? null;
  const queues = useMemo(() => queueLines(overview?.queues ?? [], rows), [overview, rows]);
  const accountChoices = useMemo(() => accountOptions(accounts), [accounts]);
  const scriptChoices = useMemo(() => scriptOptions(scripts), [scripts]);

  if (!game) return null;

  async function action(label: string, work: () => Promise<void>, done?: string): Promise<void> {
    if (busy) return;
    setBusy(label);
    try {
      await work();
      if (done) toast.push({ kind: 'success', title: done });
    } catch (cause) { toast.error(`${label}失败`, errMsg(cause)); }
    finally { setBusy(null); }
  }

  const apply = (next: PlanOverview): void => { if (next.gameId === current.current) setOverview(next); };

  const toggleTask = (row: PlanTaskState): Promise<void> => action(row.enabled ? '关闭任务' : '启用任务', async () => {
    apply(await avdm.planSetTaskEnabled(gameId, row.accountId, row.taskId, !row.enabled));
  });
  const toggleAccount = (row: PlanTaskState): Promise<void> => action(row.accountEnabled ? '关闭账号计划' : '启用账号计划', async () => {
    apply(await avdm.planSetAccountEnabled(gameId, row.accountId, !row.accountEnabled));
  });
  const toggleTotal = (): Promise<void> => action(config?.enabled ? '关闭总开关' : '打开总开关', async () => {
    const next = await avdm.planSaveConfig(gameId, { enabled: !config?.enabled });
    setOverview((prev) => (prev ? { ...prev, config: next } : prev));
  });
  const runNow = (row: PlanTaskState): Promise<void> => action('立即运行', async () => {
    await avdm.planRunNow(gameId, row.accountId, row.taskId);
    await Promise.all([reload(), refreshPlanRuns()]);
  }, '已加入队列');
  const stop = (row: PlanTaskState): Promise<void> => action('停止', async () => {
    apply(await avdm.planCancel(gameId, row.accountId, row.taskId));
    await refreshPlanRuns();
  }, '已停止');

  const openNew = (): void => {
    const accountId = accounts[0]?.id;
    const scriptId = scriptChoices[0]?.value;
    if (!accountId || !scriptId) {
      toast.push({
        kind: 'warn', title: '还不能排计划',
        detail: !accountId ? '先去「账号管理」建一个账号并绑定实例，再来排计划。' : '先去「脚本」页建一个脚本，再来排计划。',
        action: { label: !accountId ? '去账号管理' : '去脚本页', onClick: () => navigate(!accountId ? 'accounts' : 'scripts') },
      });
      return;
    }
    setDraft({ accountId, task: emptyTask(makeTaskId(), scriptId), editing: false });
  };

  const openEdit = (row: PlanTaskState): Promise<void> => action('读取任务', async () => {
    const plan = await avdm.planGet(gameId, row.accountId);
    const task = plan.tasks.find((item) => item.id === row.taskId);
    if (!task) throw new Error('这条任务已经不在计划里了，刷新一下再试。');
    setDraft({ accountId: row.accountId, task: structuredClone(task), editing: true });
  });

  /** Every edit reads the account's plan, changes one task and writes the plan back (original mutatePlan). */
  const saveDraft = (): Promise<void> => action('保存任务', async () => {
    if (!draft) return;
    const problem = taskDraftProblem(draft.task);
    if (problem) throw new Error(problem);
    const plan = await avdm.planGet(gameId, draft.accountId);
    await avdm.planSave(gameId, withTask(plan, cleanTask(draft.task)));
    setDraft(null);
    await reload();
  }, '任务已保存');

  const remove = async (row: PlanTaskState): Promise<void> => {
    try { apply(await avdm.planRemoveTask(gameId, row.accountId, row.taskId)); }
    catch (cause) { toast.error('删除任务失败', errMsg(cause)); throw cause; }
  };

  const saveConfig = (patch: Parameters<typeof avdm.planSaveConfig>[1]): Promise<void> => action('保存计划设置', async () => {
    const next = await avdm.planSaveConfig(gameId, patch);
    setOverview((prev) => (prev ? { ...prev, config: next } : prev));
    setConfigOpen(false);
  }, '计划设置已保存');

  return (
    <section className="plans-view" aria-labelledby="plans-title">
      <header className="plans-head">
        <div>
          <h2 id="plans-title">任务计划 <span className="tag">{rows.length} 条任务</span></h2>
          <p>给账号勾选脚本并设定运行时间（北京时间），到点自动排队执行。</p>
        </div>
        <div className="plans-head-actions">
          <span className="plans-total" title="关掉后一切定时都不生效，只剩「立即运行」。">
            总开关
            <PlanSwitch on={config?.enabled ?? false} label="计划总开关" disabled={!config || Boolean(busy)} onClick={() => void toggleTotal()} />
          </span>
          <button type="button" className="btn sm" disabled={!config} onClick={() => setConfigOpen(true)}><Icon name="settings" size={14} /> 计划设置</button>
          <button type="button" className="btn sm" onClick={() => void reload()} disabled={loading}>
            {loading ? <Spinner size={12} /> : <Icon name="refresh" size={14} />} 刷新
          </button>
          <button type="button" className="btn sm primary" onClick={openNew} disabled={Boolean(busy)}><Icon name="plus" size={14} /> 添加任务</button>
        </div>
      </header>

      <div className="notice info"><Icon name="info" />
        <span><strong>脚本优先级最高。</strong>到点要跑脚本时，自动采集会先礼后兵地让开（先等它收尾，超时就打断），脚本跑完再放回去并在 15 秒后重读一次队列。
          同一个实例上的任务<strong>按优先级排队挨个跑</strong>，不会同时动一个模拟器；失败重试会先把实例让出来。运行时间里的 HH:MM 都是<strong>北京时间</strong>。</span>
      </div>

      {overview && !overview.config.enabled && rows.length > 0 && (
        <div className="notice warn"><Icon name="alert" /><span>总开关没打开：定时任务都不会自动运行，只能手动「立即运行」。</span></div>
      )}
      {overview?.contended && (
        <div className="notice info"><Icon name="info" /><span>另一个万龙助手进程正在管理定时计划：这里的修改会生效，但到点执行与「立即运行」要在那个窗口里进行。</span></div>
      )}
      {overview && overview.warnings.length > 0 && (
        <div className="notice warn" role="status"><Icon name="alert" />
          <span>计划文件读取时发现问题，已自动修复：{overview.warnings.join(' ')}</span>
        </div>
      )}
      {error && <div className="notice bad" role="alert"><Icon name="alert" />任务计划读取失败：{error} <button className="link-btn" onClick={() => void reload()}>重试</button></div>}

      {!overview ? (!error && <p className="plans-dim"><Spinner size={12} /> 正在读取任务计划…</p>)
        : rows.length === 0 ? (
          <div className="plans-empty"><Icon name="workflow" size={22} /><strong>还没有任何计划</strong>
            <span>点右上角「添加任务」，给某个账号勾一个脚本、设个时间。</span></div>
        ) : (
          <div className="table-wrap plans-scroll">
            <table className="inst-table plans-table">
              <thead><tr>
                <th>启用</th><th>账号</th><th>脚本</th><th>运行时间</th><th>状态</th><th>下次运行</th><th>上次</th><th aria-label="操作" />
              </tr></thead>
              <tbody>
                {rows.map((row) => {
                  const next = nextRunText(row, now);
                  const last = lastRunText(row);
                  const waited = waitedText(row, now);
                  const blocked = runNowBlocked(row);
                  const active = row.phase === 'running' || row.phase === 'queued';
                  return (
                    <tr key={`${row.accountId}::${row.taskId}`} className={row.accountEnabled ? '' : 'is-muted'}>
                      <td>
                        <PlanSwitch on={row.enabled} label={`启用任务 ${row.scriptName ?? row.scriptId}`} title={taskSwitchTitle(row)}
                          disabled={!row.accountEnabled || Boolean(busy)} onClick={() => void toggleTask(row)} />
                      </td>
                      <td>
                        <div className="plans-account">
                          <PlanSwitch on={row.accountEnabled} label={`启用账号计划 ${row.accountName}`} title="账号计划开关：关掉后这个账号下所有任务都不自动跑"
                            disabled={Boolean(busy) || row.accountMissing} onClick={() => void toggleAccount(row)} />
                          <strong>{row.accountName}</strong>
                        </div>
                        {row.instanceIndex === null
                          ? <span className="plans-warn">未绑定实例，跑不了</span>
                          : <span className="plans-dim">实例 #{row.instanceIndex}{row.accountIssue ? ` · ${row.accountIssue}` : ''}</span>}
                      </td>
                      <td>
                        {row.scriptName ? <>
                          <span>{row.scriptName}</span>
                          {row.note && <span className="plans-dim plans-sub" title={row.note}>{row.note}</span>}
                        </> : <span className="plans-bad">脚本已删除（{row.scriptId}）</span>}
                      </td>
                      <td>
                        <span>{describeTrigger(row.trigger)}</span>
                        <span className="plans-dim plans-sub">{limitText(row)}</span>
                      </td>
                      <td>
                        <SemanticTag tone={PHASE_TONE[row.phase]}>{PLAN_PHASE_TEXT[row.phase]}</SemanticTag>
                        {waited && <span className="plans-dim plans-sub">{waited}</span>}
                        {row.holdUntil !== null && row.phase !== 'running' && <span className="plans-dim plans-sub">稍后重试（还剩 {row.retryLeft} 次）</span>}
                        {row.lastError && row.phase !== 'running' && <span className="plans-dim plans-sub plans-error-text" title={row.lastError}>{row.lastError}</span>}
                      </td>
                      <td>
                        {next ? <>
                          <span className="mono">{next.countdown}</span>
                          <span className="plans-dim plans-sub">{next.at}</span>
                        </> : <span className="plans-dim">—</span>}
                      </td>
                      <td>
                        {last ? <>
                          <span className="plans-sub-strong">{last.at}</span>
                          <span className="plans-dim plans-sub">{last.counts}</span>
                        </> : <span className="plans-dim">还没跑过</span>}
                      </td>
                      <td><div className="plans-actions">
                        {active ? (
                          <button type="button" className="btn xs" disabled={Boolean(busy)} onClick={() => void stop(row)}><Icon name="stop" size={13} /> 停止</button>
                        ) : (
                          <button type="button" className="btn xs" disabled={Boolean(busy) || blocked !== null || Boolean(overview?.contended)}
                            title={overview?.contended ? '另一个万龙助手进程正管理脚本计划，请在那个窗口执行' : blocked ?? '无视触发时间，照样排队并让采集先让路'}
                            onClick={() => void runNow(row)}><Icon name="play" size={13} /> 立即运行</button>
                        )}
                        {row.phase === 'running' && row.runId && (
                          <button type="button" className="icon-btn small" title="在执行监控里查看" aria-label="在执行监控里查看" onClick={() => navigate('runs')}>
                            <Icon name="log" size={14} />
                          </button>
                        )}
                        <button type="button" className="icon-btn small" title="编辑" aria-label={`编辑任务 ${row.scriptName ?? row.scriptId}`}
                          disabled={Boolean(busy) || row.accountMissing} onClick={() => void openEdit(row)}><Icon name="edit" size={14} /></button>
                        <button type="button" className="icon-btn small plans-danger" title="删除" aria-label={`删除任务 ${row.scriptName ?? row.scriptId}`}
                          disabled={Boolean(busy)} onClick={() => setRemoving(row)}><Icon name="trash" size={14} /></button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      {queues.length > 0 && (
        <div className="plans-queues" aria-live="polite">
          <strong>实例队列</strong>
          {queues.map((line) => <span key={line}>{line}</span>)}
        </div>
      )}

      <LegacyPlanImport gameId={gameId} accounts={accounts} onImported={() => void reload()} />

      {draft && (
        <TaskDialog draft={draft} accountOptions={accountChoices} scriptOptions={scriptChoices} busy={busy === '保存任务'}
          onChange={setDraft} onClose={() => setDraft(null)} onSave={() => void saveDraft()} />
      )}
      {configOpen && config && (
        <PlanConfigDialog config={config} busy={busy === '保存计划设置'} onClose={() => setConfigOpen(false)} onSave={(patch) => void saveConfig(patch)} />
      )}
      {removing && (
        <ConfirmDialog title="删掉这条任务？" danger confirmLabel="删除"
          message={<>「{removing.scriptName ?? removing.scriptId}」（{removing.accountName}，{describeTrigger(removing.trigger)}）会从计划里删除；
            {removing.phase === 'running' || removing.phase === 'queued' ? '它正在排队或执行，会先被停止。' : '已经留下的运行记录不受影响。'}</>}
          onConfirm={() => remove(removing)} onClose={() => setRemoving(null)} />
      )}
    </section>
  );
}

function PlanSwitch({ on, label, title, disabled, onClick }: { on: boolean; label: string; title?: string; disabled?: boolean; onClick(): void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={title} disabled={disabled}
      className={`plans-switch ${on ? 'is-on' : ''}`} onClick={onClick}><span /></button>
  );
}
