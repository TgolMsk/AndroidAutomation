import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ArchiveInfo, InstallProgress, RemotePackage, SdkInfo, SdkInstallPlan, Settings } from '@avdm/core';
import { avdm, errMsg } from '../api';
import type { SdkInstallStatus } from '../../../shared/ipc';
import {
  agreedLicenseIds,
  allLicensesAgreed,
  BASE_SDK_PACKAGES,
  emulatorOutdated,
  formatBytes,
  imageLabel,
  MIN_EMULATOR_VERSION,
  missingSdkPackages,
} from '../format';
import { useAvdmEvent } from '../hooks/useAvdmEvent';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { Spinner } from './StatusBadge';

type Step =
  | { kind: 'checking' }
  | { kind: 'pick' }
  | { kind: 'planning'; packages: string[] }
  | { kind: 'review'; plan: SdkInstallPlan }
  | { kind: 'installing'; plan: SdkInstallPlan }
  | { kind: 'done'; plan: SdkInstallPlan }
  | { kind: 'error'; message: string; packages: string[]; plan?: SdkInstallPlan };

const PHASE_LABEL: Record<InstallProgress['phase'], string> = {
  download: '下载中',
  verify: '校验中',
  extract: '解压中',
  done: '已完成',
  error: '失败',
};

/** Packages the wizard proposes: missing ones plus an outdated emulator. */
export function proposedPackages(sdk: SdkInfo, settings: Settings): string[] {
  const list = missingSdkPackages(sdk, settings);
  if (emulatorOutdated(sdk) && !list.includes('emulator')) list.unshift('emulator');
  return list;
}

function hostArchive(pkg: RemotePackage, platform?: string, arch?: string): ArchiveInfo | undefined {
  const os = platform === 'darwin' ? 'macosx' : platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : undefined;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : undefined;
  return (
    pkg.archives.find((a) => a.hostOs === os && (!a.hostArch || a.hostArch === cpu)) ??
    pkg.archives.find((a) => !a.hostOs) ??
    pkg.archives[0]
  );
}

function packageTitle(pkg: RemotePackage): string {
  if (pkg.path.startsWith('system-images;')) return `${pkg.displayName} (${imageLabel(pkg.path)})`;
  return pkg.displayName || pkg.path;
}

function Steps({ current }: { current: number }) {
  const names = ['确认组件与许可', '下载安装', '完成'];
  return (
    <ol className="wizard-steps">
      {names.map((n, i) => (
        <li key={n} className={i < current ? 'done' : i === current ? 'current' : undefined}>
          <span className="step-num">{i < current ? <Icon name="check" size={12} /> : i + 1}</span>
          {n}
        </li>
      ))}
    </ol>
  );
}

export function SdkWizard({
  mode,
  sdk,
  settings,
  platform,
  arch,
  onClose,
  onInstalled,
}: {
  mode: 'auto' | 'manual';
  sdk: SdkInfo;
  settings: Settings;
  platform?: string;
  arch?: string;
  onClose: () => void;
  onInstalled: (sdk: SdkInfo) => void;
}) {
  const initial = useMemo(() => proposedPackages(sdk, settings), [sdk, settings]);
  // First look for an install already running in the main process (the window was reloaded or reopened
  // while it ran): show its progress with a working 取消安装 instead of starting over.
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  /** Licenses the user ticked, one checkbox per license. */
  const [agreed, setAgreed] = useState<ReadonlySet<string>>(() => new Set());
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({});
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [notice, setNotice] = useState<string>();
  const speedRef = useRef<{ t: number; bytes: number; speed: number }>({ t: 0, bytes: 0, speed: 0 });

  // ── pick (manual mode) ──
  const [remote, setRemote] = useState<RemotePackage[]>();
  const [remoteError, setRemoteError] = useState<string>();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));

  const loadRemote = useCallback(async () => {
    setRemoteError(undefined);
    setRemote(undefined);
    try {
      setRemote(await avdm.listRemoteImages());
    } catch (err) {
      setRemoteError(errMsg(err));
    }
  }, []);

  useEffect(() => {
    if (mode === 'manual') void loadRemote();
  }, [mode, loadRemote]);

  // ── planning ──
  const planningPackages = step.kind === 'planning' ? step.packages : undefined;
  useEffect(() => {
    if (!planningPackages) return;
    let alive = true;
    avdm
      .planSdkInstall(planningPackages)
      .then((plan) => {
        if (!alive) return;
        setAgreed(new Set());
        setStep({ kind: 'review', plan });
      })
      .catch((err: unknown) => alive && setStep({ kind: 'error', message: errMsg(err), packages: planningPackages }));
    return () => {
      alive = false;
    };
  }, [planningPackages]);

  useAvdmEvent('sdk-progress', (p) => {
    setProgress((prev) => ({ ...prev, [p.packagePath]: p }));
  });

  /**
   * Run the install (or, with `attach`, follow the one already running in main: installSdk with the same
   * package set joins it). Licenses are only recorded for a fresh install, from the boxes the user ticked.
   */
  const install = async (plan: SdkInstallPlan, attach?: SdkInstallStatus) => {
    const paths = attach ? attach.packages : plan.packages.map((p) => p.path);
    const initialProgress = attach ? attach.progress : {};
    const received = Object.values(initialProgress).reduce((sum, p) => sum + (p.phase === 'done' ? (p.totalBytes ?? 0) : (p.receivedBytes ?? 0)), 0);
    setProgress(initialProgress);
    setCancelling(!!attach?.cancelling);
    cancellingRef.current = !!attach?.cancelling;
    setNotice(undefined);
    speedRef.current = { t: Date.now(), bytes: received, speed: 0 };
    setStep({ kind: 'installing', plan });
    try {
      // Consent was given explicitly via the per-license checkboxes above; only then record it.
      const consent = agreedLicenseIds(plan.unaccepted, agreed);
      // Pass the texts that were displayed: core refuses if the repository's current text differs.
      if (!attach && consent.length > 0) await avdm.acceptLicenses(consent, plan.licenses);
      await avdm.installSdk(paths);
      const fresh = await avdm.refreshSdk();
      onInstalled(fresh);
      setStep({ kind: 'done', plan });
    } catch (err) {
      if (cancellingRef.current) {
        // Re-plan so license state and sizes are current; resume is handled by the downloader.
        setNotice('安装已取消。再次安装时会尽量续传已下载的部分。');
        setStep({ kind: 'planning', packages: paths });
      } else {
        setStep({ kind: 'error', message: errMsg(err), packages: paths, plan });
      }
    } finally {
      setCancelling(false);
      cancellingRef.current = false;
    }
  };

  useEffect(() => {
    let alive = true;
    avdm
      .sdkInstallStatus()
      .catch(() => null)
      .then((status) => {
        if (!alive) return;
        if (status) void install(status.plan, status);
        else setStep(mode === 'manual' ? { kind: 'pick' } : { kind: 'planning', packages: initial });
      });
    return () => {
      alive = false;
    };
    // Mount only: `initial` / `mode` are the wizard's starting point.
  }, []);

  const cancel = async () => {
    setCancelling(true);
    cancellingRef.current = true;
    try {
      await avdm.cancelSdkInstall();
    } catch {
      // ignore
    }
  };

  const stepIndex = step.kind === 'installing' ? 1 : step.kind === 'done' ? 2 : 0;
  const title = mode === 'auto' ? '安装 Android 运行环境' : '管理 SDK 组件';

  // ── render helpers ──
  const renderPick = () => {
    const installedImages = new Set(sdk.images.map((i) => i.packagePath));
    const toggle = (p: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      });
    const base = [
      {
        path: 'emulator',
        title: 'Android Emulator',
        status: sdk.emulator ? `已安装 ${sdk.emulator.version ?? ''}${emulatorOutdated(sdk) ? `（低于建议的 ${MIN_EMULATOR_VERSION}）` : ''}` : '未安装',
      },
      { path: 'platform-tools', title: 'Platform Tools（adb）', status: sdk.adb ? `已安装 ${sdk.adb.version ?? ''}` : '未安装' },
    ];
    return (
      <>
        <div className="section-title first">基础组件</div>
        <div className="pick-list">
          {base.map((b) => (
            <label key={b.path} className="pick-item">
              <input type="checkbox" checked={picked.has(b.path)} onChange={() => toggle(b.path)} />
              <span className="pick-title">{b.title}</span>
              <span className="pick-status">{b.status}</span>
            </label>
          ))}
        </div>
        <div className="section-title">
          系统镜像（arm64-v8a）
          <button className="icon-btn small" onClick={() => void loadRemote()} title="刷新" aria-label="刷新">
            <Icon name="refresh" size={13} />
          </button>
        </div>
        <div className="pick-list scroll">
          {!remote && !remoteError && (
            <div className="empty">
              <Spinner /> 正在读取 Google 镜像目录…
            </div>
          )}
          {remoteError && (
            <div className="empty bad">
              读取失败：{remoteError}
              <button className="link-btn" onClick={() => void loadRemote()}>
                重试
              </button>
            </div>
          )}
          {remote?.map((pkg) => {
            const a = hostArchive(pkg, platform, arch);
            const installed = installedImages.has(pkg.path);
            return (
              <label key={pkg.path} className="pick-item">
                <input type="checkbox" checked={picked.has(pkg.path)} onChange={() => toggle(pkg.path)} />
                <span className="pick-title">
                  {imageLabel(pkg.path)}
                  {pkg.path === settings.defaultImage && <span className="tag">默认</span>}
                  {installed && <span className="tag ok">已安装</span>}
                </span>
                <span className="pick-status mono">
                  r{pkg.revision} · {formatBytes(a?.size)}
                </span>
              </label>
            );
          })}
        </div>
      </>
    );
  };

  const renderPlan = (plan: SdkInstallPlan, withProgress: boolean) => {
    const received = Object.values(progress).reduce((sum, p) => sum + (p.phase === 'done' ? (p.totalBytes ?? 0) : (p.receivedBytes ?? 0)), 0);
    if (withProgress) {
      const s = speedRef.current;
      const now = Date.now();
      if (now - s.t >= 1000) {
        s.speed = Math.max(0, (received - s.bytes) / ((now - s.t) / 1000));
        s.t = now;
        s.bytes = received;
      }
    }
    const overall = plan.totalBytes > 0 ? Math.min(1, received / plan.totalBytes) : 0;
    return (
      <>
        <div className="section-title first">
          {withProgress ? '下载与安装' : '将下载并安装以下组件'}
          <span className="section-extra">合计 {formatBytes(plan.totalBytes)}</span>
        </div>
        <div className="plan-list">
          {plan.packages.map((pkg) => {
            const a = hostArchive(pkg, platform, arch);
            const p = progress[pkg.path];
            const frac = p?.phase === 'done' ? 1 : p?.totalBytes ? Math.min(1, (p.receivedBytes ?? 0) / p.totalBytes) : 0;
            return (
              <div key={pkg.path} className={`plan-item${p?.phase === 'error' ? ' bad' : ''}`}>
                <div className="plan-row">
                  <span className="plan-title">{packageTitle(pkg)}</span>
                  <span className="plan-meta mono">
                    r{pkg.revision} · {formatBytes(a?.size)}
                  </span>
                </div>
                <div className="plan-path mono">{pkg.path}</div>
                {withProgress && (
                  <div className="plan-progress">
                    <div className={`progress${p?.phase === 'verify' || p?.phase === 'extract' ? ' indeterminate' : ''}`}>
                      <div className="progress-bar" style={{ width: `${Math.round(frac * 100)}%` }} />
                    </div>
                    <span className="plan-phase">
                      {p ? PHASE_LABEL[p.phase] : '等待中'}
                      {p?.phase === 'download' && p.totalBytes ? ` ${formatBytes(p.receivedBytes ?? 0)} / ${formatBytes(p.totalBytes)}` : ''}
                    </span>
                  </div>
                )}
                {p?.phase === 'error' && p.message && <div className="form-error">{p.message}</div>}
              </div>
            );
          })}
        </div>
        {withProgress && (
          <div className="overall">
            <div className="progress big">
              <div className="progress-bar" style={{ width: `${Math.round(overall * 100)}%` }} />
            </div>
            <div className="overall-text">
              {Math.round(overall * 100)}% · {formatBytes(received)} / {formatBytes(plan.totalBytes)}
              {speedRef.current.speed > 0 && ` · ${formatBytes(speedRef.current.speed)}/s`}
            </div>
          </div>
        )}
        {plan.missing.length > 0 && (
          <div className="notice warn">
            <Icon name="alert" />
            <div>以下组件在 Google 目录中未找到（本机平台不可用或名称有误），将被跳过：{plan.missing.join('、')}</div>
          </div>
        )}
        <div className="hint block">
          安装位置：<span className="mono">{settings.sdkRoot}</span>
        </div>
      </>
    );
  };

  let body: ReactNode;
  let footer: ReactNode;

  switch (step.kind) {
    case 'checking': {
      body = (
        <div className="wizard-center">
          <Spinner size={22} />
          <div>正在检查…</div>
        </div>
      );
      footer = (
        <button className="btn" onClick={onClose}>
          稍后
        </button>
      );
      break;
    }
    case 'pick': {
      body = renderPick();
      footer = (
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={picked.size === 0} onClick={() => setStep({ kind: 'planning', packages: [...picked] })}>
            下一步
          </button>
        </>
      );
      break;
    }
    case 'planning': {
      body = (
        <div className="wizard-center">
          <Spinner size={22} />
          <div>正在读取 Google SDK 目录并计算下载内容…</div>
        </div>
      );
      footer = (
        <button className="btn" onClick={onClose}>
          稍后
        </button>
      );
      break;
    }
    case 'review': {
      const { plan } = step;
      const needConsent = plan.unaccepted.length > 0;
      const consented = allLicensesAgreed(plan.unaccepted, agreed);
      const nothing = plan.packages.length === 0;
      const toggleConsent = (id: string, on: boolean) =>
        setAgreed((prev) => {
          const next = new Set(prev);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        });
      body = (
        <>
          {notice && (
            <div className="notice info">
              <Icon name="info" />
              <div>{notice}</div>
            </div>
          )}
          {nothing ? (
            <div className="wizard-center">
              <Icon name="check" size={24} />
              <div>没有需要安装的组件。</div>
            </div>
          ) : (
            renderPlan(plan, false)
          )}
          {needConsent && (
            <>
              <div className="section-title">许可协议</div>
              <div className="hint block">
                安装前请完整阅读以下许可，并逐一勾选同意。只有全部勾选后，才会记录同意并开始下载。
              </div>
              {plan.unaccepted.map((id) => (
                <div key={id} className="license">
                  <div className="license-id mono">{id}</div>
                  <pre className="license-text">{plan.licenses[id] ?? '（许可文本缺失）'}</pre>
                  <label className="check consent">
                    <input type="checkbox" checked={agreed.has(id)} onChange={(e) => toggleConsent(id, e.target.checked)} />
                    我已阅读并同意许可 <span className="mono">{id}</span>
                  </label>
                </div>
              ))}
            </>
          )}
        </>
      );
      footer = (
        <>
          {mode === 'manual' && (
            <button className="btn footer-left" onClick={() => setStep({ kind: 'pick' })}>
              上一步
            </button>
          )}
          <button className="btn" onClick={onClose}>
            {mode === 'auto' ? '稍后' : '取消'}
          </button>
          <button className="btn primary" disabled={nothing || (needConsent && !consented)} onClick={() => void install(plan)}>
            <Icon name="download" />
            {needConsent ? '同意并安装' : '开始安装'}
          </button>
        </>
      );
      break;
    }
    case 'installing': {
      body = renderPlan(step.plan, true);
      footer = (
        <button className="btn" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling && <Spinner size={12} />}
          {cancelling ? '正在取消…' : '取消安装'}
        </button>
      );
      break;
    }
    case 'done': {
      body = (
        <div className="wizard-center">
          <span className="done-mark">
            <Icon name="check" size={26} />
          </span>
          <div className="done-title">安装完成</div>
          <div className="hint">已安装 {step.plan.packages.length} 个组件，现在可以创建实例了。</div>
        </div>
      );
      footer = (
        <button className="btn primary" onClick={onClose}>
          完成
        </button>
      );
      break;
    }
    case 'error': {
      const retryPlan = step.plan;
      body = (
        <>
          <div className="notice bad">
            <Icon name="alert" />
            <div>
              <b>操作失败</b>
              <div className="pre-wrap">{step.message}</div>
            </div>
          </div>
          {retryPlan && renderPlan(retryPlan, true)}
        </>
      );
      footer = (
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={() => setStep({ kind: 'planning', packages: step.packages })}>
            <Icon name="refresh" />
            重试
          </button>
        </>
      );
      break;
    }
  }

  return (
    <Modal
      title={title}
      subtitle={mode === 'auto' ? `需要 ${BASE_SDK_PACKAGES.join('、')} 与默认系统镜像才能创建和运行实例` : '选择要安装或更新的组件'}
      onClose={onClose}
      busy={step.kind === 'installing'}
      width={760}
      className="wizard"
      footer={footer}
    >
      {step.kind !== 'pick' && step.kind !== 'checking' && <Steps current={stepIndex} />}
      {body}
    </Modal>
  );
}
