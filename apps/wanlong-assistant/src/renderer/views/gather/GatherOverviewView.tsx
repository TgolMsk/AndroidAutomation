import { useEffect, useRef, useState } from 'react';
import type { AutomationGameSummary, AutomationProbeReport, AutomationSettings, SchedulerServiceStatus } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner, StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { RUN_LABEL, isRunActive, useActivity } from '../../state/activity';
import { useNavigation } from '../../state/navigation';
import { useSelection, useSelectionLock } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import type { ViewProps } from '../types';
import { GATHER_RESOURCES, wanlongConfig, wanlongDraftOf, type WanlongDraft } from './gather-config';
import './GatherOverviewView.css';

type BusyAction = 'save' | 'probe' | 'run' | 'stop' | null;

const BUSY_LOCK: Record<Exclude<BusyAction, null>, string> = {
  save: '正在保存采集配置，完成后再切换实例',
  probe: '正在探测画面，完成后再切换实例',
  run: '正在启动采集，完成后再切换实例',
  stop: '正在停止采集，完成后再切换实例',
};

export function probeReady(report: AutomationProbeReport | null, game: AutomationGameSummary | undefined): boolean {
  return Boolean(
    report && game && report.gameId === game.id && report.foregroundPackage === game.packageName &&
    report.deviceWidth > 0 && report.deviceHeight > 0 && report.launchReady,
  );
}

/**
 * 采集总览: per-instance gather config, read-only probe, one manual round, auto-resume and recent runs. Kept alive
 * by the shell, so the unsaved config draft and the confirmed probe survive a visit to another page; only a
 * template change for this instance (or switching instance) resets the probe, as before the page split.
 */
export function GatherOverviewView(_props: ViewProps) {
  const toast = useToast();
  const { navigate } = useNavigation();
  const { runs, upsertRun, refreshRuns, schedules, schedulesLoading, schedulesError, refreshSchedules, upsertSchedule, holdSchedules } = useActivity();
  const { game, index, selectedTarget, selectedInstance, selectedInstanceReady, instancesLoaded, instancesError } = useSelection();
  const gameId = game?.id ?? '';
  const [scheduleTarget, setScheduleTarget] = useState<boolean | null>(null);
  const [taskId, setTaskId] = useState('');
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const [draft, setDraft] = useState<WanlongDraft | null>(null);
  const [savedDraft, setSavedDraft] = useState<WanlongDraft | null>(null);
  const [probe, setProbe] = useState<AutomationProbeReport | null>(null);
  const [probeError, setProbeError] = useState<string>();
  const [probeConfirmed, setProbeConfirmed] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const { templateChange } = useTemplateFlow();
  const seenTemplateChange = useRef(templateChange?.seq ?? 0);
  useSelectionLock(busy ? BUSY_LOCK[busy] : scheduleTarget !== null ? '正在切换自动续跑，完成后再切换实例' : null);
  // Another assistant process may own the scheduler (or its lease is still expiring after a crash): say so.
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerServiceStatus | null>(null);
  useEffect(() => {
    if (gameId !== 'wanlong') { setSchedulerStatus(null); return; }
    let live = true;
    avdm.schedulerStatus(gameId).then((status) => { if (live) setSchedulerStatus(status); }, () => undefined);
    return () => { live = false; };
  }, [gameId]);
  useAvdmEvent('scheduler-status', (status) => { if (status.gameId === gameId) setSchedulerStatus(status); });

  useEffect(() => {
    setTaskId((current) => (game?.tasks.some((task) => task.id === current) ? current : game?.tasks[0]?.id ?? ''));
  }, [game]);

  useEffect(() => {
    setSettings(null);
    setDraft(null);
    setSavedDraft(null);
    setProbe(null);
    setProbeError(undefined);
    setProbeConfirmed(false);
    setSettingsError(undefined);
    if (!gameId || index === null) return;
    let active = true;
    setSettingsLoading(true);
    avdm.getAutomationSettings(gameId, index).then((value) => {
      if (!active) return;
      setSettings(value);
      const loadedDraft = wanlongDraftOf(value);
      setDraft(loadedDraft);
      setSavedDraft(loadedDraft);
    }).catch((error: unknown) => {
      if (active) setSettingsError(errMsg(error));
    }).finally(() => {
      if (active) setSettingsLoading(false);
    });
    return () => { active = false; };
  }, [gameId, index]);

  useEffect(() => {
    if (!templateChange || templateChange.seq === seenTemplateChange.current) return;
    seenTemplateChange.current = templateChange.seq;
    if (templateChange.gameId !== gameId || templateChange.index !== index) return;
    setSettings((current) => current ? { ...current, templateDir: templateChange.directory } : current);
    setProbe(null);
    setProbeError(undefined);
    setProbeConfirmed(false);
  }, [templateChange, gameId, index]);

  if (!game) return null;

  const selectedRuns = runs.filter((run) => run.gameId === gameId && run.index === index);
  const activeInstanceRun = runs.find((run) => run.index === index && isRunActive(run));
  const schedule = schedules.find((item) => item.gameId === gameId && item.index === index);
  const scheduleEnabled = schedule?.enabled === true;
  const scheduleBusy = scheduleTarget !== null;
  const offersAutoResume = game.id === 'wanlong' && game.tasks.some((task) => task.id === 'gather-once');
  const draftDirty = Boolean(draft && savedDraft && JSON.stringify(draft) !== JSON.stringify(savedDraft));
  const launchReady = probeReady(probe, game);
  const canProbe = Boolean(selectedInstanceReady && settings?.templateDir && !busy && !settingsLoading && !activeInstanceRun);
  const launchConditionsMet = Boolean(
    selectedInstanceReady && settings?.templateDir && launchReady && probeConfirmed && !busy && !activeInstanceRun && !draftDirty &&
    (game.id !== 'wanlong' || savedDraft?.enabled),
  );
  const canRun = Boolean(taskId && launchConditionsMet && !scheduleEnabled);
  const canEnableSchedule = Boolean(offersAutoResume && launchConditionsMet && !schedulesLoading && !schedulesError);

  async function saveConfig(): Promise<void> {
    if (!game || index === null || !settings || !draft || !draftDirty || busy) return;
    setBusy('save');
    try {
      const saved = await avdm.saveAutomationSettings(game.id, index, { config: wanlongConfig(settings, draft) });
      setSettings(saved);
      const normalized = wanlongDraftOf(saved);
      setDraft(normalized);
      setSavedDraft(normalized);
      setProbe(null);
      setProbeError(undefined);
      setProbeConfirmed(false);
      toast.push({ kind: 'success', title: '采集配置已保存' });
    } catch (error) {
      toast.error('无法保存采集配置', errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function runProbe(): Promise<void> {
    if (!game || index === null || !canProbe) return;
    setBusy('probe');
    setProbe(null);
    setProbeError(undefined);
    setProbeConfirmed(false);
    try {
      const report = await avdm.probeAutomation(game.id, index);
      setProbe(report);
      if (probeReady(report, game)) {
        toast.push({ kind: 'info', title: '画面通过启动检查', detail: report.launchReason });
      }
    } catch (error) {
      setProbeError(errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function startTask(): Promise<void> {
    if (!game || index === null || !taskId || !canRun) return;
    setBusy('run');
    try {
      const run = await avdm.runAutomation(game.id, taskId, index);
      upsertRun(run);
      toast.push({ kind: 'success', title: '自动化任务已启动', detail: `${game.name} · #${index}` });
    } catch (error) {
      toast.error('无法启动任务', errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function stopTask(runId: string): Promise<void> {
    if (busy) return;
    setBusy('stop');
    try {
      await avdm.stopAutomation(runId);
      await refreshRuns();
    } catch (error) {
      toast.error('无法停止任务', errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggleSchedule(): Promise<void> {
    if (!game || index === null || scheduleBusy) return;
    const enabling = !scheduleEnabled;
    if (enabling && !canEnableSchedule) return;
    holdSchedules(true);
    setScheduleTarget(enabling);
    if (!enabling && schedule) {
      // Disabling remains available even if the probe or configuration is no longer valid.
      upsertSchedule({ ...schedule, enabled: false, nextWakeAt: null });
    }
    try {
      const updated = await avdm.setAutomationSchedule(game.id, index, enabling);
      upsertSchedule(updated);
      void refreshRuns();
      toast.push({ kind: 'success', title: enabling ? '自动续跑已启用' : '自动续跑已关闭' });
    } catch (error) {
      if (!enabling && schedule) upsertSchedule(schedule);
      toast.error(enabling ? '无法启用自动续跑' : '无法关闭自动续跑', errMsg(error));
    } finally {
      holdSchedules(false);
      setScheduleTarget(null);
      void refreshSchedules();
    }
  }

  const runHint = !selectedInstanceReady ? selectedTarget && !selectedInstance ? '实例已移除；可在下方关闭自动续跑。' : '先启动已选实例；自动续跑仍可在下方关闭。'
    : !settings?.templateDir ? '先选择模板目录。'
      : draftDirty ? '先保存采集配置。'
        : game.id === 'wanlong' && !savedDraft?.enabled ? '先启用并保存自动采集。'
          : !launchReady ? probe?.launchReason ?? '先探测当前画面并通过启动检查。'
            : !probeConfirmed ? '核对探针结果后确认。'
              : scheduleEnabled ? '自动续跑已启用；关闭后可手动采集一轮。'
                : activeInstanceRun ? '当前实例已有任务运行。' : '探针结果已核对，可以采集一轮。';

  return (
    <>
      <div className="automation-game-heading">
        <div><h2>{game.name}</h2><p className="mono">{game.packageName}</p></div>
        <span>v{game.version}</span>
      </div>

      <section className="automation-section" aria-labelledby="automation-target-title">
        <div className="automation-section-title"><h3 id="automation-target-title">当前实例</h3><p>在顶部切换实例；账号、模板与任务按实例分别保存。</p></div>
        <div className="automation-instance-state">
          {index !== null && <strong className="mono">#{index}</strong>}
          {selectedInstance ? <><span>{selectedInstance.record.name}</span><StatusBadge status={selectedInstance.status} />{selectedInstanceReady ? <span className="mono">{selectedInstance.ports.serial}</span> : <span className="dim">启动实例后可探测与采集</span>}</> : <span className="dim">{selectedTarget ? '实例已移除，可在下方关闭自动续跑' : '请先创建一个模拟器实例'}</span>}
        </div>
        {instancesError && <p className="automation-inline-error" role="alert">实例列表加载失败：{instancesError}</p>}
        {!instancesLoaded && <p className="automation-muted">正在读取实例状态…</p>}
        {settingsError && <p className="automation-inline-error" role="alert">配置加载失败：{settingsError}</p>}
        <div className="automation-template-row">
          <div className="automation-template-copy"><span>当前模板集</span><strong className={settings?.templateDir ? 'mono' : ''}>{settings?.templateDir || '尚未配置'}</strong></div>
          <button className="btn" onClick={() => navigate('templates')} disabled={index === null || settingsLoading}><Icon name="grid" />管理模板</button>
        </div>
        {!settings?.templateDir && <div className="automation-guidance"><Icon name="info" size={16} /><span>先在「脚本与模板 → 模板库」创建或导入模板集，再执行画面探测。</span></div>}
      </section>

      {game.id === 'wanlong' && draft && <section className="automation-section" aria-labelledby="automation-config-title">
        <div className="automation-section-title"><h3 id="automation-config-title">万龙觉醒 · 采集配置</h3><p>按当前实例保存；修改后需重新校准。</p></div>
        <label className="automation-switch-row"><span><strong>启用自动采集</strong><small>关闭时任务不可启动</small></span><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} disabled={Boolean(busy)} /></label>
        <div className="automation-resource-head">采集资源</div>
        <div className="automation-resource-list">
          {GATHER_RESOURCES.map((item) => <label key={item.type} className="automation-resource"><input type="checkbox" checked={draft.resources[item.type]} onChange={(event) => setDraft({ ...draft, resources: { ...draft.resources, [item.type]: event.target.checked } })} disabled={Boolean(busy)} /><span>{item.label}</span></label>)}
        </div>
        <div className="automation-config-actions"><span>{draftDirty ? '配置尚未保存' : '配置已保存'}</span><button className="btn" onClick={() => void saveConfig()} disabled={!draftDirty || Boolean(busy)}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}保存采集配置</button></div>
      </section>}

      <section className="automation-section" aria-labelledby="automation-probe-title">
        <div className="automation-section-title"><h3 id="automation-probe-title">画面探测</h3><p>只读取前台应用与截图，不向设备发送点击。</p></div>
        <div className="automation-probe-toolbar"><button className="btn" onClick={() => void runProbe()} disabled={!canProbe}>{busy === 'probe' ? <Spinner size={14} /> : <Icon name="search" />}执行只读探测</button><span>核对前台包名和每个模板的分数与阈值。</span></div>
        {probeError && <div className="automation-inline-error" role="alert">探测失败：{probeError}</div>}
        {probe && <div className="automation-probe-report" aria-live="polite">
          <div className={`automation-probe-verdict ${launchReady ? 'is-detected' : ''}`}><Icon name={launchReady ? 'check' : 'alert'} size={17} /><strong>{launchReady ? '可启动采集' : '暂不能启动'}</strong><span>{probe.matches.filter((match) => match.found).length} / {probe.matches.length} 个模板命中</span></div>
          <p className={`automation-probe-reason ${launchReady ? 'is-ready' : ''}`}>{probe.launchReason}</p>
          <dl className="automation-probe-facts"><div><dt>前台应用</dt><dd className={probe.foregroundPackage === game.packageName ? 'mono' : 'mono is-warning'}>{probe.foregroundPackage ?? '未检测到'}{probe.foregroundPackage !== game.packageName && <small>期望 {game.packageName}</small>}</dd></div><div><dt>画面尺寸</dt><dd className="mono">{probe.deviceWidth} × {probe.deviceHeight}</dd></div><div><dt>截图时间（北京）</dt><dd>{beijingTime(probe.capturedAt, 'clock')}</dd></div></dl>
          {probe.matches.length > 0 ? <div className="automation-match-scroll"><table className="automation-match-table"><thead><tr><th>模板</th><th>结果</th><th>匹配分数 / 阈值</th><th>位置</th></tr></thead><tbody>{probe.matches.map((match) => <tr key={match.templateId}><td className="mono" title={match.templateId}>{match.templateId}</td><td><span className={`automation-match-state ${match.found ? 'is-found' : ''}`}>{match.found ? '命中' : '未命中'}</span></td><td><div className="automation-score"><span>{match.score.toFixed(3)} / {match.threshold.toFixed(3)}</span><span className="automation-score-track"><span style={{ width: `${Math.max(0, Math.min(100, match.score * 100))}%` }} /></span></div>{match.reason && <small>{match.reason}</small>}</td><td className="mono">{match.found ? `${match.x}, ${match.y} · ${match.w}×${match.h}` : '—'}</td></tr>)}</tbody></table></div> : <p className="automation-muted">此游戏包尚无探测模板，无法校准启动条件。</p>}
          {Object.keys(probe.timingsMs).length > 0 && <p className="automation-probe-timing">{Object.entries(probe.timingsMs).map(([name, ms]) => `${name} ${Math.round(ms)} ms`).join(' · ')}</p>}
        </div>}
      </section>

      <section className="automation-section automation-run-section" aria-labelledby="automation-run-title">
        <div className="automation-section-title"><h3 id="automation-run-title">运行任务</h3><p>同一实例一次只运行一个自动化任务。</p></div>
        {game.tasks.length === 0 ? <div className="automation-pending"><Icon name="info" size={17} /><span><strong>只读模板校准已接入；采集运行待完成迁移。</strong><small>现在可以选择本地模板并查看前台包名、画面尺寸与匹配分数。任务入口将在采集流程完成验证后开放。</small></span></div> : <>
          <div className="automation-run-controls"><label className="automation-field"><span>任务</span><select value={taskId} onChange={(event) => setTaskId(event.target.value)} disabled={Boolean(busy)}>{game.tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label><button className="btn primary" onClick={() => void startTask()} disabled={!canRun}>{busy === 'run' ? <Spinner size={14} /> : <Icon name="play" />}采集一轮</button>{activeInstanceRun && <button className="btn danger-ghost" onClick={() => void stopTask(activeInstanceRun.runId)} disabled={Boolean(busy) || activeInstanceRun.status === 'stopping'}>{busy === 'stop' ? <Spinner size={14} /> : <Icon name="stop" />}停止本轮</button>}</div>
          <label className="automation-probe-confirm"><input type="checkbox" checked={probeConfirmed} onChange={(event) => setProbeConfirmed(event.target.checked)} disabled={!launchReady || Boolean(busy)} />我已核对当前前台应用及模板分数</label>
          <p className="automation-run-hint">{runHint}</p>
          {offersAutoResume && <div className={`automation-schedule ${scheduleEnabled ? 'is-enabled' : ''}`}>
            <div className="automation-schedule-heading">
              <span className="automation-schedule-icon"><Icon name="workflow" size={18} /></span>
              <div><strong>自动续跑</strong><p>按每轮采集结果安排下一次运行；关闭时会停止当前自动任务。</p></div>
              <button type="button" role="switch" aria-checked={scheduleEnabled} aria-label="自动续跑" className="automation-schedule-switch" onClick={() => void toggleSchedule()} disabled={scheduleBusy || (!scheduleEnabled && !canEnableSchedule)}>{scheduleBusy ? <Spinner size={14} /> : <span />}</button>
            </div>
            <div className="automation-schedule-stats">
              <div><span>状态</span><strong className={scheduleEnabled ? 'is-on' : ''}>{scheduleTarget === true ? '启用中' : scheduleTarget === false ? '关闭中' : scheduleEnabled ? '已启用' : '未启用'}</strong></div>
              <div><span>下次唤醒（北京）</span><strong>{scheduleEnabled ? beijingTime(schedule?.nextWakeAt) : '—'}</strong></div>
              <div><span>连续失败</span><strong>{schedule?.failureCount ?? 0} 次</strong></div>
            </div>
            {schedulerStatus && !schedulerStatus.owner && <p className="automation-schedule-note is-readonly" role="status">{schedulerStatus.message ?? '另一个万龙助手进程正在管理自动采集调度，本窗口只显示状态。'}</p>}
            {schedulesError && <div className="automation-inline-error" role="alert">调度状态读取失败：{schedulesError}<button className="btn xs" onClick={() => void refreshSchedules()}>重试</button></div>}
            {!scheduleEnabled && !canEnableSchedule && !schedulesLoading && !schedulesError && <p className="automation-schedule-note">启用前需保存配置、通过画面启动检查并确认探针结果。</p>}
          </div>}
        </>}
        <div className="automation-run-history"><h4>最近运行</h4>{selectedRuns.length === 0 ? <p className="automation-muted">这个实例尚无运行记录。</p> : selectedRuns.slice(0, 5).map((run) => <div key={run.runId} className="automation-run-item"><span className={`automation-run-dot is-${run.status}`} /><div><strong>{game.tasks.find((task) => task.id === run.taskId)?.name ?? run.taskId}</strong><small>{run.message || RUN_LABEL[run.status]}{run.nextWakeAt ? ` · 下次唤醒 ${beijingTime(run.nextWakeAt)}` : ''}</small></div><span className="automation-run-meta"><strong>{RUN_LABEL[run.status]}</strong><small>{beijingTime(run.startedAt)}</small></span></div>)}</div>
      </section>
    </>
  );
}
