import type { InstanceState } from '@avdm/core';
import { canStart, canStop, displayStatus, formatTime, hasScreen, shortImageLabel, specSummary } from '../format';
import { Icon } from './Icon';
import { EditableName, InstanceCard, instanceMenuItems, type InstanceActions } from './InstanceCard';
import { DropdownMenu } from './Menu';
import type { ViewMode } from './Toolbar';
import { Spinner, StatusBadge } from './StatusBadge';

export interface InstanceGridProps {
  instances: InstanceState[];
  view: ViewMode;
  selected: ReadonlySet<number>;
  thumbs: ReadonlyMap<number, string>;
  busy: ReadonlyMap<number, string>;
  actions: InstanceActions;
}

export function InstanceGrid({ instances, view, selected, thumbs, busy, actions }: InstanceGridProps) {
  if (view === 'list') return <InstanceTable instances={instances} selected={selected} busy={busy} actions={actions} />;
  return (
    <div className="grid">
      {instances.map((s) => (
        <InstanceCard
          key={s.record.index}
          state={s}
          selected={selected.has(s.record.index)}
          thumbUrl={thumbs.get(s.record.index)}
          busy={busy.get(s.record.index)}
          actions={actions}
        />
      ))}
    </div>
  );
}

function InstanceTable({
  instances,
  selected,
  busy,
  actions,
}: {
  instances: InstanceState[];
  selected: ReadonlySet<number>;
  busy: ReadonlyMap<number, string>;
  actions: InstanceActions;
}) {
  return (
    <div className="table-wrap">
      <table className="inst-table">
        <thead>
          <tr>
            <th className="col-check" />
            <th className="col-index">#</th>
            <th>名称</th>
            <th>状态</th>
            <th>Serial</th>
            <th>规格</th>
            <th>镜像</th>
            <th>PID</th>
            <th>启动时间</th>
            <th className="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((s) => {
            const i = s.record.index;
            const b = busy.get(i);
            return (
              <tr key={i} className={selected.has(i) ? 'selected' : undefined} onClick={(e) => actions.toggleSelect(i, e.shiftKey)}>
                <td className="col-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(i)} onChange={() => actions.toggleSelect(i)} aria-label={`选择 #${i}`} />
                </td>
                <td className="col-index mono">{i}</td>
                <td>
                  <EditableName name={s.record.name} onSave={(name) => actions.rename(i, name)} />
                </td>
                <td>
                  <StatusBadge status={displayStatus(s)} />
                </td>
                <td className="mono">{s.ports.serial}</td>
                <td className="dim">{specSummary(s.record.spec)}</td>
                <td className="dim" title={s.record.image}>
                  {shortImageLabel(s.record.image)}
                </td>
                <td className="mono dim">{s.pid ?? '—'}</td>
                <td className="dim">{s.startedAt ? formatTime(s.startedAt) : '—'}</td>
                <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                  <div className="row-actions">
                    {b ? (
                      <button className="btn xs" disabled>
                        <Spinner size={11} />
                        {b}
                      </button>
                    ) : canStart(s) ? (
                      <button className="btn xs success" onClick={() => actions.start([i])}>
                        启动
                      </button>
                    ) : (
                      <button className="btn xs" onClick={() => actions.stop([i])} disabled={!canStop(s)}>
                        停止
                      </button>
                    )}
                    <button className="icon-btn" title="实时画面" aria-label="实时画面" disabled={!hasScreen(s)} onClick={() => actions.openLive(i)}>
                      <Icon name="screen" size={15} />
                    </button>
                    <DropdownMenu trigger={<Icon name="more" size={16} />} title="更多" items={instanceMenuItems(s, actions)} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
