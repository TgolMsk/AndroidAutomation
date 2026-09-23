import { useEffect, useMemo, useState } from 'react';
import { avdm, errMsg } from '../../api';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';
import { useToast } from '../Toasts';

const RECENT_KEY = 'avdm.recentPackages';
const PKG_RE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

function loadRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveRecent(pkg: string): void {
  try {
    const next = [pkg, ...loadRecent().filter((p) => p !== pkg)].slice(0, 10);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable; not important
  }
}

export function AppLaunchDialog({ targets, nameOf, onClose }: { targets: number[]; nameOf: (index: number) => string; onClose: () => void }) {
  const toast = useToast();
  const [pkg, setPkg] = useState('');
  const [packages, setPackages] = useState<string[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(true);
  const [pkgError, setPkgError] = useState<string>();
  const [busy, setBusy] = useState<'start' | 'stop'>();
  const recent = useMemo(loadRecent, []);
  const first = targets[0];

  useEffect(() => {
    if (first === undefined) return;
    let alive = true;
    avdm
      .listPackages(first)
      .then((list) => alive && setPackages(list))
      .catch((err: unknown) => alive && setPkgError(errMsg(err)))
      .finally(() => alive && setLoadingPkgs(false));
    return () => {
      alive = false;
    };
  }, [first]);

  const suggestions = useMemo(() => {
    const q = pkg.trim().toLowerCase();
    const all = [...recent, ...packages.filter((p) => !recent.includes(p))];
    return (q ? all.filter((p) => p.toLowerCase().includes(q)) : all).slice(0, 80);
  }, [pkg, packages, recent]);

  const valid = PKG_RE.test(pkg.trim());

  const run = async (kind: 'start' | 'stop') => {
    const name = pkg.trim();
    setBusy(kind);
    try {
      const res = kind === 'start' ? await avdm.startApp(targets, name) : await avdm.stopApp(targets, name);
      saveRecent(name);
      toast.batch(kind === 'start' ? `启动 ${name}` : `停止 ${name}`, res, nameOf);
      if (res.every((r) => r.ok)) onClose();
    } catch (err) {
      toast.error(kind === 'start' ? '启动应用失败' : '停止应用失败', errMsg(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Modal
      title="启动应用"
      subtitle={`目标：${targets.map((i) => `${nameOf(i)} #${i}`).join('、')}`}
      onClose={onClose}
      busy={!!busy}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={!!busy}>
            取消
          </button>
          <button className="btn" onClick={() => void run('stop')} disabled={!!busy || !valid}>
            {busy === 'stop' ? <Spinner size={12} /> : <Icon name="stop" size={12} />}
            停止应用
          </button>
          <button className="btn primary" onClick={() => void run('start')} disabled={!!busy || !valid}>
            {busy === 'start' ? <Spinner size={12} /> : <Icon name="rocket" />}
            启动应用
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">应用包名</span>
        <input
          type="text"
          value={pkg}
          placeholder="例如 com.android.settings"
          spellCheck={false}
          onChange={(e) => setPkg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && valid && !busy) void run('start');
          }}
        />
      </label>
      <div className="field-label" style={{ marginTop: 12 }}>
        {loadingPkgs ? (
          <>
            <Spinner size={11} /> 正在读取 #{first} 的已安装应用…
          </>
        ) : pkgError ? (
          `无法读取应用列表：${pkgError}`
        ) : (
          `已安装应用（第三方优先，来自 #${first}）`
        )}
      </div>
      <div className="pkg-list">
        {suggestions.map((p) => (
          <button key={p} className={`pkg-item${p === pkg ? ' active' : ''}`} onClick={() => setPkg(p)} onDoubleClick={() => void run('start')}>
            {recent.includes(p) && <span className="pkg-tag">最近</span>}
            <span className="mono">{p}</span>
          </button>
        ))}
        {!loadingPkgs && suggestions.length === 0 && <div className="empty">没有匹配的应用</div>}
      </div>
    </Modal>
  );
}
