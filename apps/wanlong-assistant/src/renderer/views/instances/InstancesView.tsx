import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { InstanceState, SdkInfo, Settings } from '@avdm/core';
import { canStart, canStop } from '@avdm/emulator-shell/renderer/format';
import { CloneDialog } from '@avdm/emulator-shell/renderer/components/CloneDialog';
import { CreateDialog } from '@avdm/emulator-shell/renderer/components/CreateDialog';
import { EditDialog } from '@avdm/emulator-shell/renderer/components/EditDialog';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { useInstanceLifecycleGuard } from '../../components/InstanceLifecycleGuard';
import { DropdownMenu, type MenuItem } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { InstanceStateTag, SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { displayStatus, isRunning } from '../../format';
import { isRunActive, useActivity } from '../../state/activity';
import { useNavigation } from '../../state/navigation';
import { scriptRunBadge, usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { AccountLoginDrawer } from '../accounts/AccountLoginDrawer';
import { accountCellDisabledReason, accountOfIndex, boundTo, isBaseInstance, loginIsActive } from '../accounts/account-model';
import { CloneFromBaseDialog } from '../accounts/BaseInstanceCard';
import { InstanceAccountCell } from '../accounts/InstanceAccountCell';
import { useAccounts, useBaseInstance, useLoginSessions } from '../accounts/useAccounts';
import { batchTargets, type BatchKind } from '../gather/batch';
import { GatherConfigDrawer } from '../gather/GatherConfigDrawer';
import { InstanceGatherControls } from '../gather/InstanceGatherControls';
import { pauseInfoOf } from '../gather/pause-port';
import { useGatherConfigBadges } from '../gather/useGatherConfigBadges';
import { useGatherControls } from '../gather/useGatherControls';
import { useGatherQueues } from '../gather/queue-store';
import type { ViewProps } from '../types';
import { countUp, filterInstances, resolutionWarning, type StatusFilter } from './instance-model';
import './InstancesView.css';

const MAX_INSTANCES = 64;

type Dialog =
  | { kind: 'newInstance' }
  | { kind: 'blank'; settings: Settings; sdk: SdkInfo }
  | { kind: 'cloneBase'; baseIndex: number; baseName: string }
  | { kind: 'clone'; index: number }
  | { kind: 'edit'; index: number }
  | { kind: 'remove'; index: number };

/**
 * 模拟器实例 (original views/InstancesView.tsx): every AVD with its state, bound account, current activity and the
 * 自动采集 column; start / stop / restart / live view / edit / clone / delete through the shared emulator API, with the
 * occupancy check before anything that interrupts work; the base instance banner and 新建 (clone the base or a
 * blank AVD); batch gather over the filtered list; search and status filter; a resolution warning.
 * Clicking a row makes it the global current instance unless a page holds the selection lock.
 */
export function InstancesView({ visible }: ViewProps) {
  const toast = useToast();
  const { navigate } = useNavigation();
  const { game, gameId, instances, instancesLoaded, instancesError, reloadInstances, index, setIndex, lockReason } = useSelection();
  const { runs } = useActivity();
  const { scriptRunByInstance } = usePlanRuns();
  const { accounts, reload: reloadAccounts } = useAccounts(gameId || undefined);
  const sessions = useLoginSessions();
  const base = useBaseInstance(gameId || undefined, (view) => {
    if (view.cleared) toast.push({ kind: 'warn', title: '基础实例已失效', detail: `#${view.cleared.index}「${view.cleared.name}」：${view.cleared.reason}，已自动取消。` });
  });
  const queues = useGatherQueues(gameId);
  const { guard, dialog: guardDialog } = useInstanceLifecycleGuard();
  const [busy, setBusy] = useState<Record<string, true>>({});
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [loginTargets, setLoginTargets] = useState<number[] | null>(null);
  const [configFor, setConfigFor] = useState<number | null>(null);
  const [batchRunning, setBatchRunning] = useState<BatchKind | null>(null);
  const [maxRunning, setMaxRunning] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // 「几分钟前」 needs only a coarse clock: every 10 s, so the table does not re-render every second.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  useEffect(() => {
    let alive = true;
    void avdm.getSettings().then((settings) => { if (alive) setMaxRunning(settings.maxRunning); }, () => undefined);
    return () => { alive = false; };
  }, []);

  const byIndex = useMemo(() => new Map(instances.map((instance) => [instance.record.index, instance])), [instances]);
  const nameOf = (i: number) => byIndex.get(i)?.record.name ?? `实例 #${i}`;
  const boundAccountOf = (i: number) => {
    const account = accountOfIndex(accounts, i);
    return account && boundTo(account, byIndex.get(i)) ? account : null;
  };
  const controls = useGatherControls(gameId, game?.packageName ?? '', queues, nameOf);
  const { badges, refresh: refreshBadges } = useGatherConfigBadges(gameId, instances.map((instance) => instance.record.index),
    (i) => queues.byInstance[i]?.auto === true, (i) => boundAccountOf(i) !== null);

  const visibleInstances = useMemo(() => filterInstances(instances, accounts, query, statusFilter), [instances, accounts, query, statusFilter]);
  const upCount = countUp(instances);
  const atLimit = maxRunning !== null && upCount >= maxRunning;
  const baseSelection = base.view?.base ?? null;
  const baseInstance = baseSelection ? byIndex.get(baseSelection.index) : undefined;

  const selectable = (target: number): boolean => target !== index && !lockReason;
  const mark = (key: string, on: boolean) => setBusy((current) => {
    const next = { ...current };
    if (on) next[key] = true;
    else delete next[key];
    return next;
  });
  const isBusy = (i: number) => Object.keys(busy).some((key) => key.startsWith(`${i}:`));

  /** Clicking anywhere on a row selects it; clicks on the row's own controls keep their own meaning. */
  function onRowClick(event: MouseEvent<HTMLTableRowElement>, target: number): void {
    // Dialogs and drawers opened from a cell are rendered inside the row: their clicks never select it.
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="switch"], .dropdown, [role="dialog"], .modal-backdrop, .drawer, .gather-drawer-mask')) return;
    if (selectable(target)) setIndex(target);
  }

  async function op(i: number, name: string, work: () => Promise<void>): Promise<void> {
    const key = `${i}:${name}`;
    if (busy[key]) return;
    mark(key, true);
    try { await work(); }
    catch (error) { toast.error(`实例 #${i} ${name}失败`, errMsg(error)); }
    finally { mark(key, false); void reloadInstances(); }
  }

  const start = (i: number) => op(i, '启动', async () => toast.batch('启动实例', await avdm.start([i]), nameOf));
  const stop = (i: number) => op(i, '关闭', async () => {
    await guard({ action: 'stop', indices: [i], run: async () => toast.batch('关闭实例', await avdm.stop([i]), nameOf) });
  });
  const restart = (i: number) => op(i, '重启', async () => {
    await guard({ action: 'restart', indices: [i], run: async () => toast.batch('重启实例', await avdm.restart([i]), nameOf) });
  });
  const remove = (i: number) => op(i, '删除', async () => {
    await guard({ action: 'remove', indices: [i], run: async () => toast.batch('删除实例', await avdm.remove([i]), nameOf) });
  });

  async function openLive(i: number): Promise<void> {
    try { await avdm.openLiveView(i); }
    catch (error) { toast.error('无法打开实时画面', errMsg(error)); }
  }

  async function changeBase(i: number | null): Promise<void> {
    if (!gameId) return;
    const key = `${i ?? baseSelection?.index ?? -1}:基础实例`;
    mark(key, true);
    try {
      const view = await avdm.instanceSetBase(gameId, i);
      toast.push({ kind: 'success', title: view.base ? `已将实例 #${view.base.index}「${view.base.name}」设为基础实例` : '已取消基础实例，后续默认空白新建' });
      void base.reload();
    } catch (error) {
      toast.error(i === null ? '取消基础实例失败' : '设为基础实例失败', errMsg(error));
    } finally {
      mark(key, false);
    }
  }

  /** 新建实例: clone the base by default (original), or a blank AVD from an installed system image. */
  async function openBlank(): Promise<void> {
    setCreating(true);
    try {
      const [settings, sdk] = await Promise.all([avdm.getSettings(), avdm.getSdk()]);
      setDialog({ kind: 'blank', settings, sdk });
    } catch (error) {
      toast.error('无法读取模拟器设置', errMsg(error));
    } finally {
      setCreating(false);
    }
  }

  function afterCreated(indices: number[], login: boolean): void {
    void reloadInstances();
    if (login && indices.length > 0) setLoginTargets(indices);
  }

  async function runBatch(kind: BatchKind): Promise<void> {
    const candidates = visibleInstances.map((instance) => {
      const i = instance.record.index;
      const state = queues.stateOf(i);
      return {
        index: i, up: instance.status === 'running', paused: pauseInfoOf(state).paused, isBase: isBaseInstance(base.view, instance),
        auto: state.auto, autoBusy: queues.autoBusy[i] === true, sampling: queues.sampling[i] === true || state.sampling,
        operating: state.operating === true,
      };
    });
    const { targets, skipped } = batchTargets(kind, candidates);
    setBatchRunning(kind);
    try { await controls.runBatch(kind, targets, skipped); }
    finally { setBatchRunning(null); }
  }

  const batchItems: MenuItem[] = [
    { label: '全部开启自动采集', icon: 'play', onClick: () => void runBatch('on') },
    { label: '全部关闭自动采集', icon: 'stop', onClick: () => void runBatch('off') },
    { label: '全部立即采样', icon: 'refresh', divider: true, onClick: () => void runBatch('sample') },
  ];

  function rowMenu(instance: InstanceState): MenuItem[] {
    const i = instance.record.index;
    const isBase = isBaseInstance(base.view, instance);
    const gatherRun = runs.some((run) => run.index === i && isRunActive(run));
    const stopped = instance.status === 'stopped' || instance.status === 'error';
    return [
      { label: '账号登录', icon: 'keyboard', disabled: isBase || gatherRun || !gameId, hint: isBase ? '基础实例只用于克隆，请在副本中登录账号' : gatherRun ? '这个实例上还有采集在跑' : undefined,
        onClick: () => setLoginTargets([i]) },
      { label: '采集配置', icon: 'settings', disabled: !gameId, onClick: () => setConfigFor(i) },
      { label: '重启实例', icon: 'restart', disabled: !isRunning(instance), onClick: () => void restart(i) },
      { label: '编辑配置', icon: 'edit', divider: true, onClick: () => setDialog({ kind: 'edit', index: i }) },
      { label: isBase ? '取消基础实例' : '设为基础实例', icon: 'pin', disabled: !gameId || Boolean(instance.record.provisioning),
        onClick: () => void changeBase(isBase ? null : i) },
      { label: '克隆实例', icon: 'copy', disabled: !stopped, hint: stopped ? undefined : '请先关闭实例再克隆', onClick: () => setDialog({ kind: 'clone', index: i }) },
      { label: '删除实例', icon: 'trash', danger: true, divider: true, disabled: !stopped || Boolean(instance.record.provisioning),
        hint: stopped ? undefined : '请先关闭实例再删除', onClick: () => setDialog({ kind: 'remove', index: i }) },
    ];
  }

  const editing = dialog?.kind === 'edit' || dialog?.kind === 'clone' ? byIndex.get(dialog.index) : undefined;
  const removing = dialog?.kind === 'remove' ? byIndex.get(dialog.index) : undefined;
  const configInstance = configFor === null ? undefined : byIndex.get(configFor);

  return (
    <section className="instances-view" aria-labelledby="instances-title">
      <header className="instances-head">
        <div>
          <h2 id="instances-title">模拟器实例
            <SemanticTag tone={atLimit ? 'warning' : 'info'}>已开机 {upCount}{maxRunning !== null ? ` / 上限 ${maxRunning}` : ''}</SemanticTag>
          </h2>
          <p>点击一行或「设为当前」即切换全局当前实例；启动、关闭、克隆与删除会先检查实例上是否有任务在跑。</p>
        </div>
        <div className="instances-head-actions">
          <DropdownMenu className="btn sm" title="批量采集" items={batchItems}
            trigger={<>{batchRunning ? <Spinner size={12} /> : <Icon name="workflow" />}批量采集</>} />
          <button type="button" className="btn sm" onClick={() => { void reloadInstances(); void reloadAccounts(); void base.reload(); void queues.reload(); }}
            disabled={!instancesLoaded}><Icon name="refresh" />刷新</button>
          <button type="button" className="btn sm primary" onClick={() => setDialog({ kind: 'newInstance' })} disabled={creating || !gameId}>
            {creating ? <Spinner size={12} /> : <Icon name="plus" />}新建实例
          </button>
        </div>
      </header>

      {gameId && (
        <div className="instances-base" role="status">
          <span>
            {base.error ? `基础实例设置读取失败：${base.error}`
              : baseSelection ? `基础实例：#${baseSelection.index} ${baseInstance?.record.name ?? baseSelection.name} · 新建时默认克隆`
                : '未设置基础实例 · 可在实例的「更多」中设置'}
          </span>
          {baseSelection && <button type="button" className="link-btn" onClick={() => void changeBase(null)}>取消基础实例</button>}
          {baseSelection && base.view?.cloneBlocked && <span className="instances-warn">{base.view.cloneBlocked}。</span>}
        </div>
      )}
      {atLimit && (
        <div className="notice warn" role="status"><Icon name="alert" /><div>
          <strong>已达到同时运行上限（{maxRunning} 个）</strong>
          <div>继续开机会让 CPU 与内存吃紧。请先关掉一个实例，或到「设置 → 模拟器参数」调整上限（与多开管理器共用）。</div>
        </div></div>
      )}
      {queues.loaded && queues.error && (
        <div className="notice warn" role="status"><Icon name="alert" /><div><strong>「自动采集」列暂时不可用</strong><div>{queues.error}</div></div></div>
      )}
      {instancesError && <p className="instances-error" role="alert">实例列表读取失败：{instancesError}</p>}
      {lockReason && <p className="instances-note" role="status">{lockReason}</p>}

      <div className="instances-toolbar">
        <div className="instances-inline">
          <label className="search">
            <Icon name="search" />
            <input type="search" placeholder="搜索实例名称、序号或账号" aria-label="搜索实例" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select aria-label="筛选实例状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
            <option value="all">全部状态</option>
            <option value="up">已开机</option>
            <option value="stopped">未开机</option>
          </select>
        </div>
        <span className="instances-count">{visibleInstances.length} / {instances.length} 个实例 · 批量采集只作用于筛选出来的实例</span>
      </div>

      {!instancesLoaded ? <p className="instances-empty"><Spinner /> 正在读取实例…</p>
        : instances.length === 0 ? <p className="instances-empty">还没有模拟器实例。点右上角「新建实例」创建，或在模拟器管理器里创建后回来刷新。</p>
          : visibleInstances.length === 0 ? <p className="instances-empty">没有符合筛选条件的实例，请调整搜索或状态筛选。</p>
            : (
              <div className="table-wrap instances-scroll">
                <table className="inst-table instances-table">
                  <thead><tr>
                    <th>实例</th><th>状态</th><th>绑定账号</th><th>当前执行</th>
                    <th title="与「采集总览」页的「自动调度」开关、「立即采样」按钮是同一套：开关决定调度器要不要在队列释放时自动派下一轮；「采样」是立刻读一次「部队管理」面板，不派兵。">自动采集</th>
                    <th aria-label="操作" />
                  </tr></thead>
                  <tbody>
                    {visibleInstances.map((instance) => {
                      const i = instance.record.index;
                      const current = i === index;
                      const isBase = isBaseInstance(base.view, instance);
                      const account = accountOfIndex(accounts, i);
                      const gatherRun = runs.find((run) => run.index === i && isRunActive(run));
                      const script = scriptRunByInstance.get(i);
                      const session = sessions.get(i) ?? null;
                      const warning = resolutionWarning(instance.record.spec);
                      const state = queues.stateOf(i, account?.id ?? null);
                      return (
                        <tr key={i} className={current ? 'selected' : selectable(i) ? 'instances-row-pick' : undefined}
                          aria-current={current ? 'true' : undefined} onClick={(event) => onRowClick(event, i)}>
                          <td>
                            <div className="instances-name">
                              <span className="inst-name" title={instance.record.name}>{instance.record.name}</span>
                              <small>实例 #{i}{isBase && <SemanticTag tone="info">基础实例</SemanticTag>}</small>
                              <button type="button" className="btn xs" onClick={() => setIndex(i)} disabled={!selectable(i)} title={lockReason ?? undefined}>
                                {current ? '当前实例' : '设为当前'}
                              </button>
                            </div>
                          </td>
                          <td>
                            <div className="instances-state">
                              <InstanceStateTag status={displayStatus(instance)} />
                              {warning && <span title={warning.tip}><SemanticTag tone="warning">{warning.label}</SemanticTag></span>}
                              <small className="mono dim">{instance.record.spec.width}×{instance.record.spec.height}{isRunning(instance) ? ` · ${instance.ports.serial}` : ''}</small>
                            </div>
                          </td>
                          <td>
                            {gameId ? (
                              <InstanceAccountCell gameId={gameId} instance={instance} instances={instances} accounts={accounts} loginSession={session}
                                gatherFollowsAccount
                                disabledReason={accountCellDisabledReason({ base: isBase, bound: Boolean(account), running: Boolean(gatherRun), loginActive: loginIsActive(session?.phase) })}
                                onChanged={() => { refreshBadges(); void queues.reload(); }} onLogin={(target) => setLoginTargets([target])} />
                            ) : <span className="dim">—</span>}
                          </td>
                          <td>
                            <div className="instances-activity">
                              {gatherRun && <SemanticTag tone={gatherRun.status === 'stopping' ? 'warning' : 'accent'}>{gatherRun.status === 'stopping' ? '采集停止中' : '采集中'}</SemanticTag>}
                              {script && <span title={`${script.scriptName}（${script.source === 'plan' ? '计划任务' : '临时运行'}）`}>
                                <SemanticTag tone={script.status === 'paused' ? 'warning' : 'accent'}>{scriptRunBadge(script)}</SemanticTag></span>}
                              {!gatherRun && !script && <span className="dim">空闲</span>}
                            </div>
                          </td>
                          <td>
                            {gameId ? (
                              <InstanceGatherControls instance={instance} state={state} pause={pauseInfoOf(state)} now={now}
                                sampling={queues.sampling[i] === true} toggling={queues.autoBusy[i] === true} resuming={queues.resuming[i] === true}
                                configEnabled={badges[i]?.enabled === true} hasAccount={Boolean(account)} isBase={isBase}
                                onToggleAuto={(target, on) => void controls.toggleAuto(target, on)} onSample={(target) => void controls.sample(target)}
                                onResume={controls.resume} onOpenConfig={setConfigFor} onOpenAccounts={() => navigate('accounts')} />
                            ) : <span className="dim">—</span>}
                          </td>
                          <td className="instances-actions">
                            {canStop(instance) ? (
                              <button type="button" className="btn xs danger-ghost" disabled={isBusy(i)} onClick={() => void stop(i)}>
                                {busy[`${i}:关闭`] ? <Spinner size={11} /> : <Icon name="power" size={13} />}关闭
                              </button>
                            ) : (
                              <button type="button" className="btn xs primary" disabled={isBusy(i) || !canStart(instance) || atLimit}
                                title={atLimit ? `已开机 ${upCount} 个，达到同时运行上限 ${maxRunning}。请先关掉一个，或到「设置」里调高上限。` : undefined}
                                onClick={() => void start(i)}>
                                {busy[`${i}:启动`] ? <Spinner size={11} /> : <Icon name="play" size={13} />}启动
                              </button>
                            )}
                            <button type="button" className="icon-btn small" onClick={() => void openLive(i)} disabled={!isRunning(instance)}
                              title="打开实时画面" aria-label={`打开实例 #${i} 的实时画面`}><Icon name="screen" /></button>
                            <DropdownMenu title={`实例 #${i} 更多操作`} items={rowMenu(instance)} trigger={<Icon name="more" />} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

      {dialog?.kind === 'newInstance' && (
        <Modal title="新建实例" onClose={() => setDialog(null)} width={500}
          footer={<button type="button" className="btn" onClick={() => setDialog(null)}>取消</button>}>
          <div className="instances-new">
            <button type="button" className="instances-new-option" disabled={!baseSelection || Boolean(base.view?.cloneBlocked)}
              onClick={() => baseSelection && setDialog({ kind: 'cloneBase', baseIndex: baseSelection.index, baseName: baseSelection.name })}>
              <strong><Icon name="copy" /> 克隆基础实例{baseSelection ? ` #${baseSelection.index} · ${baseSelection.name}` : '（尚未设置）'}</strong>
              <span>{!baseSelection ? '先在某个装好游戏的实例的「更多」里设为基础实例。'
                : base.view?.cloneBlocked ? `暂时不能克隆：${base.view.cloneBlocked}。`
                  : '沿用基础实例中的应用、游戏数据和模板集，可一次克隆 1–8 个，克隆后直接进入账号登录向导。'}</span>
            </button>
            <button type="button" className="instances-new-option" onClick={() => void openBlank()}>
              <strong><Icon name="plus" /> 空白新建</strong>
              <span>从已安装的系统镜像创建全新的实例。新实例里还没有游戏，需要先安装游戏。</span>
            </button>
            <p className="hint block">每个新实例约占用 4 GB 磁盘，创建过程可能持续数分钟。</p>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'cloneBase' && gameId && (
        <CloneFromBaseDialog gameId={gameId} expectedBaseIndex={dialog.baseIndex} baseName={dialog.baseName} onClose={() => setDialog(null)}
          onCloned={(indices, login) => { setDialog(null); void base.reload(); afterCreated(indices, login); }} />
      )}
      {dialog?.kind === 'blank' && (
        <CreateDialog settings={dialog.settings} sdk={dialog.sdk} freeSlots={Math.max(0, MAX_INSTANCES - instances.length)}
          initialSpec={{ width: 2560, height: 1440, dpi: 360 }}
          notice={<div className="notice info"><Icon name="info" /><div>模板与字形都截自 2560×1440，这里默认按它新建；分辨率至少保持 1920×1080（16:9），否则倒计时与等级读数不可靠。</div></div>}
          onClose={() => setDialog(null)}
          onCreated={(records, startNow) => {
            toast.push({ kind: 'success', title: `已创建 ${records.length} 个实例`, detail: records.map((r) => `${r.name} #${r.index}`).join('、') });
            afterCreated([], false);
            if (startNow) {
              void avdm.start(records.map((r) => r.index)).then((results) => toast.batch('启动实例', results, nameOf),
                (error: unknown) => toast.error('启动实例失败', errMsg(error))).finally(() => { void reloadInstances(); });
            }
          }}
          onInstallImages={() => toast.push({ kind: 'info', title: '请在「AVD 多开管理器」中安装系统镜像', detail: '助手不负责下载系统镜像；装好后回到这里刷新即可。' })} />
      )}
      {dialog?.kind === 'clone' && editing && (
        <CloneDialog source={editing} freeSlots={Math.max(0, MAX_INSTANCES - instances.length)} onClose={() => setDialog(null)}
          onCloned={(records) => {
            toast.push({ kind: 'success', title: `已克隆 ${records.length} 个实例`, detail: records.map((r) => `${r.name} #${r.index}`).join('、') });
            void reloadInstances();
          }} />
      )}
      {dialog?.kind === 'edit' && editing && (
        <EditDialog state={editing} onClose={() => setDialog(null)}
          onSaved={(record) => { toast.push({ kind: 'success', title: `已保存「${record.name}」的配置` }); void reloadInstances(); }} />
      )}
      {dialog?.kind === 'remove' && removing && (
        <ConfirmDialog title={`删除实例 #${removing.record.index}（${removing.record.name}）？`} confirmLabel="确认删除" danger
          message="实例数据会被永久删除，且无法恢复。请确认里面的账号数据已经不需要了（助手里的账号资料不会被删除，只是解除与它的对应）。"
          onClose={() => setDialog(null)} onConfirm={() => { const target = removing.record.index; setDialog(null); void remove(target); }} />
      )}
      {loginTargets && gameId && (
        <AccountLoginDrawer gameId={gameId} indices={loginTargets} onClose={() => { setLoginTargets(null); void reloadAccounts(); }} />
      )}
      {configFor !== null && gameId && (
        <GatherConfigDrawer gameId={gameId} index={configFor} instanceName={configInstance?.record.name ?? `实例 #${configFor}`}
          boundAccount={boundAccountOf(configFor)?.name ?? null} autoOn={queues.byInstance[configFor]?.auto === true}
          onClose={() => setConfigFor(null)} onSaved={() => { refreshBadges(); void queues.reload(); }} />
      )}
      {controls.dialog}
      {guardDialog}
    </section>
  );
}
