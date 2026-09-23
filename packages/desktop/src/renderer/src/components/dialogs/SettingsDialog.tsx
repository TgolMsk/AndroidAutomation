import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InstanceSpec, SdkInfo, Settings } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { imageLabel } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { settingsPatch } from '../../settingsPatch';
import { Icon } from '../Icon';
import { Modal } from '../Modal';
import { ArgsInput, SpecFields, specProblems } from '../SpecFields';
import { Spinner } from '../StatusBadge';

type ProxyMode = 'direct' | 'inherit' | 'custom';

function proxyMode(p: string): ProxyMode {
  return p === 'direct' || p === 'inherit' ? p : 'custom';
}

function cloneSettings(s: Settings): Settings {
  return {
    ...s,
    defaultSpec: { ...s.defaultSpec, extraArgs: [...s.defaultSpec.extraArgs] },
    emulatorExtraArgs: [...s.emulatorExtraArgs],
  };
}

export function SettingsDialog({
  settings,
  sdk,
  home,
  onClose,
  onSaved,
  onManageSdk,
}: {
  settings: Settings;
  sdk?: SdkInfo;
  home?: string;
  onClose: () => void;
  onSaved: (settings: Settings) => void;
  onManageSdk: () => void;
}) {
  /** Snapshot the draft started from; saving sends only the differences to it. */
  const [base, setBase] = useState<Settings>(() => cloneSettings(settings));
  const [draft, setDraft] = useState<Settings>(() => cloneSettings(settings));
  const [mode, setModeState] = useState<ProxyMode>(proxyMode(settings.proxy));
  const [customProxy, setCustomProxyState] = useState(proxyMode(settings.proxy) === 'custom' ? settings.proxy : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = useRef(false);

  // The snapshot MainView holds may be stale (settings changed through the CLI): start from what is on disk,
  // and follow external changes until the user edits something.
  const reseed = useCallback(async () => {
    try {
      const fresh = await avdm.getSettings();
      if (dirty.current) return;
      setBase(cloneSettings(fresh));
      setDraft(cloneSettings(fresh));
      setModeState(proxyMode(fresh.proxy));
      setCustomProxyState(proxyMode(fresh.proxy) === 'custom' ? fresh.proxy : '');
    } catch {
      // keep the snapshot we were given
    }
  }, []);
  useEffect(() => {
    void reseed();
  }, [reseed]);
  useAvdmEvent('settings-changed', () => void reseed());

  const set = <K extends keyof Settings>(key: K, v: Settings[K]) => {
    dirty.current = true;
    setDraft((d) => ({ ...d, [key]: v }));
  };
  const setMode = (m: ProxyMode) => {
    dirty.current = true;
    setModeState(m);
  };
  const setCustomProxy = (p: string) => {
    dirty.current = true;
    setCustomProxyState(p);
  };
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const images = sdk?.images ?? [];

  const problems = useMemo(() => {
    const p = specProblems(draft.defaultSpec).map((x) => `默认规格：${x}`);
    if (!draft.sdkRoot.trim()) p.push('SDK 路径不能为空');
    if (!Number.isInteger(draft.maxRunning) || draft.maxRunning < 1 || draft.maxRunning > 64) p.push('最大运行数需为 1–64');
    if (!Number.isInteger(draft.memoryReserveMb) || draft.memoryReserveMb < 0) p.push('内存保留需为非负整数');
    if (!(draft.bootTimeoutSec >= 30)) p.push('启动超时至少 30 秒');
    if (!(draft.healthIntervalSec >= 1)) p.push('健康检查间隔至少 1 秒');
    if (mode === 'custom' && !customProxy.trim()) p.push('请填写代理地址');
    return p;
  }, [draft, mode, customProxy]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next: Settings = {
        ...draft,
        sdkRoot: draft.sdkRoot.trim(),
        scrcpyPath: draft.scrcpyPath.trim(),
        proxy: mode === 'custom' ? customProxy.trim() : mode,
      };
      // Only the changed keys: settings changed elsewhere meanwhile (CLI) must not be reverted.
      const patch = settingsPatch(base, next);
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      const saved = await avdm.updateSettings(patch);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="设置"
      subtitle={home ? `数据目录：${home}` : undefined}
      onClose={onClose}
      busy={busy}
      width={660}
      footer={
        <>
          <button className="btn footer-left" onClick={onManageSdk} disabled={busy}>
            <Icon name="download" />
            管理 SDK 组件…
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || problems.length > 0}>
            {busy ? <Spinner size={12} /> : <Icon name="check" />}
            保存
          </button>
        </>
      }
    >
      <div className="section-title first">SDK</div>
      <div className="form-grid">
        <label className="field span-2">
          <span className="field-label">Android SDK 路径</span>
          <input type="text" value={draft.sdkRoot} spellCheck={false} onChange={(e) => set('sdkRoot', e.target.value)} />
          <span className="hint">
            {sdk ? (sdk.exists ? `模拟器 ${sdk.emulator?.version ?? '未安装'} · 已安装镜像 ${sdk.images.length} 个` : '目录不存在，安装向导会创建它') : ''}
          </span>
        </label>
        <label className="field span-2">
          <span className="field-label">默认系统镜像</span>
          <select value={draft.defaultImage} onChange={(e) => set('defaultImage', e.target.value)}>
            {!images.some((i) => i.packagePath === draft.defaultImage) && (
              <option value={draft.defaultImage}>
                {imageLabel(draft.defaultImage)}（未安装）
              </option>
            )}
            {images.map((img) => (
              <option key={img.packagePath} value={img.packagePath}>
                {imageLabel(img.packagePath, img)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="section-title">运行与资源</div>
      <div className="form-grid cols-3">
        <label className="field">
          <span className="field-label">最大同时运行数</span>
          <input type="number" min={1} max={64} value={Number.isFinite(draft.maxRunning) ? draft.maxRunning : ''} onChange={(e) => set('maxRunning', num(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">为系统保留内存（MB）</span>
          <input
            type="number"
            min={0}
            step={512}
            value={Number.isFinite(draft.memoryReserveMb) ? draft.memoryReserveMb : ''}
            onChange={(e) => set('memoryReserveMb', num(e.target.value))}
          />
        </label>
        <label className="field">
          <span className="field-label">启动超时（秒）</span>
          <input type="number" min={30} value={Number.isFinite(draft.bootTimeoutSec) ? draft.bootTimeoutSec : ''} onChange={(e) => set('bootTimeoutSec', num(e.target.value))} />
        </label>
        <label className="field">
          <span className="field-label">健康检查间隔（秒）</span>
          <input
            type="number"
            min={1}
            value={Number.isFinite(draft.healthIntervalSec) ? draft.healthIntervalSec : ''}
            onChange={(e) => set('healthIntervalSec', num(e.target.value))}
          />
        </label>
        <label className="field span-2">
          <span className="field-label">scrcpy 路径</span>
          <input type="text" value={draft.scrcpyPath} placeholder="留空则自动查找（PATH / Homebrew）" spellCheck={false} onChange={(e) => set('scrcpyPath', e.target.value)} />
        </label>
      </div>

      <div className="section-title">模拟器网络</div>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">代理</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as ProxyMode)}>
            <option value="direct">直连（忽略系统代理环境变量）</option>
            <option value="inherit">继承管理器的代理环境变量</option>
            <option value="custom">自定义 HTTP 代理</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">代理地址</span>
          <input
            type="text"
            value={customProxy}
            disabled={mode !== 'custom'}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            onChange={(e) => setCustomProxy(e.target.value)}
          />
        </label>
        <label className="field span-2">
          <span className="field-label">所有实例的额外启动参数</span>
          <ArgsInput value={draft.emulatorExtraArgs} placeholder="例如 -no-audio" onChange={(args) => set('emulatorExtraArgs', args)} />
        </label>
      </div>

      <div className="section-title">新实例默认规格</div>
      <SpecFields value={draft.defaultSpec} onChange={(spec: InstanceSpec) => set('defaultSpec', spec)} />

      {problems.length > 0 && <div className="form-problems">{problems.join('；')}</div>}
      {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
