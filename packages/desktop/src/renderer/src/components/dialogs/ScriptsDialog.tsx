import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ScriptManifest, ScriptRunInfo, ScriptRunStatus } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { formatTime, splitArgs } from '../../format';
import type { ScriptOutputStore } from '../../hooks/scriptOutputStore';
import type { ScriptRunsStore } from '../../hooks/useScriptRuns';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { Spinner } from '../StatusBadge';
import { useToast } from '../Toasts';

const RUN_STATUS: Record<ScriptRunStatus, string> = {
  running: '运行中',
  exited: '已完成',
  failed: '失败',
  stopped: '已停止',
};

/** Only this view re-renders when output arrives (throttled by the store). */
function RunOutput({ store, runId }: { store: ScriptOutputStore; runId: string }) {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const lines = store.output(runId);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version, lines, runId]);
  return (
    <pre
      ref={box}
      className="run-output mono"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length ? lines.join('\n') : '（本次会话中还没有收到输出；完整日志见日志文件）'}
    </pre>
  );
}

export function ScriptsDialog({
  targets,
  nameOf,
  store,
  onClose,
}: {
  /** Selected running instances. */
  targets: number[];
  nameOf: (index: number) => string;
  store: ScriptRunsStore;
  onClose: () => void;
}) {
  const toast = useToast();
  const [scripts, setScripts] = useState<ScriptManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [scriptId, setScriptId] = useState<string>();
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeRun, setActiveRun] = useState<string>();
  const { refresh: refreshRuns } = store;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await avdm.listScripts();
      setScripts(list);
      setLoadError(undefined);
      setScriptId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id));
    } catch (err) {
      setLoadError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshRuns();
  }, [load, refreshRuns]);

  const selected = scripts.find((s) => s.id === scriptId);
  const run = store.runs.find((r) => r.runId === activeRun) ?? store.runs[0];

  const start = async () => {
    if (!scriptId) return;
    setBusy(true);
    try {
      const runs = await avdm.runScript(scriptId, targets, splitArgs(args));
      if (runs.length === 0) toast.push({ kind: 'warn', title: '没有可运行的实例', detail: '脚本只会在运行中的实例上执行' });
      else {
        toast.push({ kind: 'success', title: `已在 ${runs.length} 个实例上启动脚本「${selected?.name ?? scriptId}」` });
        setActiveRun(runs[0]?.runId);
      }
      void refreshRuns();
    } catch (err) {
      toast.error('运行脚本失败', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const createExample = async () => {
    try {
      const m = await avdm.createExampleScript();
      toast.push({ kind: 'success', title: `已生成示例脚本「${m.name}」`, detail: m.dir, action: { label: '在 Finder 中显示', onClick: () => void avdm.revealPath(m.dir) } });
      await load();
      setScriptId(m.id);
    } catch (err) {
      toast.error('生成示例失败', errMsg(err));
    }
  };

  const stopRun = async (r: ScriptRunInfo) => {
    try {
      await avdm.stopScript(r.runId);
    } catch (err) {
      toast.error('停止脚本失败', errMsg(err));
    }
  };

  return (
    <Modal
      title="脚本"
      subtitle="任意语言的脚本插件：每个实例一个进程，环境变量提供 ANDROID_SERIAL / AVDM_ADB 等"
      onClose={onClose}
      width={900}
      className="scripts-modal"
      footer={
        <>
          <button className="btn footer-left" onClick={() => void avdm.openScriptsDir().catch((e: unknown) => toast.error('无法打开脚本目录', errMsg(e)))}>
            <Icon name="folder" />
            打开脚本目录
          </button>
          <button className="btn" onClick={() => void createExample()}>
            <Icon name="plus" />
            生成示例
          </button>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="scripts-layout">
        <div className="scripts-left">
          <div className="pane-head">
            <span>脚本列表</span>
            <button className="icon-btn small" onClick={() => void load()} title="刷新" aria-label="刷新">
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div className="script-list">
            {loading && (
              <div className="empty">
                <Spinner /> 加载中…
              </div>
            )}
            {!loading && loadError && <div className="empty bad">{loadError}</div>}
            {!loading && !loadError && scripts.length === 0 && (
              <div className="empty">
                还没有脚本。
                <button className="link-btn" onClick={() => void createExample()}>
                  生成一个示例
                </button>
              </div>
            )}
            {scripts.map((s) => (
              <button key={s.id} className={`script-item${s.id === scriptId ? ' active' : ''}`} onClick={() => setScriptId(s.id)}>
                <div className="script-name">{s.name}</div>
                <div className="script-desc">{s.description || s.id}</div>
                <div className="script-cmd mono">{s.command.join(' ')}</div>
              </button>
            ))}
          </div>
          <div className="script-run-box">
            <label className="field">
              <span className="field-label">参数（可选）</span>
              <input type="text" value={args} placeholder="追加到命令末尾" spellCheck={false} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <button className="btn primary block" disabled={!scriptId || targets.length === 0 || busy} onClick={() => void start()}>
              {busy ? <Spinner size={12} /> : <Icon name="play" size={12} />}
              {targets.length === 0 ? '请先选择运行中的实例' : `对 ${targets.length} 个实例运行`}
            </button>
            {targets.length > 0 && <div className="hint">{targets.map((i) => `${nameOf(i)} #${i}`).join('、')}</div>}
          </div>
        </div>
        <div className="scripts-right">
          <div className="pane-head">
            <span>运行记录</span>
            <button className="icon-btn small" onClick={() => void refreshRuns()} title="刷新" aria-label="刷新">
              <Icon name="refresh" size={14} />
            </button>
          </div>
          <div className="run-list">
            {store.runs.length === 0 && <div className="empty">暂无运行记录</div>}
            {store.runs.map((r) => (
              <div key={r.runId} className={`run-item${run?.runId === r.runId ? ' active' : ''}`} onClick={() => setActiveRun(r.runId)}>
                <span className={`run-status rs-${r.status}`}>{RUN_STATUS[r.status]}</span>
                <span className="run-title">
                  {r.scriptId} · {nameOf(r.index)} #{r.index}
                </span>
                <span className="run-time">{formatTime(r.startedAt)}</span>
                {r.status === 'running' ? (
                  <button
                    className="btn xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      void stopRun(r);
                    }}
                  >
                    停止
                  </button>
                ) : (
                  <span className="run-exit mono">{r.exitCode !== undefined && r.exitCode !== null ? `退出码 ${r.exitCode}` : ''}</span>
                )}
              </div>
            ))}
          </div>
          {run && (
            <div className="run-detail">
              <div className="run-detail-head">
                <span className="mono dim">{run.runId}</span>
                <button className="link-btn" onClick={() => void avdm.revealPath(run.logFile)}>
                  日志文件
                </button>
              </div>
              <RunOutput store={store.output} runId={run.runId} />
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
