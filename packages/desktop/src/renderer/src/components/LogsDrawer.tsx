import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import { avdm, errMsg } from '../api';
import { Icon } from './Icon';
import { Spinner, StatusBadge } from './StatusBadge';
import { displayStatus } from '../format';

const LINES = 500;
const AUTO_REFRESH_MS = 2000;

function lineClass(line: string): string | undefined {
  if (/\b(ERROR|FATAL|error:|panic)\b/i.test(line)) return 'log-error';
  if (/\b(WARNING|WARN|warning:)\b/i.test(line)) return 'log-warn';
  return undefined;
}

export function LogsDrawer({ state, home, onClose }: { state: InstanceState; home?: string; onClose: () => void }) {
  const index = state.record.index;
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [auto, setAuto] = useState(state.status !== 'stopped');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const l = await avdm.instanceLog(index, LINES);
      setLines(l);
      setError(undefined);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [index]);

  useEffect(() => {
    setLoading(true);
    stick.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const logFile = home ? `${home.replace(/\/+$/, '')}/logs/instance-${index}.log` : undefined;

  return (
    <aside className="drawer" role="complementary" aria-label="实例日志">
      <div className="drawer-head">
        <div className="drawer-title">
          <Icon name="log" />
          <span>
            日志 · {state.record.name} #{index}
          </span>
          <StatusBadge status={displayStatus(state)} />
        </div>
        <div className="drawer-actions">
          <label className="check small">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自动刷新
          </label>
          <button className="icon-btn" onClick={() => void load()} title="刷新" aria-label="刷新">
            <Icon name="refresh" />
          </button>
          {logFile && (
            <button className="icon-btn" onClick={() => void avdm.revealPath(logFile)} title="在 Finder 中显示" aria-label="在 Finder 中显示">
              <Icon name="folder" />
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div
        className="drawer-body mono"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {loading && (
          <div className="empty">
            <Spinner /> 读取日志…
          </div>
        )}
        {error && <div className="empty bad">{error}</div>}
        {!loading && !error && lines.length === 0 && <div className="empty">日志为空</div>}
        {lines.map((line, i) => (
          <div key={i} className={`log-line ${lineClass(line) ?? ''}`}>
            {line || ' '}
          </div>
        ))}
      </div>
      <div className="drawer-foot">最近 {LINES} 行 · 模拟器 stdout/stderr</div>
    </aside>
  );
}
