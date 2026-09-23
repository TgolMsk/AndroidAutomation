import { displayStatusLabel, type DisplayStatus } from '../format';

export function StatusDot({ status }: { status: DisplayStatus }) {
  return <span className={`status-dot s-${status}`} aria-hidden="true" />;
}

export function StatusBadge({ status, className }: { status: DisplayStatus; className?: string }) {
  return (
    <span className={`status-badge s-${status} ${className ?? ''}`}>
      <StatusDot status={status} />
      {displayStatusLabel(status)}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />;
}
