import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@avdm/automation/script';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { clearRunLogs, LOG_RING_CAPACITY, mergeRunLogHistory, useRunLogCounters, useRunLogs } from '../../state/run-log-store';
import { logClock, shortData } from './run-rows';

const LEVEL_LABEL: Record<LogLevel, string> = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
const LEVEL_FILTERS: Array<{ value: LogLevel; label: string }> = [
  { value: 'debug', label: '全部' },
  { value: 'info', label: '信息以上' },
  { value: 'warn', label: '警告以上' },
  { value: 'error', label: '仅错误' },
];
/** Within this many px of the bottom counts as "at the bottom" (follow keeps tailing). */
const BOTTOM_SLACK = 24;

function LogRow({ entry, onShot }: { entry: LogEntry; onShot: (entry: LogEntry) => void }) {
  const data = shortData(entry.data);
  return (
    <div className={`runs-log-row is-${entry.level}`}>
      <span className="runs-log-time">{logClock(entry.ts)}</span>
      <span className="runs-log-level">{LEVEL_LABEL[entry.level]}</span>
      <span className="runs-log-scope">[{entry.scope}]</span>
      {entry.instanceIndex !== null && <span className="runs-log-instance">#{entry.instanceIndex}</span>}
      {entry.stepId && <span className="runs-log-step">{entry.stepId}</span>}
      <span className="runs-log-message">
        {entry.message}
        {data && <span className="runs-log-data" title={data.full}>{data.short}</span>}
      </span>
      {entry.shot && <button className="link-btn runs-log-shot" onClick={() => onShot(entry)}><Icon name="camera" size={13} />留痕</button>}
    </div>
  );
}

/**
 * Live log of one run (wanlong-panel LogPane): lines come from the shared ring (live pushes) and "载入历史" merges
 * the stored ndjson. Only the newest 2000 lines are kept, never the whole log in React state.
 */
export function RunLogPane({ gameId, runId }: { gameId: string; runId: string }) {
  const toast = useToast();
  const [minLevel, setMinLevel] = useState<LogLevel>('info');
  const [keyword, setKeyword] = useState('');
  const [follow, setFollow] = useState(true);
  const [loading, setLoading] = useState(false);
  const [shot, setShot] = useState<{ url: string; title: string } | null>(null);
  const [shotLoading, setShotLoading] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const filter = useMemo(() => ({ runId, minLevel, keyword: keyword.trim() }), [runId, minLevel, keyword]);
  const lines = useRunLogs(filter);
  const counters = useRunLogCounters();

  useEffect(() => { setFollow(true); atBottom.current = true; }, [runId]);

  // Like followOutput 'auto': tail only while the reader is at the bottom; scrolling up pauses it on its own.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && follow && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines, follow]);

  // The shot's object URL is released when the viewer closes or the pane goes away.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  async function loadHistory(): Promise<void> {
    if (loading) return;
    setLoading(true);
    try {
      const entries = await avdm.runLogs(gameId, { runId, minLevel, limit: LOG_RING_CAPACITY });
      const added = mergeRunLogHistory(entries);
      toast.push({ kind: 'success', title: `已载入 ${added} 条历史日志` });
    } catch (error) {
      toast.error('读取历史日志失败', errMsg(error));
    } finally { setLoading(false); }
  }

  async function openShot(entry: LogEntry): Promise<void> {
    if (!entry.shot || !entry.runId || shotLoading) return;
    setShotLoading(true);
    try {
      const bytes = await avdm.runShot(gameId, entry.runId, entry.shot);
      const type = entry.shot.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      setShot({ url, title: `${logClock(entry.ts)}｜${entry.message}` });
    } catch (error) {
      toast.error('读取留痕截图失败', errMsg(error));
    } finally { setShotLoading(false); }
  }

  return (
    <div className="runs-log">
      <div className="runs-log-toolbar">
        <div className="segmented" role="group" aria-label="日志级别">
          {LEVEL_FILTERS.map((item) => (
            <button key={item.value} className={minLevel === item.value ? 'active' : ''} aria-pressed={minLevel === item.value} onClick={() => setMinLevel(item.value)}>{item.label}</button>
          ))}
        </div>
        <input className="runs-log-search" value={keyword} onChange={(event) => setKeyword(event.target.value)}
          placeholder="按内容 / 模块 / 步骤 id 过滤" aria-label="过滤日志" />
        <label className="check small"><input type="checkbox" checked={follow} onChange={(event) => { setFollow(event.target.checked); atBottom.current = true; }} />自动贴底</label>
        <button className="btn xs" onClick={() => void loadHistory()} disabled={loading}>{loading ? <Spinner size={12} /> : <Icon name="refresh" size={13} />}载入历史</button>
        <button className="btn xs ghost" onClick={() => clearRunLogs(runId)}><Icon name="trash" size={13} />清空</button>
        <span className="runs-log-count">显示 {lines.length} / 缓冲 {counters.total} 行（上限 {LOG_RING_CAPACITY}）</span>
        {counters.error > 0 && <span className="tag runs-tag-bad">错误 {counters.error}</span>}
        {counters.warn > 0 && <span className="tag warn">警告 {counters.warn}</span>}
      </div>
      <div ref={list} className="runs-log-list" role="log" aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
        }}>
        {lines.length === 0
          ? <p className="runs-log-empty">这次执行还没有日志。执行开始后实时日志会自动出现，更早的日志点「载入历史」。</p>
          : lines.map((entry, i) => <LogRow key={`${entry.ts}-${i}`} entry={entry} onShot={(item) => void openShot(item)} />)}
      </div>
      {shotLoading && <p className="runs-muted"><Spinner size={12} /> 正在读取留痕截图…</p>}
      {shot && (
        <Modal title="留痕截图" subtitle={shot.title} width={940} onClose={() => setShot(null)}>
          <img className="runs-shot-image" src={shot.url} alt="留痕截图" />
        </Modal>
      )}
    </div>
  );
}
