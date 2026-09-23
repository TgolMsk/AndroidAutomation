import { useEffect, useRef } from 'react';
import type { InstanceState } from '@avdm/core';
import { canStart, canStop, isActive, isRunning } from '../format';
import { Icon } from './Icon';

export type ViewMode = 'grid' | 'list';

export interface ToolbarProps {
  visible: InstanceState[];
  selected: InstanceState[];
  totalCount: number;
  view: ViewMode;
  filter: string;
  onFilter: (text: string) => void;
  onView: (v: ViewMode) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onInvert: () => void;
  onStart: (indices: number[]) => void;
  onStop: (indices: number[]) => void;
  onRestart: (indices: number[]) => void;
  onInstallApk: (indices: number[]) => void;
  onAppLaunch: (indices: number[]) => void;
  onShell: (indices: number[]) => void;
  onScripts: () => void;
  onDelete: (indices: number[]) => void;
}

const NEED_SELECTION = '请先选择实例';

export function Toolbar(p: ToolbarProps) {
  const idx = (list: InstanceState[]) => list.map((s) => s.record.index);
  const startable = idx(p.selected.filter(canStart));
  const stoppable = idx(p.selected.filter(canStop));
  const restartable = idx(p.selected.filter((s) => isActive(s) && s.status !== 'stopping'));
  const running = idx(p.selected.filter(isRunning));
  const all = idx(p.selected);
  const n = p.selected.length;
  const selectedSet = new Set(all);
  const allChecked = p.visible.length > 0 && p.visible.every((v) => selectedSet.has(v.record.index));
  const someChecked = n > 0 && !allChecked;
  const checkRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkRef.current) checkRef.current.indeterminate = someChecked;
  }, [someChecked]);

  const why = (count: number, reason: string) => (n === 0 ? NEED_SELECTION : count === 0 ? reason : undefined);
  const suffix = (count: number) => (count > 0 ? ` ${count}` : '');

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <label className="check select-all" title="全选（⌘A）">
          <input
            ref={checkRef}
            type="checkbox"
            checked={allChecked}
            disabled={p.visible.length === 0}
            onChange={() => (allChecked ? p.onClearSelection() : p.onSelectAll())}
          />
          全选
        </label>
        <button className="btn ghost sm" onClick={p.onInvert} disabled={p.visible.length === 0}>
          反选
        </button>
        <span className="sel-count">
          已选 <b>{n}</b> / {p.totalCount}
        </span>
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <button className="btn sm success" disabled={!startable.length} title={why(startable.length, '所选实例都已在运行')} onClick={() => p.onStart(startable)}>
          <Icon name="play" size={13} />
          启动{suffix(startable.length)}
        </button>
        <button className="btn sm" disabled={!stoppable.length} title={why(stoppable.length, '所选实例都未运行')} onClick={() => p.onStop(stoppable)}>
          <Icon name="stop" size={13} />
          停止{suffix(stoppable.length)}
        </button>
        <button className="btn sm" disabled={!restartable.length} title={why(restartable.length, '所选实例都未运行')} onClick={() => p.onRestart(restartable)}>
          <Icon name="restart" size={14} />
          重启
        </button>
      </div>
      <div className="toolbar-sep" />
      <div className="toolbar-group">
        <button className="btn sm" disabled={!running.length} title={why(running.length, '需要运行中的实例')} onClick={() => p.onInstallApk(running)}>
          <Icon name="package" size={14} />
          安装 APK
        </button>
        <button className="btn sm" disabled={!running.length} title={why(running.length, '需要运行中的实例')} onClick={() => p.onAppLaunch(running)}>
          <Icon name="rocket" size={14} />
          启动应用
        </button>
        <button className="btn sm" disabled={!running.length} title={why(running.length, '需要运行中的实例')} onClick={() => p.onShell(running)}>
          <Icon name="terminal" size={14} />
          Shell
        </button>
        <button className="btn sm" onClick={p.onScripts}>
          <Icon name="script" size={14} />
          运行脚本
        </button>
      </div>
      <div className="toolbar-sep" />
      <button className="btn sm danger-ghost" disabled={!all.length} title={n === 0 ? NEED_SELECTION : undefined} onClick={() => p.onDelete(all)}>
        <Icon name="trash" size={14} />
        删除
      </button>
      <div className="toolbar-spacer" />
      <div className="search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="搜索名称 / 编号 / 备注" value={p.filter} onChange={(e) => p.onFilter(e.target.value)} />
      </div>
      <div className="segmented" role="radiogroup" aria-label="视图">
        <button className={p.view === 'grid' ? 'active' : ''} onClick={() => p.onView('grid')} title="卡片视图" aria-label="卡片视图">
          <Icon name="grid" size={15} />
        </button>
        <button className={p.view === 'list' ? 'active' : ''} onClick={() => p.onView('list')} title="列表视图" aria-label="列表视图">
          <Icon name="list" size={15} />
        </button>
      </div>
    </div>
  );
}
