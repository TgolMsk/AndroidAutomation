import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstanceRecord, SdkInfo, Settings } from '@avdm/core';
import type { BatchResult } from '../../../shared/ipc';
import { avdm, errMsg } from '../api';
import { ConfirmDialog } from '../components/dialogs/ConfirmDialog';
import { AppLaunchDialog } from '../components/dialogs/AppLaunchDialog';
import { CloneDialog } from '../components/dialogs/CloneDialog';
import { CreateDialog } from '../components/dialogs/CreateDialog';
import { EditDialog } from '../components/dialogs/EditDialog';
import { InstallApkDialog } from '../components/dialogs/InstallApkDialog';
import { ScriptsDialog } from '../components/dialogs/ScriptsDialog';
import { SettingsDialog } from '../components/dialogs/SettingsDialog';
import { ShellDialog } from '../components/dialogs/ShellDialog';
import { Icon } from '../components/Icon';
import type { InstanceActions } from '../components/InstanceCard';
import { InstanceGrid } from '../components/InstanceGrid';
import { LogsDrawer } from '../components/LogsDrawer';
import { SdkWizard } from '../components/SdkWizard';
import { Spinner } from '../components/StatusBadge';
import { Toolbar, type ViewMode } from '../components/Toolbar';
import { TopBar } from '../components/TopBar';
import { useToast } from '../components/Toasts';
import { emulatorOutdated, hasScreen, isActive, isRunning, MIN_EMULATOR_VERSION, missingSdkPackages } from '../format';
import { useAvdmEvent } from '../hooks/useAvdmEvent';
import { useHostStats } from '../hooks/useHostStats';
import { useInstances } from '../hooks/useInstances';
import { useScriptRuns } from '../hooks/useScriptRuns';
import { useSelection } from '../hooks/useSelection';
import { useThumbnails } from '../hooks/useThumbnails';

type DialogState =
  | { kind: 'create' }
  | { kind: 'clone'; index: number }
  | { kind: 'edit'; index: number }
  | { kind: 'settings' }
  | { kind: 'scripts' }
  | { kind: 'installApk'; paths: string[]; targets: number[] }
  | { kind: 'appLaunch'; targets: number[] }
  | { kind: 'shell'; targets: number[] }
  | { kind: 'delete'; indices: number[] }
  | { kind: 'sdk'; mode: 'auto' | 'manual' };

interface AppInfo {
  version: string;
  home: string;
  platform: string;
  arch: string;
}

const VIEW_KEY = 'avdm.view';
const MAX_INSTANCES = 64;

function loadView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

export function MainView() {
  const toast = useToast();
  const { instances, loaded, error: listError, reload } = useInstances();
  const stats = useHostStats(3000);
  const selection = useSelection();
  const scriptRuns = useScriptRuns();

  const [settings, setSettings] = useState<Settings>();
  const [sdk, setSdk] = useState<SdkInfo>();
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [baseError, setBaseError] = useState<string>();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [logsIndex, setLogsIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [view, setView] = useState<ViewMode>(loadView);
  const [filter, setFilter] = useState('');
  const autoWizardShown = useRef(false);

  // ── base data: settings, SDK, app info ──
  const loadBase = useCallback(async () => {
    avdm
      .appInfo()
      .then(setAppInfo)
      .catch(() => undefined);
    try {
      const [s, k] = await Promise.all([avdm.getSettings(), avdm.getSdk()]);
      setSettings(s);
      setSdk(k);
      setBaseError(undefined);
      if (!autoWizardShown.current && missingSdkPackages(k, s).length > 0) {
        autoWizardShown.current = true;
        setDialog((d) => d ?? { kind: 'sdk', mode: 'auto' });
      }
    } catch (err) {
      setBaseError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // An SDK install keeps running in the main process when the window is closed (⌘W) or reloaded: reopen
  // the wizard, which attaches to it (progress + 取消安装).
  useEffect(() => {
    avdm
      .sdkInstallStatus()
      .then((status) => {
        if (!status) return;
        autoWizardShown.current = true;
        setDialog((d) => d ?? { kind: 'sdk', mode: 'manual' });
      })
      .catch(() => undefined);
  }, []);

  // settings.json changed outside the app (`avdm settings set …`): keep TopBar, CreateDialog defaults and the
  // SDK info current. (The settings dialog re-reads settings itself.)
  useAvdmEvent('settings-changed', () => void loadBase());

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage unavailable
    }
  }, [view]);

  // ── derived ──
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return instances;
    return instances.filter(
      (s) =>
        s.record.name.toLowerCase().includes(q) ||
        String(s.record.index) === q.replace(/^#/, '') ||
        s.ports.serial.includes(q) ||
        (s.record.notes ?? '').toLowerCase().includes(q),
    );
  }, [instances, filter]);

  const selectedStates = useMemo(() => instances.filter((s) => selection.selected.has(s.record.index)), [instances, selection.selected]);

  useEffect(() => {
    if (loaded) selection.prune(instances.map((s) => s.record.index));
  }, [instances, loaded, selection.prune]);

  const screenIndices = useMemo(() => (view === 'grid' ? instances.filter(hasScreen).map((s) => s.record.index) : []), [instances, view]);
  const thumbs = useThumbnails(screenIndices);

  const byIndex = useMemo(() => new Map(instances.map((s) => [s.record.index, s])), [instances]);
  const byIndexRef = useRef(byIndex);
  byIndexRef.current = byIndex;
  const nameOf = useCallback((i: number) => byIndexRef.current.get(i)?.record.name ?? '实例', []);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const lastClicked = useRef<number | null>(null);
  const dialogOpen = dialog !== null;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  // ── batch helper ──
  const markBusy = useCallback((indices: number[], label: string | null) => {
    setBusy((prev) => {
      const next = new Map(prev);
      for (const i of indices) {
        if (label) next.set(i, label);
        else next.delete(i);
      }
      return next;
    });
  }, []);

  const runBatch = useCallback(
    async (label: string, busyLabel: string, indices: number[], fn: () => Promise<BatchResult<unknown>[]>) => {
      if (indices.length === 0) return;
      markBusy(indices, busyLabel);
      try {
        const results = await fn();
        toast.batch(label, results, nameOf);
      } catch (err) {
        toast.error(`${label}失败`, errMsg(err));
      } finally {
        markBusy(indices, null);
        void reload();
      }
    },
    [markBusy, toast, nameOf, reload],
  );

  const openCreate = useCallback(() => setDialog({ kind: 'create' }), []);

  const actions = useMemo<InstanceActions>(
    () => ({
      toggleSelect(index, range) {
        const sel = selectionRef.current;
        const last = lastClicked.current;
        if (range && last !== null && last !== index) {
          const order = visibleRef.current.map((s) => s.record.index);
          const a = order.indexOf(last);
          const b = order.indexOf(index);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            sel.set([...sel.selected, ...order.slice(lo, hi + 1)]);
            lastClicked.current = index;
            return;
          }
        }
        sel.toggle(index);
        lastClicked.current = index;
      },
      start(indices, opts) {
        void runBatch(opts?.force ? '强制启动' : '启动', '启动中', indices, () => avdm.start(indices, opts));
      },
      stop(indices, opts) {
        void runBatch(opts?.force ? '强制停止' : '停止', '停止中', indices, () => avdm.stop(indices, opts));
      },
      restart(indices) {
        void runBatch('重启', '重启中', indices, () => avdm.restart(indices));
      },
      openLive(index) {
        avdm.openLiveView(index).catch((err: unknown) => toast.error('无法打开实时画面', errMsg(err)));
      },
      openScrcpy(index) {
        avdm.openScrcpy(index).catch((err: unknown) => toast.error('无法启动 scrcpy', errMsg(err)));
      },
      screenshot(index) {
        avdm
          .saveScreenshot(index)
          .then((file) =>
            toast.push({ kind: 'success', title: '截图已保存', detail: file, action: { label: '在 Finder 中显示', onClick: () => void avdm.revealPath(file) } }),
          )
          .catch((err: unknown) => toast.error('截图失败', errMsg(err)));
      },
      clone: (index) => setDialog({ kind: 'clone', index }),
      edit: (index) => setDialog({ kind: 'edit', index }),
      logs: (index) => setLogsIndex(index),
      remove: (indices) => setDialog({ kind: 'delete', indices }),
      async rename(index, name) {
        try {
          await avdm.update(index, { name });
          void reload();
        } catch (err) {
          toast.error('重命名失败', errMsg(err));
        }
      },
    }),
    [runBatch, toast, reload],
  );

  // ── keyboard shortcuts: ⌘A select all, ⌘N new, Esc clear selection ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpenRef.current || e.defaultPrevented || isTextInput(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'a') {
        e.preventDefault();
        selectionRef.current.selectAll(visibleRef.current.map((s) => s.record.index));
      } else if (mod && key === 'n') {
        e.preventDefault();
        openCreate();
      } else if (e.key === 'Escape') {
        selectionRef.current.clear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCreate]);

  // Health-monitor warnings (auto restart, crashes, …) surface as toasts.
  useAvdmEvent('log', (entry) => {
    if (entry.level === 'info') return;
    toast.push({ kind: entry.level === 'error' ? 'error' : 'warn', title: entry.message });
  });

  // ── handlers for dialogs ──
  const onCreated = (records: InstanceRecord[], startNow: boolean) => {
    toast.push({ kind: 'success', title: `已创建 ${records.length} 个实例`, detail: records.map((r) => `${r.name} #${r.index}`).join('、') });
    void reload();
    if (startNow) actions.start(records.map((r) => r.index));
  };

  const pickAndInstall = async (targets: number[]) => {
    try {
      const paths = await avdm.pickApks();
      if (paths.length) setDialog({ kind: 'installApk', paths, targets });
    } catch (err) {
      toast.error('无法打开文件选择框', errMsg(err));
    }
  };

  const retryAll = () => {
    void loadBase();
    void reload();
  };

  const sdkMissing = sdk && settings ? missingSdkPackages(sdk, settings) : [];
  const outdated = sdk ? emulatorOutdated(sdk) : false;
  const connectError = baseError ?? (loaded && instances.length === 0 ? listError : undefined);
  const freeSlots = MAX_INSTANCES - instances.length;
  const runningSelected = selectedStates.filter(isRunning).map((s) => s.record.index);

  const renderDialog = () => {
    if (!dialog) return null;
    const close = () => setDialog(null);
    switch (dialog.kind) {
      case 'create':
        if (!settings || !sdk) return null;
        return (
          <CreateDialog
            settings={settings}
            sdk={sdk}
            freeSlots={freeSlots}
            onClose={close}
            onCreated={onCreated}
            onInstallImages={() => setDialog({ kind: 'sdk', mode: 'manual' })}
          />
        );
      case 'clone': {
        const s = byIndex.get(dialog.index);
        if (!s) return null;
        return (
          <CloneDialog
            source={s}
            freeSlots={freeSlots}
            onClose={close}
            onCloned={(records) => {
              toast.push({ kind: 'success', title: `已克隆 ${records.length} 个实例`, detail: records.map((r) => `${r.name} #${r.index}`).join('、') });
              void reload();
            }}
          />
        );
      }
      case 'edit': {
        const s = byIndex.get(dialog.index);
        if (!s) return null;
        return (
          <EditDialog
            state={s}
            onClose={close}
            onSaved={(r) => {
              toast.push({ kind: 'success', title: `已保存「${r.name}」的配置` });
              void reload();
            }}
          />
        );
      }
      case 'settings':
        if (!settings) return null;
        return (
          <SettingsDialog
            settings={settings}
            sdk={sdk}
            home={appInfo?.home}
            onClose={close}
            onManageSdk={() => setDialog({ kind: 'sdk', mode: 'manual' })}
            onSaved={(saved) => {
              const sdkChanged = saved.sdkRoot !== settings.sdkRoot;
              setSettings(saved);
              toast.push({ kind: 'success', title: '设置已保存' });
              if (sdkChanged) {
                avdm
                  .refreshSdk()
                  .then(setSdk)
                  .catch((err: unknown) => toast.error('重新扫描 SDK 失败', errMsg(err)));
              }
            }}
          />
        );
      case 'scripts':
        return <ScriptsDialog targets={runningSelected} nameOf={nameOf} store={scriptRuns} onClose={close} />;
      case 'installApk':
        return <InstallApkDialog initialPaths={dialog.paths} targets={dialog.targets} nameOf={nameOf} onClose={close} />;
      case 'appLaunch':
        return <AppLaunchDialog targets={dialog.targets} nameOf={nameOf} onClose={close} />;
      case 'shell':
        return <ShellDialog targets={dialog.targets} nameOf={nameOf} onClose={close} />;
      case 'delete': {
        const targets = dialog.indices.map((i) => byIndex.get(i)).filter((s): s is NonNullable<typeof s> => !!s);
        const anyActive = targets.some(isActive);
        return (
          <ConfirmDialog
            title={`删除 ${targets.length} 个实例？`}
            danger
            confirmLabel="删除"
            message={
              <>
                <p>以下实例的磁盘数据（应用、账号、快照）将被永久删除，无法恢复：</p>
                <ul className="confirm-list">
                  {targets.slice(0, 12).map((s) => (
                    <li key={s.record.index}>
                      {s.record.name} <span className="dim">#{s.record.index}</span>
                      {isActive(s) && <span className="tag warn">运行中</span>}
                    </li>
                  ))}
                  {targets.length > 12 && <li className="dim">…以及另外 {targets.length - 12} 个</li>}
                </ul>
              </>
            }
            option={anyActive ? { label: '先停止运行中的实例再删除', hint: '（否则运行中的实例会删除失败）', defaultChecked: true } : undefined}
            onConfirm={async (force) => {
              await runBatch('删除', '删除中', dialog.indices, () => avdm.remove(dialog.indices, force));
              selection.prune(instances.filter((s) => !dialog.indices.includes(s.record.index)).map((s) => s.record.index));
            }}
            onClose={close}
          />
        );
      }
      case 'sdk':
        if (!settings || !sdk) return null;
        return (
          <SdkWizard
            mode={dialog.mode}
            sdk={sdk}
            settings={settings}
            platform={appInfo?.platform}
            arch={appInfo?.arch}
            onClose={close}
            onInstalled={(fresh) => {
              setSdk(fresh);
              toast.push({ kind: 'success', title: 'SDK 组件安装完成' });
            }}
          />
        );
    }
  };

  const [appOutdated, setAppOutdated] = useState(false);
  useAvdmEvent('app-outdated', () => setAppOutdated(true));

  const logsState = logsIndex !== null ? byIndex.get(logsIndex) : undefined;

  return (
    <div className="app">
      <TopBar
        stats={stats}
        maxRunning={settings?.maxRunning}
        memoryReserveMb={settings?.memoryReserveMb}
        onCreate={openCreate}
        onScripts={() => setDialog({ kind: 'scripts' })}
        onOpenAutomation={() => { window.location.hash = '#/automation'; }}
        onSettings={() => setDialog({ kind: 'settings' })}
        createDisabled={!settings || !sdk}
      />

      {appOutdated && (
        <div className="banner warn">
          <Icon name="alert" />
          <span>客户端已重新构建，当前窗口仍在运行旧代码（新启动的实例会用旧参数）。重启客户端后生效，运行中的模拟器不受影响。</span>
          <button className="btn sm primary" onClick={() => void avdm.relaunchApp().catch(() => undefined)}>
            立即重启
          </button>
        </div>
      )}
      {connectError && (
        <div className="banner bad">
          <Icon name="alert" />
          <span>无法连接到管理器：{connectError}</span>
          <button className="btn sm" onClick={retryAll}>
            重试
          </button>
        </div>
      )}
      {!connectError && sdkMissing.length > 0 && dialog?.kind !== 'sdk' && (
        <div className="banner warn">
          <Icon name="download" />
          <span>缺少运行环境：{sdkMissing.join('、')}。安装后才能创建和启动实例。</span>
          <button className="btn sm primary" onClick={() => setDialog({ kind: 'sdk', mode: 'auto' })}>
            安装…
          </button>
        </div>
      )}
      {!connectError && sdkMissing.length === 0 && outdated && (
        <div className="banner warn">
          <Icon name="alert" />
          <span>
            模拟器版本 {sdk?.emulator?.version} 低于建议的 {MIN_EMULATOR_VERSION}（修复 macOS 上 HVF 内存泄漏），建议更新。
          </span>
          <button className="btn sm" onClick={() => setDialog({ kind: 'sdk', mode: 'manual' })}>
            更新…
          </button>
        </div>
      )}

      <Toolbar
        visible={visible}
        selected={selectedStates}
        totalCount={instances.length}
        view={view}
        filter={filter}
        onFilter={setFilter}
        onView={setView}
        onSelectAll={() => selection.selectAll(visible.map((s) => s.record.index))}
        onClearSelection={selection.clear}
        onInvert={() => selection.invert(visible.map((s) => s.record.index))}
        onStart={(ix) => actions.start(ix)}
        onStop={(ix) => actions.stop(ix)}
        onRestart={(ix) => actions.restart(ix)}
        onInstallApk={(ix) => void pickAndInstall(ix)}
        onAppLaunch={(ix) => setDialog({ kind: 'appLaunch', targets: ix })}
        onShell={(ix) => setDialog({ kind: 'shell', targets: ix })}
        onScripts={() => setDialog({ kind: 'scripts' })}
        onDelete={(ix) => actions.remove(ix)}
      />

      <main className="content">
        {!loaded ? (
          <div className="empty-state">
            <Spinner size={24} />
            <p>正在读取实例…</p>
          </div>
        ) : instances.length === 0 && connectError ? (
          <div className="empty-state">
            <Icon name="alert" size={30} />
            <h2>暂时无法读取实例</h2>
            <p>主进程中的管理器未能就绪，请查看上方的错误信息后重试。</p>
            <button className="btn lg" onClick={retryAll}>
              <Icon name="refresh" />
              重试
            </button>
          </div>
        ) : instances.length === 0 ? (
          <div className="empty-state">
            <div className="empty-art">
              <Icon name="android" size={44} />
            </div>
            <h2>还没有实例</h2>
            <p>
              {sdkMissing.length > 0
                ? '先安装 Android 模拟器与系统镜像，然后创建第一个实例。'
                : '创建第一个 Android 模拟器实例；之后可以批量启动、克隆、安装应用和运行脚本。'}
            </p>
            <div className="empty-actions">
              {sdkMissing.length > 0 && (
                <button className="btn lg" onClick={() => setDialog({ kind: 'sdk', mode: 'auto' })}>
                  <Icon name="download" />
                  安装运行环境
                </button>
              )}
              <button className="btn primary lg" onClick={openCreate} disabled={!settings || !sdk}>
                <Icon name="plus" />
                新建实例
              </button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty-state small">
            <Icon name="search" size={28} />
            <p>没有匹配「{filter}」的实例</p>
            <button className="btn sm" onClick={() => setFilter('')}>
              清除搜索
            </button>
          </div>
        ) : (
          <InstanceGrid instances={visible} view={view} selected={selection.selected} thumbs={thumbs} busy={busy} actions={actions} />
        )}
      </main>

      {logsState && <LogsDrawer state={logsState} home={appInfo?.home} onClose={() => setLogsIndex(null)} />}
      {renderDialog()}
    </div>
  );
}
