import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateSet } from '@avdm/automation';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { AccountPlan, PlanConfig, PlanOverview, PlanRun, PlanTask, ScriptDef, ScriptIssue, ScriptMeta, ScriptStep, TaskTrigger } from '../../../main/plans/types';
import { convertLegacyAccountPlan, convertLegacyConfig, convertLegacyScript, legacyPlanChoices } from '../../../main/plans/legacy';
import { avdm, errMsg } from '../../api';
import { useToast } from '../../components/Toasts';
import { ScriptStepBlock } from './ScriptStepBlock';
import { insertSavedTemplate, type TemplateInsertRequest, type TemplateInsertResult } from './script-template-flow';
import './PlanPanel.css';

const api = avdm;
const emptyPlan = (accountId: string): AccountPlan => ({ accountId, enabled: false, tasks: [], updatedAt: 0 });
const clone = <T,>(value: T): T => structuredClone(value);
const newScript = (packageName: string): ScriptDef => ({
  id: `script-${Date.now()}`, name: '新脚本', version: '1.0.0', packageName,
  refWidth: 2560, refHeight: 1440, steps: [], updatedAt: 0,
});
const stepKinds = [
  ['tap', '点击坐标'], ['tapTemplate', '识别模板并点击'], ['waitFor', '等待模板'], ['swipe', '滑动'],
  ['longPress', '长按'], ['key', '按键'], ['text', '输入文本'], ['sleep', '等待'],
  ['launchApp', '启动游戏'], ['stopApp', '停止游戏'], ['screenshot', '截图'], ['log', '记录日志'],
] as const;
type SimpleKind = typeof stepKinds[number][0];
function makeStep(kind: SimpleKind): ScriptStep {
  const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
  switch (kind) {
    case 'tap': return { id, kind, at: { x: 1280, y: 720 } };
    case 'tapTemplate': return { id, kind, templateId: '', waitMs: 3000 };
    case 'waitFor': return { id, kind, cond: { kind: 'template', templateId: '' }, waitMs: 3000 };
    case 'swipe': return { id, kind, from: { x: 1000, y: 720 }, to: { x: 1500, y: 720 }, durationMs: 300 };
    case 'longPress': return { id, kind, at: { x: 1280, y: 720 }, durationMs: 1000 };
    case 'key': return { id, kind, key: 'BACK' };
    case 'text': return { id, kind, text: '' };
    case 'sleep': return { id, kind, ms: 1000 };
    case 'launchApp': return { id, kind, cold: false };
    case 'stopApp': return { id, kind };
    case 'screenshot': return { id, kind, label: 'checkpoint' };
    case 'log': return { id, kind, level: 'info', message: '' };
  }
}
const triggerLabel = (trigger: TaskTrigger): string => {
  if (trigger.kind === 'manual') return '手动';
  if (trigger.kind === 'daily') return `每天 ${trigger.at.join('、')}`;
  return `每 ${trigger.everyMinutes} 分钟${trigger.window ? ` · ${trigger.window.from}–${trigger.window.to}` : ''}`;
};
const fmt = (at: number | null): string => at === null ? '—' : new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

interface PlanPanelProps {
  gameId: string;
  index: number | null;
  visible?: boolean;
  onCreateTemplate?(request: TemplateInsertRequest): void;
  templateResult?: TemplateInsertResult | null;
  onTemplateResultHandled?(requestId: string): void;
}

export function PlanPanel({ gameId, index, visible = true, onCreateTemplate, templateResult, onTemplateResultHandled }: PlanPanelProps) {
  const toast = useToast();
  const [tab, setTab] = useState<'plans' | 'scripts'>('plans');
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [accountId, setAccountId] = useState('');
  const [plan, setPlan] = useState<AccountPlan | null>(null);
  const [scriptId, setScriptId] = useState('');
  const [script, setScript] = useState<ScriptDef | null>(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState('');
  const [newKind, setNewKind] = useState<SimpleKind>('tap');
  const [captureKind, setCaptureKind] = useState<'tapTemplate' | 'waitAppear' | 'waitDisappear'>('tapTemplate');
  const [issues, setIssues] = useState<ScriptIssue[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [planDirty, setPlanDirty] = useState(false);
  const [configDraft, setConfigDraft] = useState<PlanConfig | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [packageName, setPackageName] = useState('');
  const [legacyPlanFile, setLegacyPlanFile] = useState<unknown>(null);
  const [legacyAccountId, setLegacyAccountId] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [legacyScriptMap, setLegacyScriptMap] = useState<Record<string, string>>({});
  const [invalidSteps, setInvalidSteps] = useState<Record<string, boolean>>({});
  const [templateSets, setTemplateSets] = useState<TemplateSet[]>([]);
  const [activeTemplateSet, setActiveTemplateSet] = useState<TemplateSet | null>(null);
  const handledTemplateResult = useRef<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void Promise.all([avdm.automationTemplateSets(gameId), index === null ? Promise.resolve(null) : avdm.automationTemplateSet(gameId, index)])
      .then(([sets, current]) => { if (alive) { setTemplateSets(sets); setActiveTemplateSet(current); } })
      .catch((cause) => { if (alive) setError(errMsg(cause)); });
    return () => { alive = false; };
  }, [gameId, index, visible, templateResult?.id]);

  const refresh = useCallback(async () => {
    try {
      const [state, nextAccounts, nextScripts, games] = await Promise.all([
        api.planOverview(gameId), avdm.accountList(gameId), api.scriptList(gameId), avdm.automationGames(),
      ]);
      setOverview(state);
      setAccounts(nextAccounts);
      setScripts(nextScripts);
      setPackageName(games.find((game) => game.id === gameId)?.packageName ?? '');
      setAccountId((current) => current && nextAccounts.some((a) => a.id === current)
        ? current : nextAccounts.find((a) => a.binding?.index === index)?.id ?? nextAccounts[0]?.id ?? '');
      setError('');
    } catch (cause) { setError(errMsg(cause)); }
  }, [gameId, index]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(), 5_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (planDirty) return;
    const found = overview?.plans.find((one) => one.accountId === accountId);
    setPlan(found ? clone(found) : accountId ? emptyPlan(accountId) : null);
  }, [accountId, overview?.plans, planDirty]);
  useEffect(() => { if (!configDirty && overview) setConfigDraft(clone(overview.config)); }, [overview?.config, configDirty]);
  useEffect(() => {
    if (!scriptId) return;
    setInvalidSteps({});
    let active = true;
    void api.scriptGet(gameId, scriptId).then((value) => {
      if (!active) return;
      setScript(value); setJson(JSON.stringify(value, null, 2)); setIssues([]); setJsonMode(false);
    }).catch((cause) => { if (active) setError(errMsg(cause)); });
    return () => { active = false; };
  }, [gameId, scriptId]);

  const selectedAccount = accounts.find((a) => a.id === accountId);
  const selectedRuns = useMemo(() => (overview?.runs ?? []).filter((run) => !accountId || run.accountId === accountId).slice(0, 20), [overview, accountId]);
  const scriptName = (id: string): string => scripts.find((item) => item.id === id)?.name ?? id;
  const updateTask = (id: string, patch: Partial<PlanTask>): void => {
    setPlanDirty(true);
    setPlan((current) => current ? { ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch } : task) } : null);
  };
  const updateScript = (next: ScriptDef): void => { setScript(next); setJson(JSON.stringify(next, null, 2)); setIssues([]); };
  useEffect(() => {
    if (!templateResult || handledTemplateResult.current === templateResult.id) return;
    handledTemplateResult.current = templateResult.id;
    const next = templateResult.gameId === gameId && templateResult.index === index && script
      ? insertSavedTemplate(script, templateResult) : null;
    if (next) {
      updateScript(next);
      setTab('scripts');
      toast.push({ kind: 'success', title: '模板已插入脚本步骤', detail: templateResult.templateName });
    } else toast.error('模板已保存，但未插入脚本', '脚本、步骤或模板集已变化。请在对应步骤中手动选择该模板。');
    onTemplateResultHandled?.(templateResult.id);
  }, [templateResult, gameId, index, script, onTemplateResultHandled, toast]);
  const templateSetMismatch = Boolean(script?.templateSetId && activeTemplateSet?.id !== script.templateSetId);
  const availableTemplateSets = activeTemplateSet && !templateSets.some((set) => set.id === activeTemplateSet.id)
    ? [activeTemplateSet, ...templateSets] : templateSets;
  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(label);
    try { await fn(); await refresh(); toast.push({ kind: 'success', title: `${label}已完成` }); }
    catch (cause) { toast.error(`${label}失败`, errMsg(cause)); }
    finally { setBusy(''); }
  };
  const savePlan = (): void => { if (plan) void act('保存计划', async () => { await api.planSave(gameId, plan); setPlanDirty(false); }); };
  const saveScript = (): void => {
    void act('保存脚本', async () => {
      const next = jsonMode ? JSON.parse(json) as ScriptDef : script;
      if (!next) throw new Error('请先创建或选择脚本');
      if (!jsonMode && next.steps.some((step) => invalidSteps[step.id])) throw new Error('有步骤 JSON 尚未写完，请先修正红色输入框');
      const results = await api.scriptValidate(gameId, next);
      setIssues(results);
      if (results.some((issue) => issue.level === 'error')) throw new Error('脚本校验未通过，请查看下方问题');
      const saved = await api.scriptSave(gameId, next);
      setScriptId(saved.id);
      setJsonMode(false);
    });
  };
  const importScriptFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length || !packageName) return;
    await act('导入旧脚本', async () => {
      const warnings: string[] = [];
      const mapping: Record<string, string> = {};
      const used = new Set(scripts.map((item) => item.id));
      for (const file of Array.from(files)) {
        const raw = JSON.parse(await file.text()) as unknown;
        const converted = convertLegacyScript(raw, packageName);
        const oldId = converted.script.id;
        if (used.has(oldId)) converted.script.id = `${oldId}-import-${crypto.randomUUID().slice(0, 6)}`;
        const issues = await api.scriptValidate(gameId, converted.script);
        const errors = issues.filter((issue) => issue.level === 'error');
        if (errors.length) throw new Error(`${file.name}：${errors.map((issue) => issue.message).join('；')}`);
        const saved = await api.scriptSave(gameId, converted.script);
        mapping[oldId] = saved.id;
        used.add(saved.id);
        warnings.push(...converted.warnings.map((item) => `${file.name}：${item}`));
      }
      setLegacyScriptMap((current) => ({ ...current, ...mapping }));
      setImportMessage(`已导入 ${Object.keys(mapping).length} 个脚本。${warnings.join(' ')}`);
    });
  };
  const loadLegacyPlanFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      const choices = legacyPlanChoices(data);
      setLegacyPlanFile(data);
      setLegacyAccountId(choices[0]?.accountId ?? '');
      setImportMessage(`旧计划含 ${choices.length} 个账号。选择要映射的旧账号，再导入到当前账号。`);
    } catch (cause) { toast.error('无法读取旧计划', errMsg(cause)); }
  };
  const importLegacyPlan = (): void => {
    if (!legacyPlanFile || !legacyAccountId || !accountId) return;
    void act('导入旧计划', async () => {
      const converted = convertLegacyAccountPlan(legacyPlanFile, legacyAccountId, accountId);
      const next = { ...converted.plan, tasks: converted.plan.tasks.map((task) => ({ ...task, scriptId: legacyScriptMap[task.scriptId] ?? task.scriptId })) };
      const available = new Set(scripts.map((item) => item.id));
      const missing = next.tasks.filter((task) => !available.has(task.scriptId));
      if (missing.length) throw new Error(`请先导入这些脚本：${[...new Set(missing.map((task) => task.scriptId))].join('、')}`);
      await api.planSave(gameId, next);
      await api.planSaveConfig(gameId, convertLegacyConfig(legacyPlanFile));
      setPlanDirty(false);
      setConfigDirty(false);
      setImportMessage(converted.warnings.join(' '));
    });
  };

  return <section className="plan-panel" aria-label="脚本与任务计划">
    <header className="plan-heading"><div><span>WORKFLOWS</span><h2>脚本与任务计划</h2><p>每个账号绑定一个实例。计划按北京时间触发，实例内串行执行。</p></div><button className="btn xs" onClick={() => void refresh()}>刷新</button></header>
    <div className="plan-safety">脚本和自动采集都操作同一实例。启用脚本计划前，请先关闭该实例的自动采集调度；系统会在运行前再次检查并取得实例锁。</div>
    <nav className="plan-tabs"><button className={tab === 'plans' ? 'active' : ''} onClick={() => setTab('plans')}>任务计划</button><button className={tab === 'scripts' ? 'active' : ''} onClick={() => setTab('scripts')}>脚本库</button></nav>
    {error && <p className="plan-error" role="alert">{error}</p>}
    {tab === 'plans' && <>
      <div className="plan-toolbar"><label>账号<select value={accountId} onChange={(e) => { setPlanDirty(false); setAccountId(e.target.value); }}><option value="">选择账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.binding ? `#${account.binding.index}` : '未绑定'}</option>)}</select></label><label className="plan-switch"><input type="checkbox" checked={overview?.config.enabled ?? false} onChange={(e) => void act('更新计划总开关', async () => { await api.planSaveConfig(gameId, { enabled: e.target.checked }); })} disabled={!overview || !!busy} />自动计划总开关</label></div>
      {configDraft && <details className="plan-settings"><summary>调度设置</summary><div className="plan-task-fields"><label>错过后补跑（分钟）<input type="number" min={0} max={720} value={configDraft.catchUpMs / 60_000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, catchUpMs: Number(e.target.value) * 60_000 }); }} /></label><label>排队等待上限（分钟）<input type="number" min={1} max={720} value={configDraft.queueWaitMs / 60_000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, queueWaitMs: Number(e.target.value) * 60_000 }); }} /></label><label>失败重试次数<input type="number" min={0} max={5} value={configDraft.retry} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, retry: Number(e.target.value) }); }} /></label><label>重试等待（秒）<input type="number" min={0} max={1800} value={configDraft.retryDelayMs / 1000} onChange={(e) => { setConfigDirty(true); setConfigDraft({ ...configDraft, retryDelayMs: Number(e.target.value) * 1000 }); }} /></label></div><div className="plan-settings-foot"><span>失败重试会从脚本首步重新执行；涉及点击、提交等动作时建议保持 0 次。</span><button className="btn sm" disabled={!configDirty || !!busy} onClick={() => void act('保存调度设置', async () => { await api.planSaveConfig(gameId, configDraft); setConfigDirty(false); })}>保存设置</button></div></details>}
      <div className="plan-import"><label className="btn xs">导入旧 plans.json<input type="file" accept=".json,application/json" onChange={(e) => void loadLegacyPlanFile(e.currentTarget.files?.[0])} /></label>{Boolean(legacyPlanFile) && <><select aria-label="旧账号计划" value={legacyAccountId} onChange={(e) => setLegacyAccountId(e.target.value)}>{legacyPlanChoices(legacyPlanFile).map((choice) => <option key={choice.accountId} value={choice.accountId}>{choice.accountId} · {choice.tasks} 项</option>)}</select><button className="btn xs" onClick={importLegacyPlan} disabled={!accountId || !!busy}>导入到当前账号</button></>}</div>
      {importMessage && <p className="plan-import-message" role="status">{importMessage}</p>}
      {!accounts.length && <div className="plan-empty">还没有账号。先在“账号”页面创建并绑定实例，再配置脚本计划。</div>}
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
    {tab === 'scripts' && <><div className="plan-import"><label className="btn xs">导入旧脚本 JSON<input type="file" accept=".json,application/json" multiple onChange={(e) => void importScriptFiles(e.currentTarget.files)} /></label><span>可多选旧 scripts 目录中的 JSON；导入后逐条校验，不会自动执行。</span></div>{importMessage && <p className="plan-import-message" role="status">{importMessage}</p>}<div className="plan-script-layout"><aside><div className="plan-script-side-head"><strong>脚本库</strong><button className="btn xs" onClick={() => { const next = newScript(packageName); setScriptId(''); updateScript(next); setJsonMode(false); }} disabled={!packageName}>新建</button></div>{scripts.map((item) => <button key={item.id} className={scriptId === item.id ? 'selected' : ''} onClick={() => { setScriptId(item.id); setDeleteConfirm(false); }}><strong>{item.name}</strong><small>{item.id} · {item.stepCount} 步</small></button>)}{!scripts.length && <p>暂无脚本</p>}</aside><div className="plan-script-editor">
      {!script && <div className="plan-empty">选择脚本或新建一个。脚本保存为纯数据，可复用到同一游戏的其他账号。</div>}
      {script && <><div className="plan-script-editor-head"><strong>编辑脚本</strong><label className="plan-switch"><input type="checkbox" checked={jsonMode} onChange={(e) => { setJsonMode(e.target.checked); setJson(JSON.stringify(script, null, 2)); }} />高级 JSON</label></div>
        {jsonMode ? <textarea className="plan-json" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} aria-label="脚本 JSON" /> : <>
          <div className="plan-script-fields"><label>脚本 ID<input value={script.id} onChange={(e) => updateScript({ ...script, id: e.target.value })} /></label><label>名称<input value={script.name} onChange={(e) => updateScript({ ...script, name: e.target.value })} /></label><label>版本<input value={script.version} onChange={(e) => updateScript({ ...script, version: e.target.value })} /></label><label>参考宽度<input type="number" value={script.refWidth} onChange={(e) => updateScript({ ...script, refWidth: Number(e.target.value) })} /></label><label>参考高度<input type="number" value={script.refHeight} onChange={(e) => updateScript({ ...script, refHeight: Number(e.target.value) })} /></label><label>模板集<select value={script.templateSetId ?? ''} onChange={(e) => updateScript({ ...script, templateSetId: e.target.value || undefined })}><option value="">暂不绑定</option>{script.templateSetId && !availableTemplateSets.some((set) => set.id === script.templateSetId) && <option value={script.templateSetId}>{script.templateSetId} · 未在本机找到</option>}{availableTemplateSets.map((set) => <option key={set.id} value={set.id}>{set.name}{activeTemplateSet?.id === set.id ? ' · 当前实例' : ''}</option>)}</select></label></div>
          <p className={`plan-template-context ${templateSetMismatch ? 'is-warning' : ''}`}>{activeTemplateSet ? `当前实例使用「${activeTemplateSet.name}」；新截图将保存到此模板集。` : '当前实例还没有模板集；截取时可在模板页新建。'}{templateSetMismatch && ' 脚本绑定了另一模板集，请先在模板页切换实例。'}</p>
          <label className="plan-note">说明<input value={script.description ?? ''} onChange={(e) => updateScript({ ...script, description: e.target.value })} /></label>
          <div className="plan-steps-heading"><h3>步骤 · {script.steps.length}</h3><div><select aria-label="截取模板后生成的步骤" value={captureKind} onChange={(e) => setCaptureKind(e.target.value as typeof captureKind)}><option value="tapTemplate">识别后点击</option><option value="waitAppear">等待出现</option><option value="waitDisappear">等待消失</option></select><button className="btn xs" disabled={index === null || !onCreateTemplate || templateSetMismatch} onClick={() => {
            if (index === null || !onCreateTemplate) return;
            const stepKind = captureKind === 'tapTemplate' ? 'tapTemplate' : 'waitFor';
            onCreateTemplate({ id: crypto.randomUUID(), gameId, index, scriptId: script.id,
              stepId: `${stepKind}-${crypto.randomUUID().slice(0, 8)}`, stepKind,
              createStep: true, waitForPresent: captureKind !== 'waitDisappear', expectedTemplateSetId: script.templateSetId });
          }}>从画面截取并添加</button><select aria-label="添加步骤类型" value={newKind} onChange={(e) => setNewKind(e.target.value as SimpleKind)}>{stepKinds.map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select><button className="btn xs" onClick={() => updateScript({ ...script, steps: [...script.steps, makeStep(newKind)] })}>添加步骤</button></div></div>
          {!script.steps.length && <div className="plan-empty">脚本尚无步骤。选择一种动作添加，或切换高级 JSON 编写分支、循环与条件。</div>}
          {script.steps.map((step, stepIndex) => <ScriptStepBlock key={`${script.id}-${step.id}`} step={step} ordinal={stepIndex + 1} total={script.steps.length} templates={activeTemplateSet?.templates ?? []} canCreateTemplate={index !== null && Boolean(onCreateTemplate)} templateSetMismatch={templateSetMismatch}
            onChange={(next) => { const steps = [...script.steps]; steps[stepIndex] = next; updateScript({ ...script, steps }); }}
            onValidity={(valid) => setInvalidSteps((current) => ({ ...current, [step.id]: !valid }))}
            onCreateTemplate={() => { if (index === null || !onCreateTemplate) return; onCreateTemplate({ id: crypto.randomUUID(), gameId, index, scriptId: script.id, stepId: step.id, stepKind: step.kind as 'tapTemplate' | 'waitFor', expectedTemplateSetId: script.templateSetId }); }}
            onMove={(delta) => { const steps = [...script.steps]; [steps[stepIndex], steps[stepIndex + delta]] = [steps[stepIndex + delta]!, steps[stepIndex]!]; updateScript({ ...script, steps }); }}
            onDuplicate={() => { const copy = { ...clone(step), id: `${step.kind}-${crypto.randomUUID().slice(0, 8)}` }; const steps = [...script.steps]; steps.splice(stepIndex + 1, 0, copy); updateScript({ ...script, steps }); }}
            onDelete={() => updateScript({ ...script, steps: script.steps.filter((one) => one.id !== step.id) })} />)}
        </>}
        {!!issues.length && <div className="plan-issues" role="status">{issues.map((issue, i) => <p key={i} className={issue.level}>{issue.stepId ? `${issue.stepId}：` : ''}{issue.message}</p>)}</div>}
        <div className="plan-script-actions"><button className="btn sm" onClick={() => void act('校验脚本', async () => { const value = jsonMode ? JSON.parse(json) as ScriptDef : script; setIssues(await api.scriptValidate(gameId, value)); })} disabled={!!busy}>校验</button><button className="btn primary sm" onClick={saveScript} disabled={!!busy}>保存脚本</button>{scriptId && <>{deleteConfirm ? <><span>确定删除？</span><button className="btn sm danger" onClick={() => void act('删除脚本', async () => { await api.scriptDelete(gameId, scriptId); setScriptId(''); setScript(null); setDeleteConfirm(false); })}>确定</button><button className="btn sm" onClick={() => setDeleteConfirm(false)}>取消</button></> : <button className="btn sm" onClick={() => setDeleteConfirm(true)}>删除</button>}</>}</div>
      </>}
    </div></div></>}
  </section>;
}
