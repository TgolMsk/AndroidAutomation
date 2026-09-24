import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppLogEntry, AppLogLevel } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { SemanticTag, type SemanticTone } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import { LOG_LEVEL_LABEL, logScopes, matchesLogFilter, mergeLogEntries, type LogFilter } from './log-view';

const LIMIT = 300;
/** Typing in the search box queries main (which may scan the rotated files) only after a pause. */
export const LOG_SEARCH_DEBOUNCE_MS = 300;
const LEVEL_TONE: Record<AppLogLevel, SemanticTone> = { debug: 'neutral', info: 'info', warn: 'warning', error: 'danger' };

/**
 * 日志: the persistent app log (`automation/logs/app.ndjson`). Newest first; new lines arrive live while the page
 * is shown. Only warnings and errors are written unless 「日志记录级别」 says otherwise.
 */
export function LogsCard({ visible = true }: Partial<ViewProps>) {
  const toast = useToast();
  const { gameId } = useSelection();
  const [filter, setFilter] = useState<LogFilter>({ minLevel: 'info', scope: '', search: '' });
  const [searchInput, setSearchInput] = useState('');
  const [entries, setEntries] = useState<AppLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [follow, setFollow] = useState(true);
  const sequence = useRef(0);

  const load = useCallback(() => {
    const id = ++sequence.current;
    setLoading(true);
    avdm.appLogs({ minLevel: filter.minLevel, ...(filter.scope ? { scope: filter.scope } : {}), ...(filter.search.trim() ? { search: filter.search.trim() } : {}), limit: LIMIT })
      .then((list) => { if (id === sequence.current) { setEntries(mergeLogEntries([], list, LIMIT)); setError(undefined); } })
      .catch((cause: unknown) => { if (id === sequence.current) setError(errMsg(cause)); })
      .finally(() => { if (id === sequence.current) setLoading(false); });
  }, [filter]);

  useEffect(() => { if (visible) load(); }, [load, visible]);

  useEffect(() => {
    const timer = setTimeout(() => setFilter((current) => (current.search === searchInput ? current : { ...current, search: searchInput })),
      LOG_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useAvdmEvent('app-log', (entry) => {
    if (!visible || !follow || !matchesLogFilter(entry, filter)) return;
    setEntries((current) => mergeLogEntries(current, [entry], LIMIT));
  });

  async function openDir(): Promise<void> {
    try { await avdm.openAppPath(gameId, 'logs'); }
    catch (cause) { toast.error('无法打开日志目录', errMsg(cause)); }
  }

  const scopes = logScopes(entries);
  return (
    <Card
      title="日志" icon="log"
      extra={(
        <>
          <button type="button" className="btn sm" onClick={load} disabled={loading}>{loading ? <Spinner size={12} /> : <Icon name="refresh" size={14} />}刷新</button>
          <button type="button" className="btn sm" onClick={() => void openDir()} disabled={!gameId}><Icon name="folder" size={14} />打开日志目录</button>
        </>
      )}
    >
      <div className="settings-log-filters">
        <label>级别
          <select value={filter.minLevel} onChange={(event) => setFilter((current) => ({ ...current, minLevel: event.target.value as AppLogLevel }))}>
            <option value="debug">全部</option>
            <option value="info">信息及以上</option>
            <option value="warn">警告及以上</option>
            <option value="error">仅错误</option>
          </select>
        </label>
        <label>来源
          <select value={filter.scope} onChange={(event) => setFilter((current) => ({ ...current, scope: event.target.value }))}>
            <option value="">全部来源</option>
            {[...new Set([...scopes, ...(filter.scope ? [filter.scope] : [])])].map((scope) => <option key={scope} value={scope}>{scope}</option>)}
          </select>
        </label>
        <label className="settings-log-search">搜索
          <input type="search" value={searchInput} placeholder="日志内容" onChange={(event) => setSearchInput(event.target.value)} />
        </label>
        <label className="check"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />实时追加</label>
      </div>
      {error && <p className="settings-error" role="alert">读取日志失败：{error}</p>}
      {entries.length === 0 && !loading && !error && <p className="settings-muted">没有符合条件的日志。警告与错误会自动记录在这里。</p>}
      {entries.length > 0 && (
        <ol className="settings-log-list" aria-live="polite">
          {entries.map((entry) => (
            <li key={`${entry.ts}-${entry.scope}-${entry.message}`} className={`is-${entry.level}`}>
              <span className="mono settings-log-time" title={beijingTime(entry.ts, 'full')}>{beijingTime(entry.ts, 'short')}</span>
              <SemanticTag tone={LEVEL_TONE[entry.level]}>{LOG_LEVEL_LABEL[entry.level]}</SemanticTag>
              <span className="settings-log-scope">{entry.scope}{entry.index !== undefined ? ` · 实例 #${entry.index}` : ''}</span>
              <p className="settings-log-message">{entry.message}</p>
              {entry.data && <details className="settings-log-data"><summary>附加数据</summary><pre className="mono">{JSON.stringify(entry.data, null, 2)}</pre></details>}
            </li>
          ))}
        </ol>
      )}
      <p className="settings-muted">时间为北京时间；日志文件按大小轮换，最多保留约 20 MB。</p>
    </Card>
  );
}
