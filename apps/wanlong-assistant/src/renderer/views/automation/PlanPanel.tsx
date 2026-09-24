import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { AccountPlan, PlanConfig, PlanOverview, PlanTask, ScriptMeta, TaskTrigger } from '../../../main/plans/types';
import { legacyPlanChoices } from '../../../main/plans/legacy';
import { avdm, errMsg } from '../../api';
import { beijingTime } from '../../format';
import { useToast } from '../../components/Toasts';
import { usePlanImport } from '../../state/plan-import';
import { legacyPlanForAccount, withLegacyPlanFile } from './plan-legacy-import';
import './PlanPanel.css';

const api = avdm;
const emptyPlan = (accountId: string): AccountPlan => ({ accountId, enabled: false, tasks: [], updatedAt: 0 });
const clone = <T,>(value: T): T => structuredClone(value);
const triggerLabel = (trigger: TaskTrigger): string => {
  if (trigger.kind === 'manual') return '手动';
  if (trigger.kind === 'daily') return `每天 ${trigger.at.join('、')}`;
  return `每 ${trigger.everyMinutes} 分钟${trigger.window ? ` · ${trigger.window.from}–${trigger.window.to}` : ''}`;
};
const fmt = (at: number | null): string => beijingTime(at);

export type PlanPanelMode = 'plans' | 'scripts';

interface PlanPanelProps {
  gameId: string;
  index: number | null;
  visible?: boolean;
  /** Pin the panel to one part (the shell shows plans and the script library as separate pages). */
  mode?: PlanPanelMode;
  /** In `plans` mode: open the script library page (e.g. 「添加任务」 while no script exists yet). */
  onOpenScripts?(): void;
  /** After any successful action (save, run now, stop …), e.g. to refresh the shell's running-task count. */
  onChanged?(): void;
}

export function PlanPanel({ gameId, index, visible = true, mode, onOpenScripts, onChanged }: PlanPanelProps) {
  const toast = useToast();
  // Shared with the other page: scripts imported there must be found when a plan is imported here.
  const { legacy, updateLegacy } = usePlanImport();
  const [ownTab, setOwnTab] = useState<PlanPanelMode>(mode ?? 'plans');
  const tab = mode ?? ownTab;
  const setTab = (next: PlanPanelMode): void => {
    if (!mode) setOwnTab(next);
    else if (next !== mode && next === 'scripts') onOpenScripts?.();
  };
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [accountId, setAccountId] = useState('');
  const [plan, setPlan] = useState<AccountPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [planDirty, setPlanDirty] = useState(false);
  const [configDraft, setConfigDraft] = useState<PlanConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const { planFile: legacyPlanFile, planAccountId: legacyAccountId, message: importMessage } = legacy;

  const refresh = useCallback(async () => {
    try {
      const [state, nextAccounts, nextScripts] = await Promise.all([
        api.planOverview(gameId), avdm.accountList(gameId), api.scriptList(gameId),
      ]);
      setOverview(state);
      setAccounts(nextAccounts);
      setScripts(nextScripts);
      setAccountId((current) => current && nextAccounts.some((a) => a.id === current)
        ? current : nextAccounts.find((a) => a.binding?.index === index)?.id ?? nextAccounts[0]?.id ?? '');
      setError('');
    } catch (cause) { setError(errMsg(cause)); }
  }, [gameId, index]);
  useEffect(() => {
    // A hidden (kept-alive) panel does not poll; it refreshes as soon as it is shown again.
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, visible]);
  useEffect(() => {
    if (planDirty) return;
    const found = overview?.plans.find((one) => one.accountId === accountId);
    setPlan(found ? clone(found) : accountId ? emptyPlan(accountId) : null);
  }, [accountId, overview?.plans, planDirty]);
  useEffect(() => { if (!configDirty && overview) setConfigDraft(clone(overview.config)); }, [overview?.config, configDirty]);

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const selectedRuns = useMemo(() => (overview?.runs ?? []).filter((run) => !accountId || run.accountId === accountId).slice(0, 20), [overview, accountId]);
  const scriptName = (id: string): string => scripts.find((item) => item.id === id)?.name ?? id;
  const updateTask = (id: string, patch: Partial<PlanTask>): void => {
    setPlanDirty(true);
    setPlan((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) } : null);
  };
  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(label);
    try { await fn(); await refresh(); onChanged?.(); toast.push({ kind: 'success', title: `${label}已完成` }); }
    catch (cause) { toast.error(`${label}失败`, errMsg(cause)); }
    finally { setBusy(''); }
  };
  const savePlan = (): void => { if (plan) void act('保存计划', async () => { await api.planSave(gameId, plan); setPlanDirty(false); }); };
  const loadLegacyPlanFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      legacyPlanChoices(data); // Throws on a file that is not a legacy plans.json, before anything changes.
      updateLegacy((current) => withLegacyPlanFile(current, data));
    } catch (cause) { toast.error('无法读取旧计划', errMsg(cause)); }
  };
  const importLegacyPlan = (): void => {
    if (!legacyPlanFile || !legacyAccountId || !accountId) return;
    void act('导入旧计划', async () => {
      // Read the library afresh: the scripts may have just been imported on the other page.
      const available = (await api.scriptList(gameId)).map((item) => item.id);
      const imported = legacyPlanForAccount(legacy, accountId, available);
      await api.planSave(gameId, imported.plan);
      await api.planSaveConfig(gameId, imported.config);
      setPlanDirty(false);
      setConfigDirty(false);
      updateLegacy((current) => ({ ...current, message: imported.warnings.join(' ') }));
    });
  };

  const heading = mode === 'plans' ? { label: 'PLANS', title: '任务计划', text: '每个账号绑定一个实例。计划按北京时间触发，实例内串行执行。' }
      : { label: 'WORKFLOWS', title: '脚本与任务计划', text: '每个账号绑定一个实例。计划按北京时间触发，实例内串行执行。' };
  return <section className="plan-panel" aria-label={heading.title}>
    <header className="plan-heading"><div><span>{heading.label}</span><h2>{heading.title}</h2><p>{heading.text}</p></div><button className="btn xs" onClick={() => void refresh()}>刷新</button></header>
    {tab === 'plans' && <div className="plan-safety">脚本优先于自动采集：脚本开跑前，该实例的自动采集会先让路（等正在进行的采样或派遣收尾，必要时中断），脚本结束约 15 秒后重读队列并恢复。同一时刻只有一方操作实例（实例锁）。</div>}
    {!mode && <nav className="plan-tabs"><button className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}>任务计划</button><button className={tab === 'scripts' ? 'active' : ''} onClick={() => setTab('scripts')}>脚本库</button></nav>}
    {error && <p className="plan-error" role="alert">{error}</p>}
    {tab === 'plans' && <>
      <div className="plan-toolbar"><label>账号<select value={accountId} onChange={(e) => { setPlanDirty(false); setAccountId(e.target.value); }}><option value="">选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.binding ? `#${account.binding.index}` : '未绑定'}</option>)}</select></label><label className="plan-switch"><input type="checkbox" checked={overview?.config.enabled ?? false} onChange={(e) => void act('更新计划总开关', async () => { await api.planSaveConfig(gameId, { enabled: e.target.checked }); })} disabled={!overview || !!busy} />自动计划总开关</label></div>
      {configDraft && <details className="plan-settings"><summary>调度设置</summary><div className="plan-task-fields"><label>错过后补跑（分钟）<input type="number" min={0} max={720} value={configDraft.catchUpMs / 60_000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, catchUpMs: Number(e.target.value) * 60_000 }); }} /></label><label>排队等待上限（分钟）<input type="number" min={1} max={720} value={configDraft.queueWaitMs / 60_000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, queueWaitMs: Number(e.target.value) * 60_000 }); }} /></label><label>失败重试次数<input type="number" min={0} max={5} value={configDraft.retry} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, retry: Number(e.target.value) }); }} /></label><label>重试等待（秒）<input type="number" min={0} max={1800} value={configDraft.retryDelayMs / 1000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, retryDelayMs: Number(e.target.value) * 1000 }); }} /></label><label title="所有实例合计，采集不计入；撞上上限的计划任务会稍后重试，不算失败">同时运行脚本上限（1–16）<input type="number" min={1} max={16} value={configDraft.maxConcurrentScripts ?? 4} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, maxConcurrentScripts: Number(e.target.value) }); }} /></label></div><div className="plan-settings-foot"><span>失败重试会从脚本首步重新执行；涉及点击、提交等动作时建议保持 0 次。</span><button className="btn sm" disabled={!configDirty || !!busy} onClick={() => void act('保存调度设置', async () => { await api.planSaveConfig(gameId, configDraft); setConfigDirty(false); })}>保存设置</button></div></details>}
      <div className="plan-import"><label className="btn xs">导入旧 plans.json<input type="file" accept=".json,application/json" onChange={(e) => void loadLegacyPlanFile(e.currentTarget.files?.[0])} /></label>{Boolean(legacyPlanFile) && <><select aria-label="旧账号计划" value={legacyAccountId} onChange={(e) => { const planAccountId = e.target.value; updateLegacy((current) => ({ ...current, planAccountId })); }}>{legacyPlanChoices(legacyPlanFile).map((choice) => <option key={choice.accountId} value={choice.accountId}>{choice.accountId} · {choice.tasks} 项</option>)}</select><button className="btn xs" onClick={importLegacyPlan} disabled={!accountId || !!busy}>导入到当前账号</button></>}</div>
      {importMessage && <p className="plan-import-message" role="status">{importMessage}</p>}
      {!accounts.length && <div className="plan-empty">还没有账号。先在「设备与账号 → 账号管理」创建并绑定实例，再配置脚本计划。</div>}
      {selectedAccount && plan && <>
        <div className="plan-summary"><div><strong>{selectedAccount.name}</strong><small>{selectedAccount.binding ? `实例 #${selectedAccount.binding.index}` : '未绑定实例'} · {selectedAccount.login.status === 'ready' ? '已验证登录' : '待验证登录'}</small></div><label className="plan-switch"><input type="checkbox" checked={plan.enabled} onChange={(e) => { setPlanDirty(true); setPlan({ ...plan, enabled: e.target.checked }); }} />启用该账号计划</label><button className="btn primary sm" onClick={savePlan} disabled={!!busy || !planDirty}>保存计划</button></div>
        <div className="plan-tasks-heading"><h3>任务</h3><button className="btn sm" onClick={() => {
          const first = scripts.find((item) => item.version !== '0');
          if (!first) { setTab('scripts'); return; }
          setPlanDirty(true); setPlan({ ...plan, tasks: [...plan.tasks, { id: `task-${crypto.randomUUID().slice(0, 8)}`, scriptId: first.id, enabled: false,
            trigger: { kind: 'manual' }, priority: 50, maxRunMinutes: 30 }] });
        }}>＋ 添加任务</button></div>
        {!plan.tasks.length && <div className="plan-empty">此账号暂无任务。先在脚本库保存一个脚本，再添加任务。</div>}
        <div className="plan-task-list">{plan.tasks.map((task) => <div className="plan-task" key={task.id}>
          <div className="plan-task-top"><label className="plan-switch"><input type="checkbox" checked={task.enabled} onChange={(e) => updateTask(task.id, { enabled: e.target.checked })} /><strong>{scriptName(task.scriptId)}</strong></label><span>{triggerLabel(task.trigger)}</span><button className="btn xs" onClick={() => void act('立即运行', async () => { await api.planRunNow(gameId, plan.accountId, task.id); })} disabled={!!busy || planDirty || !selectedAccount.enabled || !selectedAccount.binding}>立即运行</button><button className="btn xs" onClick={() => { setPlanDirty(true); setPlan({ ...plan, tasks: plan.tasks.filter((one) => one.id !== task.id) }); }}>移除</button></div>
          <div className="plan-task-fields"><label>脚本<select value={task.scriptId} onChange={(e) => updateTask(task.id, { scriptId: e.target.value })}>{scripts.filter((item) => item.version !== '0').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>触发<select value={task.trigger.kind} onChange={(e) => updateTask(task.id, { trigger: e.target.value === 'daily' ? { kind: 'daily', at: ['08:00'] } : e.target.value === 'interval' ? { kind: 'interval', everyMinutes: 60 } : { kind: 'manual' } })}><option value="manual">仅手动</option><option value="daily">每天定时</option><option value="interval">固定间隔</option></select></label>
          {task.trigger.kind === 'daily' && <label>北京时间<input value={task.trigger.at.join(', ')} onChange={(e) => updateTask(task.id, { trigger: { kind: 'daily', at: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) } })} placeholder="08:00, 20:30" /></label>}
          {task.trigger.kind === 'interval' && <label>间隔（分钟）<input type="number" min={1} max={1440} value={task.trigger.everyMinutes} onChange={(e) => updateTask(task.id, { trigger: { ...task.trigger as Extract<TaskTrigger, { kind: 'interval' }>, everyMinutes: Number(e.target.value) } })} /></label>}
          <label>优先级<input type="number" min={0} max={100} value={task.priority} onChange={(e) => updateTask(task.id, { priority: Number(e.target.value) })} /></label><label>最长运行（分钟）<input type="number" min={1} max={120} value={task.maxRunMinutes} onChange={(e) => updateTask(task.id, { maxRunMinutes: Number(e.target.value) })} /></label></div>
          <label className="plan-note">备注<input value={task.note ?? ''} onChange={(e) => updateTask(task.id, { note: e.target.value })} placeholder="这次任务要做什么" /></label>
        </div>)}</div>
      </>}
      <div className="plan-runs"><h3>最近执行</h3>{!selectedRuns.length && <p>暂无执行记录</p>}{selectedRuns.map((run) => <div key={run.runId}><span className={`plan-phase is-${run.status}`}>{run.status}</span><strong>{scriptName(run.scriptId)}</strong><small>#{run.instanceIndex} · {fmt(run.startedAt ?? run.queuedAt)}</small><span>{run.message}</span>{['queued', 'running'].includes(run.status) && <button className="btn xs" onClick={() => void act('停止脚本', async () => { await api.planCancelRun(gameId, run.runId); })}>停止</button>}</div>)}</div>
    </>}
    {tab === 'scripts' && <div className="plan-empty">脚本在「脚本与模板 → 脚本」页编辑（可视化块编辑器、从画面截取、校验与试跑）。<button className="btn xs" onClick={() => onOpenScripts?.()} disabled={!onOpenScripts}>打开脚本页</button></div>}
  </section>;
}
