import { useCallback, useEffect, useRef, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { AutomationGameSummary, AutomationProbeReport, AutomationSettings, SchedulerServiceStatus } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime, isRunning } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { RUN_LABEL, isRunActive, useActivity } from '../../state/activity';
import { useNavigation } from '../../state/navigation';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import { frameResolutionHint } from '../instances/instance-model';
import { MaskedDrawer } from './MaskedDrawer';

/** The probe passed the launch check for this game (foreground package, frame size, one known scene anchor). */
export function probeReady(report: AutomationProbeReport | null, game: Pick<AutomationGameSummary, 'id' | 'packageName'> | undefined): boolean {
  return Boolean(
    report && game && report.gameId === game.id && report.foregroundPackage === game.packageName &&
    report.deviceWidth > 0 && report.deviceHeight > 0 && report.launchReady,
  );
}

/**
 * 采集运行 · #i: the single-instance flows of the former gather page, moved into a drawer opened from the card —
 * the template set, the read-only probe (template scores against thresholds, foreground package), one manual gather
 * round with its stop, and the instance's recent runs. The auto switch itself lives on the card.
 */
export function InstanceRunDrawer({ game, index, instance, autoOn, status, scriptBusy = null, onClose }: {
  game: AutomationGameSummary;
  index: number;
  instance: InstanceState | undefined;
  autoOn: boolean;
  status: SchedulerServiceStatus | null;
  /** A script run holds the instance (plans module, scripts pre-empt gathering): a manual round is refused until it ends. */
  scriptBusy?: string | null;
  onClose(): void;
}) {
  const toast = useToast();
  const { navigate } = useNavigation();
  const { setIndex } = useSelection();
  const { runs, upsertRun, refreshRuns } = useActivity();
  const { templateChange } = useTemplateFlow();
  const seenTemplateChange = useRef(templateChange?.seq ?? 0);
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string>();
  const [taskId, setTaskId] = useState(game.tasks[0]?.id ?? '');
  const [probe, setProbe] = useState<AutomationProbeReport | null>(null);
  const [probeError, setProbeError] = useState<string>();
  const [probeConfirmed, setProbeConfirmed] = useState(false);
  const [busy, setBusy] = useState<'probe' | 'run' | 'stop' | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try { setSettings(await avdm.getAutomationSettings(game.id, index)); setSettingsError(undefined); }
    catch (error) { setSettingsError(errMsg(error)); }
  }, [game.id, index]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!templateChange || templateChange.seq === seenTemplateChange.current) return;
    seenTemplateChange.current = templateChange.seq;
    if (templateChange.gameId !== game.id || templateChange.index !== index) return;
    setSettings((current) => current ? { ...current, templateDir: templateChange.directory } : current);
    setProbe(null);
    setProbeConfirmed(false);
  }, [templateChange, game.id, index]);
  useAvdmEvent('templates-changed', () => { void load(); });

  const ready = Boolean(instance && isRunning(instance));
  const instanceRuns = runs.filter((run) => run.gameId === game.id && run.index === index);
  const activeRun = runs.find((run) => run.index === index && isRunActive(run));
  const launchReady = probeReady(probe, game);
  const frameHint = probe && probe.deviceWidth > 0 ? frameResolutionHint(probe.deviceWidth, probe.deviceHeight) : null;
  const configEnabled = settings?.config['enabled'] === true;
  const canProbe = Boolean(ready && settings?.templateDir && !busy && !activeRun);
  const canRun = Boolean(ready && settings?.templateDir && launchReady && probeConfirmed && !busy && !activeRun && !autoOn && taskId &&
    !scriptBusy && (game.id !== 'wanlong' || configEnabled));
  const hint = !ready ? '先启动这个实例。'
    : !settings?.templateDir ? '先选择模板集。'
      : game.id === 'wanlong' && !configEnabled ? '先在采集配置里打开「启用自动采集」并保存。'
        : !launchReady ? probe?.launchReason ?? '先探测当前画面并通过启动检查。'
          : !probeConfirmed ? '核对探针结果后确认。'
            : autoOn ? '自动调度已开启；关闭后可手动采集一轮。'
              : activeRun ? '这个实例已有任务在运行。'
                : scriptBusy ?? '探针结果已核对，可以采集一轮。';

  async function runProbe(): Promise<void> {
    if (!canProbe) return;
    setBusy('probe');
    setProbe(null);
    setProbeError(undefined);
    setProbeConfirmed(false);
    try {
      const report = await avdm.probeAutomation(game.id, index);
      setProbe(report);
      if (probeReady(report, game)) toast.push({ kind: 'info', title: '画面通过启动检查', detail: report.launchReason });
    } catch (error) {
      setProbeError(errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function start(): Promise<void> {
    if (!canRun) return;
    setBusy('run');
    try {
      upsertRun(await avdm.runAutomation(game.id, taskId, index));
      toast.push({ kind: 'success', title: '自动化任务已启动', detail: `${game.name} · #${index}` });
    } catch (error) {
      toast.error('无法启动任务', errMsg(error));
    } finally {
      setBusy(null);
    }
  }

  async function stop(runId: string): Promise<void> {
    if (busy) return;
    setBusy('stop');
    try { await avdm.stopAutomation(runId); await refreshRuns(); }
    catch (error) { toast.error('无法停止任务', errMsg(error)); }
    finally { setBusy(null); }
  }

  return (
    <MaskedDrawer label={`实例 #${index} 采集运行`} title={`采集运行 · #${index} ${instance?.record.name ?? '实例已删除'}`} width={720}
      busy={busy === 'run'} onClose={onClose}>
      <div className="gather-run">
        {status && !status.owner && <p className="gather-note is-warn" role="status">{status.message ?? '另一个万龙助手进程正在管理自动采集调度，本窗口只显示状态。'}</p>}
        {settingsError && <p className="gather-inline-error" role="alert">配置加载失败：{settingsError}</p>}

        <section className="gather-run-section" aria-labelledby={`gather-run-tpl-${index}`}>
          <h3 id={`gather-run-tpl-${index}`}>模板集</h3>
          <div className="gather-run-template">
            <strong className={settings?.templateDir ? 'mono' : ''}>{settings?.templateDir || '尚未配置'}</strong>
            <button type="button" className="btn sm" onClick={() => { setIndex(index); onClose(); navigate('templates'); }}>
              <Icon name="grid" />管理模板
            </button>
          </div>
          {!settings?.templateDir && <p className="gather-micro">先在「脚本与模板 → 模板库」为这个实例创建或导入模板集，再执行画面探测。</p>}
        </section>

        <section className="gather-run-section" aria-labelledby={`gather-run-probe-${index}`}>
          <h3 id={`gather-run-probe-${index}`}>画面探测</h3>
          <p className="gather-micro">只读取前台应用与截图，不向设备发送点击。</p>
          <button type="button" className="btn sm" onClick={() => void runProbe()} disabled={!canProbe}>
            {busy === 'probe' ? <Spinner size={14} /> : <Icon name="search" />}执行只读探测
          </button>
          {probeError && <p className="gather-inline-error" role="alert">探测失败：{probeError}</p>}
          {probe && (
            <div className="gather-probe" aria-live="polite">
              <div className={`gather-probe-verdict${launchReady ? ' is-ready' : ''}`}>
                <Icon name={launchReady ? 'check' : 'alert'} size={16} />
                <strong>{launchReady ? '可启动采集' : '暂不能启动'}</strong>
                <span>{probe.matches.filter((match) => match.found).length} / {probe.matches.length} 个模板命中</span>
              </div>
              <p className="gather-micro">{probe.launchReason}</p>
              <dl className="gather-probe-facts">
                <div><dt>前台应用</dt><dd className="mono">{probe.foregroundPackage ?? '未检测到'}</dd></div>
                <div><dt>画面尺寸</dt><dd className="mono">{probe.deviceWidth} × {probe.deviceHeight}</dd></div>
                <div><dt>截图时间（北京）</dt><dd>{beijingTime(probe.capturedAt, 'clock')}</dd></div>
              </dl>
              {frameHint && (
                <div className="notice warn" role="status"><Icon name="alert" /><div>{frameHint}</div></div>
              )}
              {probe.matches.length > 0 && (
                <div className="table-wrap"><table className="inst-table gather-probe-table">
                  <thead><tr><th>模板</th><th>结果</th><th>分数 / 阈值</th><th>位置</th></tr></thead>
                  <tbody>{probe.matches.map((match) => (
                    <tr key={match.templateId}>
                      <td className="mono">{match.templateId}</td>
                      <td>{match.found ? '命中' : '未命中'}</td>
                      <td className="mono">{match.score.toFixed(3)} / {match.threshold.toFixed(3)}{match.reason && <small> {match.reason}</small>}</td>
                      <td className="mono">{match.found ? `${match.x}, ${match.y} · ${match.w}×${match.h}` : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <label className="check"><input type="checkbox" checked={probeConfirmed} disabled={!launchReady || Boolean(busy)}
                onChange={(event) => setProbeConfirmed(event.target.checked)} />我已核对当前前台应用及模板分数</label>
            </div>
          )}
        </section>

        <section className="gather-run-section" aria-labelledby={`gather-run-once-${index}`}>
          <h3 id={`gather-run-once-${index}`}>手动采集一轮</h3>
          {game.tasks.length === 0 ? <p className="gather-micro">这个游戏包还没有可运行的任务。</p> : (
            <div className="gather-inline">
              <select value={taskId} onChange={(event) => setTaskId(event.target.value)} disabled={Boolean(busy)} aria-label="任务">
                {game.tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
              </select>
              <button type="button" className="btn sm primary" onClick={() => void start()} disabled={!canRun}>
                {busy === 'run' ? <Spinner size={14} /> : <Icon name="play" />}采集一轮
              </button>
              {activeRun && (
                <button type="button" className="btn sm danger-ghost" onClick={() => void stop(activeRun.runId)} disabled={Boolean(busy) || activeRun.status === 'stopping'}>
                  {busy === 'stop' ? <Spinner size={14} /> : <Icon name="stop" />}停止本轮
                </button>
              )}
            </div>
          )}
          <p className="gather-micro">{hint}</p>
        </section>

        <section className="gather-run-section" aria-labelledby={`gather-run-history-${index}`}>
          <h3 id={`gather-run-history-${index}`}>最近运行</h3>
          {instanceRuns.length === 0 ? <p className="gather-micro">这个实例尚无运行记录。</p> : (
            <ul className="gather-run-list">
              {instanceRuns.slice(0, 5).map((run) => (
                <li key={run.runId} className={`is-${run.status}`}>
                  <span className="gather-run-dot" aria-hidden="true" />
                  <span><strong>{game.tasks.find((task) => task.id === run.taskId)?.name ?? run.taskId}</strong>
                    <small>{run.message || RUN_LABEL[run.status]}</small></span>
                  <span className="gather-run-meta"><strong>{RUN_LABEL[run.status]}</strong><small>{beijingTime(run.startedAt)}</small></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MaskedDrawer>
  );
}
