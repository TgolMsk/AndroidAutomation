import { useState } from 'react';
import type { BatchResult } from '../../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';
import { useToast } from '../Toasts';

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function InstallApkDialog({
  initialPaths,
  targets,
  nameOf,
  onClose,
}: {
  initialPaths: string[];
  targets: number[];
  nameOf: (index: number) => string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [paths, setPaths] = useState(initialPaths);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult<string>[]>();

  const addMore = async () => {
    try {
      const more = await avdm.pickApks();
      setPaths((prev) => [...prev, ...more.filter((p) => !prev.includes(p))]);
    } catch (err) {
      toast.error('无法打开文件选择框', errMsg(err));
    }
  };

  const install = async () => {
    setBusy(true);
    setResults(undefined);
    try {
      const res = await avdm.installApk(targets, paths);
      setResults(res);
      toast.batch('安装 APK', res, nameOf);
    } catch (err) {
      toast.error('安装 APK 失败', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="安装 APK"
      subtitle={`目标：${targets.length} 个运行中的实例`}
      onClose={onClose}
      busy={busy}
      width={560}
      footer={
        <>
          <button className="btn footer-left" onClick={() => void addMore()} disabled={busy}>
            <Icon name="plus" />
            添加文件…
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            {results ? '完成' : '取消'}
          </button>
          <button className="btn primary" onClick={() => void install()} disabled={busy || paths.length === 0 || targets.length === 0}>
            {busy ? <Spinner size={12} /> : <Icon name="package" />}
            {busy ? '正在安装…' : results ? '重新安装' : '安装'}
          </button>
        </>
      }
    >
      <div className="field-label">安装包（{paths.length}）</div>
      <ul className="file-list">
        {paths.map((p) => (
          <li key={p} title={p}>
            <Icon name="package" size={14} />
            <span className="file-name">{baseName(p)}</span>
            <span className="file-dir">{p.slice(0, Math.max(0, p.length - baseName(p).length - 1))}</span>
            <button className="icon-btn small" onClick={() => setPaths((prev) => prev.filter((x) => x !== p))} disabled={busy} aria-label="移除">
              <Icon name="close" size={13} />
            </button>
          </li>
        ))}
        {paths.length === 0 && <li className="empty">未选择文件</li>}
      </ul>
      <div className="field-label" style={{ marginTop: 14 }}>
        目标实例
      </div>
      <div className="chips">
        {targets.map((i) => {
          const r = results?.find((x) => x.index === i);
          return (
            <span key={i} className={`chip${r ? (r.ok ? ' ok' : ' bad') : ''}`} title={r && !r.ok ? r.error : undefined}>
              {r && <Icon name={r.ok ? 'check' : 'alert'} size={12} />}
              {nameOf(i)} #{i}
            </span>
          );
        })}
      </div>
      {results?.some((r) => !r.ok) && (
        <div className="result-list">
          {results
            .filter((r): r is Extract<BatchResult<string>, { ok: false }> => !r.ok)
            .map((r) => (
              <div key={r.index} className="result-item bad">
                <b>
                  {nameOf(r.index)} #{r.index}
                </b>
                ：{r.error}
              </div>
            ))}
        </div>
      )}
      <div className="hint block">只会安装到运行中的实例；已安装的同名应用将被覆盖更新。</div>
    </Modal>
  );
}
