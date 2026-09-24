import { useState, type MouseEvent } from 'react';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner, StatusBadge } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { displayStatus, isRunning } from '../../format';
import { isRunActive, useActivity } from '../../state/activity';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import './InstancesView.css';

/**
 * 模拟器实例: every emulator instance with its state and the assistant's activity on it. Clicking a row (or its
 * 「设为当前」 button, the keyboard path) makes it the current instance of every page unless a page holds the
 * selection lock. Lifecycle actions stay in the emulator manager for now.
 */
export function InstancesView(_props: ViewProps) {
  const toast = useToast();
  const { instances, instancesLoaded, instancesError, reloadInstances, index, setIndex, lockReason, gameId } = useSelection();
  const { runs, schedules } = useActivity();
  const [busy, setBusy] = useState<number | null>(null);

  const selectable = (target: number): boolean => target !== index && !lockReason;

  /** Clicking anywhere on a row selects it; clicks on the row's own buttons keep their own meaning. */
  function onRowClick(event: MouseEvent<HTMLTableRowElement>, target: number): void {
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (selectable(target)) setIndex(target);
  }

  async function openLive(target: number): Promise<void> {
    if (busy !== null) return;
    setBusy(target);
    try { await avdm.openLiveView(target); }
    catch (error) { toast.error('无法打开实时画面', errMsg(error)); }
    finally { setBusy(null); }
  }

  return (
    <section className="instances-view" aria-labelledby="instances-title">
      <header className="instances-head">
        <div><h2 id="instances-title">模拟器实例</h2><p>点击一行或「设为当前」即切换全局当前实例；启动、停止与新建请在模拟器管理器中完成。</p></div>
        <button className="btn sm" onClick={() => void reloadInstances()} disabled={!instancesLoaded}><Icon name="refresh" />刷新</button>
      </header>
      {instancesError && <p className="instances-error" role="alert">实例列表读取失败：{instancesError}</p>}
      {lockReason && <p className="instances-note" role="status">{lockReason}</p>}
      {!instancesLoaded ? <p className="instances-empty"><Spinner /> 正在读取实例…</p>
        : instances.length === 0 ? <p className="instances-empty">还没有模拟器实例。请先在模拟器管理器中创建并启动一个实例。</p>
          : <div className="table-wrap instances-scroll">
            <table className="inst-table instances-table">
              <thead><tr><th>序号</th><th>名称</th><th>状态</th><th>连接</th><th>自动采集</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {instances.map((instance) => {
                  const i = instance.record.index;
                  const current = i === index;
                  const run = runs.find((item) => item.index === i && isRunActive(item));
                  const scheduled = schedules.some((item) => item.gameId === gameId && item.index === i && item.enabled);
                  return (
                    <tr key={i} className={current ? 'selected' : selectable(i) ? 'instances-row-pick' : undefined}
                      aria-current={current ? 'true' : undefined} onClick={(event) => onRowClick(event, i)}>
                      <td className="mono">#{i}</td>
                      <td><span className="inst-name" title={instance.record.name}>{instance.record.name}</span></td>
                      <td><StatusBadge status={displayStatus(instance)} /></td>
                      <td className="mono dim">{isRunning(instance) ? instance.ports.serial : '—'}</td>
                      <td>{run ? <span className="tag ok">{run.status === 'stopping' ? '正在停止' : '采集中'}</span> : scheduled ? <span className="tag">自动续跑</span> : <span className="dim">—</span>}</td>
                      <td className="instances-actions">
                        <button className="btn xs" onClick={() => setIndex(i)} disabled={!selectable(i)} title={lockReason ?? undefined}>{current ? '当前实例' : '设为当前'}</button>
                        <button className="icon-btn small" onClick={() => void openLive(i)} disabled={!isRunning(instance) || busy !== null} title="打开实时画面" aria-label={`打开实例 #${i} 的实时画面`}>
                          {busy === i ? <Spinner size={12} /> : <Icon name="screen" />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
    </section>
  );
}
