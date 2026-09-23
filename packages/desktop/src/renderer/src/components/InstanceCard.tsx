import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { InstanceState, StartOptions, StopOptions } from '@avdm/core';
import { canStart, canStop, displayStatus, hasScreen, isActive, isRunning, shortImageLabel, specSummary, type DisplayStatus } from '../format';
import { Icon } from './Icon';
import { DropdownMenu, type MenuItem } from './Menu';
import { Spinner, StatusBadge } from './StatusBadge';

/** Per-instance operations, implemented by MainView. */
export interface InstanceActions {
  toggleSelect: (index: number, range?: boolean) => void;
  start: (indices: number[], opts?: StartOptions) => void;
  stop: (indices: number[], opts?: StopOptions) => void;
  restart: (indices: number[]) => void;
  openLive: (index: number) => void;
  openScrcpy: (index: number) => void;
  screenshot: (index: number) => void;
  clone: (index: number) => void;
  edit: (index: number) => void;
  logs: (index: number) => void;
  remove: (indices: number[]) => void;
  rename: (index: number, name: string) => Promise<void>;
}

export function instanceMenuItems(state: InstanceState, actions: InstanceActions): MenuItem[] {
  const i = state.record.index;
  const stopped = state.status === 'stopped' || state.status === 'error';
  return [
    { label: '截图保存', icon: 'camera', onClick: () => actions.screenshot(i), disabled: !isRunning(state) },
    {
      label: state.record.spec.headless ? '带窗口启动' : '无窗口启动',
      icon: 'play',
      onClick: () => actions.start([i], { headless: !state.record.spec.headless }),
      disabled: !canStart(state),
      hint: '仅本次启动生效',
    },
    {
      label: '强制启动',
      icon: 'play',
      onClick: () => actions.start([i], { force: true }),
      disabled: !canStart(state),
      hint: '忽略最大运行数与内存保留检查',
    },
    { label: '强制停止', icon: 'stop', onClick: () => actions.stop([i], { force: true }), disabled: state.status === 'stopped', hint: '直接结束进程（不保存快照）' },
    { label: '克隆', icon: 'copy', onClick: () => actions.clone(i), disabled: !stopped || !!state.record.provisioning, divider: true, hint: stopped ? undefined : '需先停止实例' },
    { label: '编辑配置', icon: 'edit', onClick: () => actions.edit(i) },
    { label: '查看日志', icon: 'log', onClick: () => actions.logs(i) },
    { label: '删除', icon: 'trash', onClick: () => actions.remove([i]), danger: true, divider: true },
  ];
}

function placeholderText(s: DisplayStatus): string {
  switch (s) {
    case 'provisioning':
      return '正在准备磁盘…';
    case 'starting':
      return '正在启动模拟器…';
    case 'booting':
      return 'Android 开机中…';
    case 'running':
      return '正在获取画面…';
    case 'stopping':
      return '正在停止…';
    case 'error':
      return '实例异常';
    default:
      return '已停止';
  }
}

export function EditableName({ name, onSave }: { name: string; onSave: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const next = text.trim();
    if (next && next !== name) void onSave(next);
    else setText(name);
  };
  if (!editing) {
    return (
      <span
        className="inst-name"
        title="双击重命名"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setText(name);
          setEditing(true);
        }}
      >
        {name}
      </span>
    );
  }
  return (
    <input
      ref={input}
      className="inst-name-input"
      value={text}
      maxLength={60}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setText(name);
          setEditing(false);
        }
      }}
    />
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

export const InstanceCard = memo(function InstanceCard({
  state,
  selected,
  thumbUrl,
  busy,
  actions,
}: {
  state: InstanceState;
  selected: boolean;
  thumbUrl?: string;
  busy?: string;
  actions: InstanceActions;
}) {
  const { record } = state;
  const i = record.index;
  const ds = displayStatus(state);
  const screen = hasScreen(state);
  const showThumb = screen && !!thumbUrl;
  const transitional = ds === 'provisioning' || ds === 'starting' || ds === 'booting' || ds === 'stopping' || (ds === 'running' && !thumbUrl);
  const aspect = record.spec.width / record.spec.height;

  return (
    <div
      className={`card s-${ds}${selected ? ' selected' : ''}`}
      onClick={(e) => actions.toggleSelect(i, e.shiftKey)}
      aria-selected={selected}
    >
      <div className="card-thumb" onDoubleClick={() => screen && actions.openLive(i)} title={screen ? '双击打开实时画面' : undefined}>
        {showThumb ? (
          <img src={thumbUrl} alt="" draggable={false} className={aspect < 1 ? 'portrait' : undefined} />
        ) : (
          <div className="thumb-placeholder">
            <span className="thumb-glyph">{transitional ? <Spinner size={20} /> : <Icon name={ds === 'error' ? 'alert' : 'devices'} size={27} />}</span>
            <span>{placeholderText(ds)}</span>
          </div>
        )}
        <label className="card-check" onClick={stop} title="选择">
          <input type="checkbox" checked={selected} aria-label={`选择 ${record.name} #${i}`} onChange={() => actions.toggleSelect(i)} />
        </label>
        <StatusBadge status={ds} className="card-status" />
        {screen && (
          <button
            className="thumb-live-btn"
            onClick={(e) => {
              e.stopPropagation();
              actions.openLive(i);
            }}
          >
            <Icon name="screen" size={14} />
            实时画面
          </button>
        )}
      </div>
      <div className="card-body">
        <div className="card-title-row">
          <EditableName name={record.name} onSave={(name) => actions.rename(i, name)} />
          <span className="inst-index">#{i}</span>
        </div>
        <div className="card-meta" title={record.image}>
          <span className="mono">{state.ports.serial}</span>
          <span className="dot-sep">·</span>
          <span>{shortImageLabel(record.image)}</span>
        </div>
        <div className="card-meta">{specSummary(record.spec)}</div>
        {state.status === 'error' && state.error ? (
          <div className="card-error" title={state.error}>
            {state.error.split('\n').find((l) => l.trim()) ?? state.error}
          </div>
        ) : record.notes ? (
          <div className="card-notes" title={record.notes}>
            {record.notes}
          </div>
        ) : null}
        <div className="card-actions" onClick={stop}>
          {busy ? (
            <button className="btn sm" disabled>
              <Spinner size={12} />
              {busy}
            </button>
          ) : canStart(state) ? (
            <button className="btn sm success" onClick={() => actions.start([i])}>
              <Icon name="play" size={12} />
              启动
            </button>
          ) : (
            <button className="btn sm" onClick={() => actions.stop([i])} disabled={!canStop(state)}>
              <Icon name="stop" size={12} />
              停止
            </button>
          )}
          <button className="icon-btn" title="重启" aria-label="重启" disabled={!!busy || !isActive(state) || state.status === 'stopping'} onClick={() => actions.restart([i])}>
            <Icon name="restart" />
          </button>
          <button className="icon-btn" title="实时画面" aria-label="实时画面" disabled={!screen} onClick={() => actions.openLive(i)}>
            <Icon name="screen" />
          </button>
          <button className="icon-btn" title="用 scrcpy 打开" aria-label="scrcpy" disabled={!isRunning(state)} onClick={() => actions.openScrcpy(i)}>
            <Icon name="cast" />
          </button>
          <div className="card-actions-spacer" />
          <DropdownMenu trigger={<Icon name="more" size={18} />} title="更多" items={instanceMenuItems(state, actions)} />
        </div>
      </div>
    </div>
  );
});
