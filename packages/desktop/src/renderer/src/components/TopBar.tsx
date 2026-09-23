import type { HostStats } from '@avdm/core';
import { formatMb } from '../format';
import { Icon, type IconName } from './Icon';

function Stat({ icon, label, value, sub, tone, title }: { icon: IconName; label: string; value: string; sub?: string; tone?: 'ok' | 'warn' | 'bad'; title?: string }) {
  return (
    <div className={`stat${tone ? ` tone-${tone}` : ''}`} title={title}>
      <Icon name={icon} size={15} />
      <div className="stat-text">
        <span className="stat-label">{label}</span>
        <span className="stat-value">
          {value}
          {sub && <span className="stat-sub"> {sub}</span>}
        </span>
      </div>
    </div>
  );
}

export function TopBar({
  stats,
  maxRunning,
  memoryReserveMb,
  onCreate,
  onScripts,
  onSettings,
  createDisabled,
}: {
  stats?: HostStats;
  maxRunning?: number;
  memoryReserveMb?: number;
  onCreate: () => void;
  onScripts: () => void;
  onSettings: () => void;
  createDisabled?: boolean;
}) {
  const memTone: 'ok' | 'warn' | 'bad' | undefined = !stats
    ? undefined
    : stats.memoryPressure === 'critical'
      ? 'bad'
      : stats.memoryPressure === 'warn' || (memoryReserveMb !== undefined && stats.availableMemMb < memoryReserveMb)
        ? 'warn'
        : 'ok';
  const load = stats?.loadAvg[0];
  const loadTone = stats && load !== undefined ? (load > stats.cpuCount ? 'bad' : load > stats.cpuCount * 0.7 ? 'warn' : undefined) : undefined;
  const running = stats?.runningInstances;
  const runTone = running !== undefined && maxRunning !== undefined && running >= maxRunning ? 'warn' : undefined;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="devices" size={20} />
        </span>
        <span className="brand-copy">
          <span className="brand-name">AVD</span>
          <span className="brand-subtitle">多开管理器</span>
        </span>
      </div>
      <div className="stats">
        <Stat icon="power" label="运行中" value={running !== undefined ? String(running) : '—'} sub={maxRunning !== undefined ? `/ ${maxRunning}` : undefined} tone={runTone} />
        <Stat
          icon="memory"
          label="可用内存"
          value={stats ? formatMb(stats.availableMemMb) : '—'}
          sub={stats ? `/ ${formatMb(stats.totalMemMb)}` : undefined}
          tone={memTone}
          title={
            stats
              ? `内存压力：${stats.memoryPressure === 'critical' ? '严重' : stats.memoryPressure === 'warn' ? '偏高' : '正常'}${memoryReserveMb !== undefined ? `；为系统保留 ${formatMb(memoryReserveMb)}` : ''}`
              : undefined
          }
        />
        <Stat icon="layers" label="实例已分配" value={stats ? formatMb(stats.committedInstanceRamMb) : '—'} />
        <Stat
          icon="gauge"
          label="负载"
          value={load !== undefined ? load.toFixed(2) : '—'}
          sub={stats ? `/ ${stats.cpuCount} 核` : undefined}
          tone={loadTone}
          title={stats ? `1/5/15 分钟平均负载：${stats.loadAvg.map((l) => l.toFixed(2)).join(' / ')}\n${stats.cpuModel}` : undefined}
        />
      </div>
      <div className="topbar-actions">
        <button className="btn ghost topbar-link" onClick={onScripts}>
          <Icon name="script" />
          脚本
        </button>
        <span className="topbar-action-sep" aria-hidden="true" />
        <button className="btn primary" onClick={onCreate} disabled={createDisabled} title="新建实例（⌘N）">
          <Icon name="plus" />
          新建实例
        </button>
        <button className="icon-btn lg" onClick={onSettings} title="设置" aria-label="设置">
          <Icon name="settings" size={18} />
        </button>
      </div>
    </header>
  );
}
