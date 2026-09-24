import { useEffect, useState } from 'react';
import type { Settings } from '@avdm/core';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { EMULATOR_SETTINGS_RANGE, emulatorSettingsProblems, numberInput, type EmulatorSettingsDraft } from './settings-form';

function draftOf(settings: Settings): EmulatorSettingsDraft {
  return { maxRunning: settings.maxRunning, healthIntervalSec: settings.healthIntervalSec, bootTimeoutSec: settings.bootTimeoutSec };
}

/**
 * The original panel's 「同时运行实例上限」 and 「实例状态轮询间隔」 now live in the emulator's own settings, shared
 * with 「AVD 多开管理器」 and the CLI: a change here applies to all three.
 */
export function EmulatorSettingsCard() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<EmulatorSettingsDraft | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = () => {
    avdm.getSettings().then((value) => {
      setSettings(value);
      setDraft((current) => (current && settings && JSON.stringify(current) !== JSON.stringify(draftOf(settings)) ? current : draftOf(value)));
      setError(undefined);
    }).catch((cause: unknown) => setError(errMsg(cause)));
  };
  useEffect(load, []);
  useAvdmEvent('settings-changed', load);

  if (!settings || !draft) {
    return (
      <Card title="模拟器参数（与多开管理器共用）" icon="devices">
        {error ? <p className="settings-error" role="alert">读取模拟器设置失败：{error}</p> : <p className="settings-muted"><Spinner size={12} /> 正在读取…</p>}
      </Card>
    );
  }

  const problems = emulatorSettingsProblems(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const set = (key: keyof EmulatorSettingsDraft, value: string) => setDraft((current) => (current ? { ...current, [key]: numberInput(value) } : current));

  async function save(): Promise<void> {
    if (!draft || !dirty || problems.length > 0 || saving) return;
    setSaving(true);
    try {
      const next = await avdm.updateSettings(draft);
      setSettings(next);
      setDraft(draftOf(next));
      toast.push({ kind: 'success', title: '模拟器参数已保存', detail: '多开管理器与命令行会使用同样的设置。' });
    } catch (cause) {
      toast.error('保存模拟器参数失败', errMsg(cause));
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof EmulatorSettingsDraft, label: string, help: string) => (
    <div className="settings-field">
      <label htmlFor={`settings-emulator-${key}`}>{label}</label>
      <input
        id={`settings-emulator-${key}`} type="number" inputMode="numeric"
        min={EMULATOR_SETTINGS_RANGE[key].min} max={EMULATOR_SETTINGS_RANGE[key].max} step={1}
        value={Number.isNaN(draft[key]) ? '' : draft[key]} onChange={(event) => set(key, event.target.value)}
      />
      <p>{help}</p>
    </div>
  );

  return (
    <Card
      title="模拟器参数（与多开管理器共用）" icon="devices"
      extra={(
        <button type="button" className="btn sm primary" onClick={() => void save()} disabled={!dirty || problems.length > 0 || saving} title={problems[0] ?? (dirty ? undefined : '没有改动')}>
          {saving ? <Spinner size={12} /> : <Icon name="check" size={14} />}保存
        </button>
      )}
    >
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {field('maxRunning', '同时运行实例上限', '每个实例开机后约常驻 1–2.3 GB 内存，游戏运行时还要更多；调高前先在「环境自检」里看一眼内存余量。')}
        {field('healthIntervalSec', '实例状态轮询间隔（秒）', '多开管理器按这个间隔检查实例是否还在运行，太快没有必要。')}
        {field('bootTimeoutSec', '开机等待上限（秒）', '启动实例后最多等这么久让 Android 开机完成，超时视为启动失败。')}
        {problems.length > 0 && <ul className="settings-problems" role="alert">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      </form>
      <p className="settings-muted">SDK 路径、默认镜像与新建实例的默认规格请在「AVD 多开管理器」的设置里修改。</p>
    </Card>
  );
}
