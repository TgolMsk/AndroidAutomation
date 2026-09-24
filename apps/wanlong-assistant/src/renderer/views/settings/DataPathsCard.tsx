import { useCallback, useEffect, useState } from 'react';
import type { AppPathEntry, AppPathKey } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useSelection } from '../../state/selection';

/** Every place the assistant keeps data, with copy and open buttons (main only accepts these keys, never a path). */
export function DataPathsCard() {
  const toast = useToast();
  const { gameId } = useSelection();
  const [paths, setPaths] = useState<AppPathEntry[] | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    if (!gameId) return;
    setError(undefined);
    avdm.appPaths(gameId).then(setPaths).catch((cause: unknown) => setError(errMsg(cause)));
  }, [gameId]);
  useEffect(load, [load]);

  async function open(key: AppPathKey, label: string): Promise<void> {
    try {
      await avdm.openAppPath(gameId, key);
      load();
    } catch (cause) {
      toast.error(`无法打开「${label}」`, errMsg(cause));
    }
  }

  async function copy(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      toast.push({ kind: 'success', title: '路径已复制' });
    } catch (cause) {
      toast.error('复制失败', errMsg(cause));
    }
  }

  return (
    <Card title="数据目录" icon="folder" extra={<button type="button" className="icon-btn small" onClick={load} aria-label="刷新数据目录" title="刷新"><Icon name="refresh" size={14} /></button>}>
      {error && <p className="settings-error" role="alert">读取失败：{error}<button className="btn xs" onClick={load}>重试</button></p>}
      {!paths && !error && <p className="settings-muted"><Spinner size={12} /> {gameId ? '正在读取…' : '正在载入游戏模块…'}</p>}
      {paths && (
        <ul className="settings-paths">
          {paths.map((entry) => (
            <li key={entry.key}>
              <div className="settings-path-text">
                <strong>{entry.label}{!entry.exists && <span className="tag">尚未创建</span>}</strong>
                <span className="mono" title={entry.path}>{entry.path}</span>
                <small>{entry.description}</small>
              </div>
              <div className="settings-path-actions">
                <button type="button" className="icon-btn small" onClick={() => void copy(entry.path)} aria-label={`复制「${entry.label}」路径`} title="复制路径"><Icon name="copy" size={14} /></button>
                <button type="button" className="icon-btn small" onClick={() => void open(entry.key, entry.label)} aria-label={`打开「${entry.label}」`} title={entry.kind === 'file' ? '在访达中显示' : '打开目录'}><Icon name="folder" size={14} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
