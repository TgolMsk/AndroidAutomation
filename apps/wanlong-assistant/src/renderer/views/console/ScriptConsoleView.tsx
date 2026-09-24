import { useEffect, useMemo, useState } from 'react';
import type { ScriptParamValue } from '@avdm/automation/script';
import type { ScriptDef, ScriptMeta, ScriptRunPriority, ShotPolicy } from '../../../main/plans/types';
import { pauseTitle } from '../../../shared/alerts';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { InstanceStateTag, SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { displayStatus, isRunning } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { isRunActive, useActivity } from '../../state/activity';
import { pauseOf, useAlerts } from '../../state/alerts';
import { scriptRunBadge, usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { accountOfIndex, loginIsActive } from '../accounts/account-model';
import { useAccounts, useLoginSessions } from '../accounts/useAccounts';
import { scriptRunProgress } from '../instances/instance-model';
import { defaultParams, SHOT_POLICY_OPTIONS, usesUnicodeText } from '../runs/run-rows';
import { ParamField } from '../runs/StartRunDialog';
import type { ViewProps } from '../types';
import {
  capacityNote, dispatchSkipReason, dispatchSummary, PRIORITY_OPTIONS, PRIORITY_RULE, runAccountOf, selectBlockReason, toggleIndex,
  type DispatchResult,
} from './console-model';
import './ScriptConsoleView.css';

type BatchAction = 'pause' | 'resume' | 'stop';

/**
 * 脚本控制台: one place to tick several emulators and run one script on all of them (each instance gets its own run,
 * with its bound account's params), then pause / resume / stop them together. Runs start at 最高优先 by default:
 * everything else automatic on those instances stands down until the script ends (see PRIORITY_RULE).
 */
export function ScriptConsoleView({ visible }: ViewProps) {
  const toast = useToast();
  const { game, gameId, instances } = useSelection();
  const { runs } = useActivity();
  const { scriptRunByInstance, refreshPlanRuns } = usePlanRuns();
  const { pauses } = useAlerts();
  const { accounts } = useAccounts(gameId || undefined);
  const sessions = useLoginSessions();

  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scriptId, setScriptId] = useState('');
  const [def, setDef] = useState<ScriptDef | null>(null);
  const [defError, setDefError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ScriptParamValue>>({});
  const [priority, setPriority] = useState<ScriptRunPriority>('highest');
  const [withAccount, setWithAccount] = useState(true);
  const [shotPolicy, setShotPolicy] = useState<ShotPolicy | ''>('');
  const [minutes, setMinutes] = useState('60');
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ReadonlyMap<number, DispatchResult>>(new Map());
  const [dispatching, setDispatching] = useState(false);
  const [batchBusy, setBatchBusy] = useState<BatchAction | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [rowBusy, setRowBusy] = useState<number | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [graceSeconds, setGraceSeconds] = useState<number | null>(null);

  // The script list and the concurrency cap: read when the page is shown (scripts are edited on the 脚本 page).
  useEffect(() => {
    if (!visible || !gameId) return;
    let alive = true;
    void avdm.scriptList(gameId).then((list) => {
      if (!alive) return;
      setScripts(list.filter((item) => item.version !== '0'));
      setLoadError(null);
    }, (error: unknown) => { if (alive) setLoadError(errMsg(error)); });
    void avdm.planConfig(gameId).then((config) => {
      if (!alive) return;
      setCap(config.maxConcurrentScripts);
      setGraceSeconds(Math.round(config.preemptGraceMs / 1000));
    }, () => undefined);
    void refreshPlanRuns();
    return () => { alive = false; };
  }, [gameId, visible, refreshPlanRuns]);
  useAvdmEvent('plan-config-changed', (event) => {
    if (event.gameId !== gameId) return;
    setCap(event.config.maxConcurrentScripts);
    setGraceSeconds(Math.round(event.config.preemptGraceMs / 1000));
  });

  useEffect(() => {
    if (!scriptId || !gameId) { setDef(null); setParams({}); return; }
    let alive = true;
    setDefError(null);
    void avdm.scriptGet(gameId, scriptId).then((script) => {
      if (!alive) return;
      setDef(script);
      setParams(defaultParams(script.params));
    }, (error: unknown) => { if (alive) { setDef(null); setDefError(errMsg(error)); } });
    return () => { alive = false; };
  }, [gameId, scriptId]);

  const rows = useMemo(() => instances.map((instance) => {
    const i = instance.record.index;
    const run = scriptRunByInstance.get(i) ?? null;
    const account = runAccountOf(accountOfIndex(accounts, i), { index: i, createdAt: instance.record.createdAt }, withAccount);
    const pause = pauseOf(pauses, i);
    const input = { running: isRunning(instance), scriptRunning: run?.scriptName ?? null, loginActive: loginIsActive(sessions.get(i)?.phase) };
    return {
      instance, index: i, run, account, input,
      pause: pause?.paused ? pauseTitle(pause) : null,
      gatherActive: runs.some((item) => item.index === i && isRunActive(item)),
      blocked: selectBlockReason(input),
      skip: dispatchSkipReason(input),
    };
  }), [instances, scriptRunByInstance, accounts, withAccount, pauses, sessions, runs]);

  const needle = query.trim().toLowerCase();
  const shown = needle ? rows.filter((row) => [row.instance.record.name, `#${row.index}`, String(row.index), row.account.label]
    .some((text) => text.toLowerCase().includes(needle))) : rows;
  const selectedRows = rows.filter((row) => selected.includes(row.index));
  const startable = selectedRows.filter((row) => row.skip === null);
  const withRuns = selectedRows.filter((row) => row.run);
  const capacity = capacityNote(cap, scriptRunByInstance.size, startable.length);
  const minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue >= 0 && minutesValue <= 720;
  const needsIme = usesUnicodeText(def);
  const scriptName = def?.name ?? scripts.find((item) => item.id === scriptId)?.name ?? '';
  const startBlock = !gameId ? '游戏模块尚未加载' : !scriptId ? '先选一个脚本' : !def ? (defError ? '脚本读不出来' : '正在读取脚本')
    : !minutesValid ? '运行时长上限应为 0–720 分钟' : selected.length === 0 ? '先在右侧勾选实例'
      : startable.length === 0 ? '勾选的实例都不能新开脚本（未开机、已有脚本或正在登录）' : null;

  // Ticks of instances that disappeared (deleted) are dropped.
  useEffect(() => {
    setSelected((current) => {
      const next = current.filter((i) => rows.some((row) => row.index === i && row.blocked === null));
      return next.length === current.length ? current : next;
    });
  }, [rows]);

  async function dispatch(): Promise<void> {
    if (startBlock || dispatching || !def) return;
    setDispatching(true);
    const skipped: DispatchResult[] = selectedRows.filter((row) => row.skip !== null)
      .map((row) => ({ index: row.index, ok: false, error: row.skip!, at: Date.now(), skipped: true }));
    const settled = await Promise.all(startable.map(async (row): Promise<DispatchResult> => {
      try {
        const snapshot = await avdm.scriptRun(gameId, row.index, def.id, {
          ...(row.account.accountId ? { accountId: row.account.accountId } : {}),
          params, priority, maxRunMinutes: minutesValue, ...(shotPolicy ? { shotPolicy } : {}),
        });
        return { index: row.index, ok: true, runId: snapshot.runId, at: Date.now() };
      } catch (error) {
        return { index: row.index, ok: false, error: errMsg(error), at: Date.now() };
      }
    }));
    const all = [...settled, ...skipped];
    setResults(new Map(all.map((result) => [result.index, result])));
    toast.push(dispatchSummary(all, def.name));
    setDispatching(false);
    void refreshPlanRuns();
  }

  async function batch(action: BatchAction): Promise<void> {
    if (batchBusy || !gameId) return;
    const targets = withRuns.filter((row) => row.run && (action === 'resume' ? row.run.status === 'paused'
      : action === 'pause' ? row.run.status === 'running' : row.run.status !== 'stopping'));
    if (targets.length === 0) return;
    setBatchBusy(action);
    setConfirmStop(false);
    const call = action === 'pause' ? avdm.runPause : action === 'resume' ? avdm.runResume : avdm.runStop;
    const outcome = await Promise.allSettled(targets.map((row) => call(gameId, row.run!.runId)));
    const failed = outcome.filter((item) => item.status === 'rejected').length;
    const label = action === 'pause' ? '暂停' : action === 'resume' ? '继续' : '停止';
    toast.push(failed > 0
      ? { kind: 'warn', title: `${label}了 ${targets.length - failed} 个，${failed} 个失败`, detail: outcome.flatMap((item) => item.status === 'rejected' ? [errMsg(item.reason)] : [])[0] }
      : { kind: 'success', title: `已${label} ${targets.length} 个实例上的脚本`, ...(action === 'stop' ? { detail: '跑完当前步骤后退出' } : {}) });
    setBatchBusy(null);
    void refreshPlanRuns();
  }

  async function rowAction(index: number, action: BatchAction, runId: string): Promise<void> {
    if (rowBusy !== null) return;
    setRowBusy(index);
    try {
      if (action === 'pause') await avdm.runPause(gameId, runId);
      else if (action === 'resume') await avdm.runResume(gameId, runId);
      else await avdm.runStop(gameId, runId);
      void refreshPlanRuns();
    } catch (error) {
      toast.error(`实例 #${index} 操作失败`, errMsg(error));
    } finally { setRowBusy(null); }
  }

  async function openLive(index: number): Promise<void> {
    try { await avdm.openLiveView(index); }
    catch (error) { toast.error('无法打开实时画面', errMsg(error)); }
  }

  const selectable = rows.filter((row) => row.blocked === null);
  const allTicked = shown.length > 0 && shown.filter((row) => row.blocked === null).every((row) => selected.includes(row.index));
  const pausable = withRuns.filter((row) => row.run!.status === 'running').length;
  const resumable = withRuns.filter((row) => row.run!.status === 'paused').length;
  const stoppable = withRuns.filter((row) => row.run!.status !== 'stopping').length;

  return (
    <section className="console-view" aria-labelledby="console-title">
      <header className="console-head">
        <div>
          <h2 id="console-title">脚本控制台</h2>
          <p>勾选多台模拟器，一次在它们上面执行同一个脚本；每台各跑一份，带各自绑定账号的参数。正在跑的脚本也能在这里一起暂停、继续或停止。</p>
        </div>
      </header>

      <div className="console-layout">
        <div className="console-config" aria-label="执行设置">
          {loadError && <p className="notice bad" role="alert">读取脚本失败：{loadError}</p>}
          <label className="field">
            <span className="field-label">脚本</span>
            <select value={scriptId} onChange={(event) => setScriptId(event.target.value)} disabled={!gameId}>
              <option value="" disabled>选择要执行的脚本</option>
              {scripts.map((script) => <option key={script.id} value={script.id}>{script.builtin ? '［示例］' : ''}{script.name}  v{script.version}（{script.stepCount} 步）</option>)}
            </select>
            {scripts.length === 0 && !loadError && <span className="hint">还没有脚本。到「脚本与模板 → 脚本」新建一个。</span>}
          </label>
          {defError && <p className="notice bad" role="alert">{defError}</p>}
          {def && <p className="console-muted">
            {def.loop ? `挂机模式（每 ${Math.round((def.loopIntervalMs ?? 0) / 1000)} 秒重来一轮）` : `${def.steps.length} 个顶层步骤`}
            {def.templateSetId ? `｜模板集 ${def.templateSetId}` : ''}｜参考分辨率 {def.refWidth}×{def.refHeight}
          </p>}

          <div className="field">
            <span className="field-label">执行优先级</span>
            <div className="console-seg" role="radiogroup" aria-label="执行优先级">
              {PRIORITY_OPTIONS.map((option) => (
                <button key={option.value} type="button" role="radio" aria-checked={priority === option.value}
                  className={priority === option.value ? 'is-active' : ''} title={option.hint} onClick={() => setPriority(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
            <span className="hint">{priority === 'highest' ? PRIORITY_OPTIONS[0]!.hint : `先等采集当前这一步做完（最多 ${graceSeconds ?? 8} 秒，「任务计划 → 计划设置」里的抢占宽限），再开始`}。</span>
          </div>

          <label className="check console-check">
            <input type="checkbox" checked={withAccount} onChange={(event) => setWithAccount(event.target.checked)} />
            <span>带上各实例绑定的账号<small>账号里存的脚本参数生效、日志按账号归档；没绑定或没登录好的实例照常不带账号运行</small></span>
          </label>

          <div className="console-grid">
            <label className="field">
              <span className="field-label">截图留痕</span>
              <select value={shotPolicy} onChange={(event) => setShotPolicy(event.target.value as ShotPolicy | '')}>
                <option value="">跟随应用设置</option>
                {SHOT_POLICY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">时长上限（分钟，0 = 不限）</span>
              <input type="number" min={0} max={720} value={minutes} onChange={(event) => setMinutes(event.target.value.replace(/[^\d]/g, ''))} />
            </label>
          </div>

          {def && (def.params?.length ?? 0) > 0 && (
            <fieldset className="runs-params">
              <legend>脚本参数（所有实例相同；账号里存的参数优先级更低）</legend>
              <div className="form-grid">
                {def.params!.map((param) => (
                  <ParamField key={param.key} param={param} value={params[param.key]}
                    onChange={(value) => setParams((current) => {
                      const next = { ...current };
                      if (value === undefined) delete next[param.key]; else next[param.key] = value;
                      return next;
                    })} />
                ))}
              </div>
            </fieldset>
          )}
          {needsIme && <p className="notice warn" role="status"><Icon name="keyboard" />这个脚本会输入中文：勾选的实例都要装好并启用 ADBKeyboard（「设置 → 设备工具」里安装）。</p>}

          <div className="notice info console-rule" role="note"><Icon name="info" /><div><strong>脚本最高优先</strong><span>{PRIORITY_RULE}</span></div></div>
        </div>

        <div className="console-targets">
          <div className="console-toolbar">
            <label className="search">
              <Icon name="search" />
              <input type="search" placeholder="搜索实例名称、序号或账号" aria-label="搜索实例" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button type="button" className="btn sm" disabled={selectable.length === 0}
              onClick={() => setSelected(allTicked ? selected.filter((i) => !shown.some((row) => row.index === i))
                : [...new Set([...selected, ...shown.filter((row) => row.blocked === null).map((row) => row.index)])].sort((a, b) => a - b))}>
              {allTicked ? '取消全选' : '全选已开机'}
            </button>
            <button type="button" className="btn sm" disabled={selectable.length === 0}
              onClick={() => setSelected(selectable.filter((row) => row.skip === null).map((row) => row.index))}>只选空闲的</button>
            <button type="button" className="btn sm ghost" disabled={selected.length === 0} onClick={() => setSelected([])}>清空</button>
            <span className="console-count">已选 {selected.length} 台 · 可新开 {startable.length} 台 · {selectable.length}/{rows.length} 台已开机</span>
          </div>

          {instances.length === 0 ? <p className="console-empty">还没有模拟器实例。到「设备与账号 → 模拟器实例」新建并启动。</p> : (
            <div className="table-wrap console-scroll">
              <table className="inst-table console-table">
                <thead><tr>
                  <th className="console-tick" aria-label="勾选" />
                  <th>实例</th><th>状态</th><th>账号</th><th>当前</th><th>本次下发</th><th aria-label="操作" />
                </tr></thead>
                <tbody>
                  {shown.map((row) => {
                    const ticked = selected.includes(row.index);
                    const result = results.get(row.index);
                    const progress = row.run ? scriptRunProgress(row.run) : null;
                    return (
                      <tr key={row.index} className={ticked ? 'is-ticked' : undefined}>
                        <td className="console-tick">
                          <input type="checkbox" checked={ticked} disabled={row.blocked !== null} title={row.blocked ?? undefined}
                            aria-label={`勾选实例 #${row.index}`} onChange={(event) => setSelected((current) => toggleIndex(current, row.index, event.target.checked))} />
                        </td>
                        <td>
                          <div className="console-name">
                            <span className="inst-name" title={row.instance.record.name}>{row.instance.record.name}</span>
                            <small className="mono dim">#{row.index}</small>
                          </div>
                        </td>
                        <td><InstanceStateTag status={displayStatus(row.instance)} /></td>
                        <td>
                          <div className="console-account" title={row.account.warning}>
                            <span>{row.account.label}</span>
                            {row.account.warning && <small className="console-warn">{row.account.warning}</small>}
                          </div>
                        </td>
                        <td>
                          <div className="console-activity">
                            {row.run ? <>
                              <SemanticTag tone={row.run.status === 'paused' ? 'warning' : 'accent'}>{scriptRunBadge(row.run)}</SemanticTag>
                              <span className="console-run-name" title={row.run.scriptName}>{row.run.scriptName}</span>
                              {progress && <small className="dim">{progress.percent !== null ? `${progress.percent}%｜` : ''}{progress.text}</small>}
                            </> : row.input.loginActive ? <SemanticTag tone="warning">登录中</SemanticTag>
                              : row.gatherActive ? <SemanticTag tone="info" title="脚本开始时会让它中止或先做完">采集中</SemanticTag>
                                : row.input.running ? <span className="dim">空闲</span> : <span className="dim">—</span>}
                            {row.pause && <SemanticTag tone="danger" title="告警暂停的是自动采集；脚本照样可以跑">{row.pause}</SemanticTag>}
                          </div>
                        </td>
                        <td className="console-result">
                          {!result ? <span className="dim">—</span>
                            : result.ok ? <span className="console-ok"><Icon name="check" size={13} />已启动</span>
                              : <span className={result.skipped ? 'console-skip' : 'console-fail'} title={result.error}>{result.skipped ? '跳过：' : '失败：'}{result.error}</span>}
                        </td>
                        <td>
                          <div className="console-actions">
                            {row.run && (row.run.status === 'paused'
                              ? <button type="button" className="btn xs" disabled={rowBusy !== null} onClick={() => void rowAction(row.index, 'resume', row.run!.runId)}>继续</button>
                              : <button type="button" className="btn xs" disabled={rowBusy !== null || row.run.status !== 'running'} onClick={() => void rowAction(row.index, 'pause', row.run!.runId)}>暂停</button>)}
                            {row.run && <button type="button" className="btn xs danger-ghost" disabled={rowBusy !== null || row.run.status === 'stopping'}
                              title="跑完当前步骤后退出" onClick={() => void rowAction(row.index, 'stop', row.run!.runId)}>
                              {rowBusy === row.index ? <Spinner size={11} /> : <Icon name="stop" size={12} />}停止</button>}
                            <button type="button" className="icon-btn small" disabled={!row.input.running} onClick={() => void openLive(row.index)}
                              title="打开实时画面" aria-label={`打开实例 #${row.index} 的实时画面`}><Icon name="screen" /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="console-footer">
            <div className="console-footer-notes">
              {capacity && <span className={capacity.over > 0 ? 'console-warn' : 'dim'}>{capacity.text}</span>}
              {startBlock && <span className="dim">{startBlock}</span>}
            </div>
            <div className="console-footer-actions">
              <button type="button" className="btn sm" disabled={pausable === 0 || batchBusy !== null} onClick={() => void batch('pause')}>
                {batchBusy === 'pause' && <Spinner size={11} />}暂停所选{pausable ? `（${pausable}）` : ''}
              </button>
              <button type="button" className="btn sm" disabled={resumable === 0 || batchBusy !== null} onClick={() => void batch('resume')}>
                {batchBusy === 'resume' && <Spinner size={11} />}继续所选{resumable ? `（${resumable}）` : ''}
              </button>
              {confirmStop ? <span className="console-confirm">
                <span>停止 {stoppable} 个脚本（跑完当前步骤后退出）？</span>
                <button type="button" className="btn sm danger" disabled={batchBusy !== null} onClick={() => void batch('stop')}>
                  {batchBusy === 'stop' && <Spinner size={11} />}确认停止
                </button>
                <button type="button" className="btn sm" onClick={() => setConfirmStop(false)}>取消</button>
              </span> : (
                <button type="button" className="btn sm danger-ghost" disabled={stoppable === 0 || batchBusy !== null} onClick={() => setConfirmStop(true)}>
                  <Icon name="stop" size={12} />停止所选{stoppable ? `（${stoppable}）` : ''}
                </button>
              )}
              <button type="button" className="btn primary" disabled={startBlock !== null || dispatching} title={startBlock ?? undefined} onClick={() => void dispatch()}>
                {dispatching ? <Spinner size={12} /> : <Icon name="play" size={14} />}
                {startable.length > 0 && scriptName ? `在 ${startable.length} 台上执行「${scriptName}」` : '执行'}
              </button>
            </div>
          </div>
          {!game && <p className="console-muted">游戏模块未加载。</p>}
        </div>
      </div>
    </section>
  );
}
