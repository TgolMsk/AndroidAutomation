import { useCallback, useEffect, useState } from 'react';
import type { AppPathEntry, AppPathKey, AppTemplateSetEntry } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useSelection } from '../../state/selection';

/** 「实例 #1「主号」· 模板集「万龙」93 张」 for one template set line (pure, tested). */
export function templateSetTitle(entry: AppTemplateSetEntry): string {
  const who = `实例 #${entry.index}${entry.instanceName ? `「${entry.instanceName}」` : '（实例已删除）'}`;
  if (entry.name === null) return who;
  return `${who} · 模板集「${entry.name}」${entry.templates ?? 0} 张`;
}

/**
 * Every place the assistant keeps data, plus the template set each instance uses (those live wherever the user
 * picked them). Main only opens whitelisted keys; template sets are revealed in Finder by their configured path.
 * Paths are copied through main (the renderer's clipboard permission is denied) and are selectable by hand.
 */
export function DataPathsCard() {
  const toast = useToast();
  const { gameId } = useSelection();
  const [paths, setPaths] = useState<AppPathEntry[] | null>(null);
  const [sets, setSets] = useState<AppTemplateSetEntry[] | null>(null);
  const [error, setError] = useState<string>();
  const [setsError, setSetsError] = useState<string>();

  const load = useCallback(() => {
    if (!gameId) return;
    setError(undefined);
    setSetsError(undefined);
    avdm.appPaths(gameId).then(setPaths).catch((cause: unknown) => setError(errMsg(cause)));
    avdm.appTemplateSets(gameId).then(setSets).catch((cause: unknown) => setSetsError(errMsg(cause)));
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

  async function reveal(path: string): Promise<void> {
    try { await avdm.revealPath(path); }
    catch (cause) { toast.error('无法在访达中显示模板集', errMsg(cause)); }
  }

  async function copy(path: string): Promise<void> {
    try {
      await avdm.appCopyText(path);
      toast.push({ kind: 'success', title: '路径已复制' });
    } catch (cause) {
      toast.error('复制失败', errMsg(cause));
    }
  }

  const copyButton = (label: string, path: string) => (
    <button type="button" className="icon-btn small" onClick={() => void copy(path)} aria-label={`复制「${label}」路径`} title="复制路径"><Icon name="copy" size={14} /></button>
  );

  return (
    <Card title="数据目录" icon="folder" extra={<button type="button" className="icon-btn small" onClick={load} aria-label="刷新数据目录" title="刷新"><Icon name="refresh" size={14} /></button>}>
      {error && <p className="settings-error" role="alert">读取失败：{error}<button className="btn xs" onClick={load}>重试</button></p>}
      {!paths && !error && <p className="settings-muted"><Spinner size={12} /> {gameId ? '正在读取…' : '正在载入游戏模块…'}</p>}
      {paths && (
        <ul className="settings-paths">
          {paths.map((entry) => (
            <li key={entry.key}>
              <div className="settings-path-text">
                <strong>
                  {entry.label}
                  {entry.pending ? <span className="tag" title={entry.pending}>待接入</span> : !entry.exists && <span className="tag">尚未创建</span>}
                </strong>
                <span className="mono">{entry.path}</span>
                <small>{entry.description}{entry.pending ? `（${entry.pending}）` : ''}</small>
              </div>
              <div className="settings-path-actions">
                {copyButton(entry.label, entry.path)}
                <button type="button" className="icon-btn small" onClick={() => void open(entry.key, entry.label)} aria-label={`打开「${entry.label}」`} title={entry.kind === 'file' ? '在访达中显示' : '打开目录'}><Icon name="folder" size={14} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="settings-subtitle">各实例的模板集</h3>
      {setsError && <p className="settings-error" role="alert">读取失败：{setsError}</p>}
      {!sets && !setsError && gameId && <p className="settings-muted"><Spinner size={12} /> 正在读取…</p>}
      {sets && sets.length === 0 && <p className="settings-muted">还没有实例选择模板集；在「脚本与模板 → 模板库」为实例选择或新建。</p>}
      {sets && sets.length > 0 && (
        <ul className="settings-paths">
          {sets.map((entry) => (
            <li key={entry.index}>
              <div className="settings-path-text">
                <strong>{templateSetTitle(entry)}{!entry.exists && entry.path && <span className="tag warn">目录不存在</span>}</strong>
                {entry.path && <span className="mono">{entry.path}</span>}
                {entry.error && <small className="settings-path-problem">{entry.error}</small>}
              </div>
              {entry.path && (
                <div className="settings-path-actions">
                  {copyButton(`实例 #${entry.index} 的模板集`, entry.path)}
                  <button type="button" className="icon-btn small" onClick={() => void reveal(entry.path)} disabled={!entry.exists} aria-label={`在访达中显示实例 #${entry.index} 的模板集`} title={entry.exists ? '在访达中显示' : '目录不存在'}><Icon name="folder" size={14} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
