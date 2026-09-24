import { useEffect, useState } from 'react';
import {
  APP_LOG_PERSIST_LABEL, APP_LOG_PERSIST_LEVELS, APP_SETTINGS_RANGE, MIN_CAPTURE_INTERVAL_MS, SHOT_POLICIES, SHOT_POLICY_LABEL,
  defaultAppSettings, type AppSettings,
} from '../../../shared/app-settings';
import { errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { saveAppSettings, useAppSettings } from '../../hooks/useAppSettings';
import { appSettingsPatch, appSettingsProblems, numberInput } from './settings-form';

/**
 * 面板设置 (the original panel settings that still mean something on AVD instances). Every default is measured;
 * read the help line under a field before changing it.
 */
export function PanelSettingsCard() {
  const toast = useToast();
  const { view, error } = useAppSettings();
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = view?.settings ?? null;

  // Follow the saved settings until the user starts editing (and again after each save).
  useEffect(() => {
    if (saved && (!draft || JSON.stringify(appSettingsPatch(saved, draft)) === '{}')) setDraft(saved);
  }, [saved]);

  if (!saved || !draft) {
    return (
      <Card title="面板设置" icon="settings">
        {error ? <p className="settings-error" role="alert">读取应用设置失败：{error}</p> : <p className="settings-muted"><Spinner size={12} /> 正在读取…</p>}
      </Card>
    );
  }

  const problems = appSettingsProblems(draft);
  const patch = appSettingsPatch(saved, draft);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  async function save(): Promise<void> {
    if (!dirty || problems.length > 0 || saving) return;
    setSaving(true);
    try {
      const next = await saveAppSettings(patch);
      setDraft(next.settings);
      toast.push({ kind: 'success', title: '设置已保存' });
    } catch (cause) {
      toast.error('保存设置失败', errMsg(cause));
    } finally {
      setSaving(false);
    }
  }

  function restoreDefaults(): void {
    setDraft(defaultAppSettings());
    toast.push({ kind: 'info', title: '已填入默认值，记得点「保存」才会生效' });
  }

  const reason = problems[0] ?? (dirty ? undefined : '没有改动');
  return (
    <Card
      title="面板设置" icon="settings"
      extra={(
        <>
          <button type="button" className="btn sm" onClick={restoreDefaults} disabled={saving}>恢复默认值</button>
          <button type="button" className="btn sm primary" onClick={() => void save()} disabled={!dirty || problems.length > 0 || saving} title={reason}>
            {saving ? <Spinner size={12} /> : <Icon name="check" size={14} />}保存
          </button>
        </>
      )}
    >
      {view?.warning && <div className="notice warn" role="alert"><Icon name="alert" /><span>{view.warning}</span></div>}
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="settings-field">
          <label htmlFor="settings-shot-policy">截图留痕策略</label>
          <select id="settings-shot-policy" value={draft.shotPolicy} onChange={(event) => set('shotPolicy', event.target.value as AppSettings['shotPolicy'])}>
            {SHOT_POLICIES.map((policy) => <option key={policy} value={policy}>{SHOT_POLICY_LABEL[policy]}</option>)}
          </select>
          <p>
            管告警现场截图和脚本运行的留痕：「不留痕」时一张都不存；「仅失败时留痕」只存告警现场与失败步骤；
            「每步都留痕」还给脚本的每一步都留图（很占磁盘，只在排查问题时临时开）。脚本里的「截图」步骤和勾了「保存执行截图」的步骤
            总会保存，不受它影响；启动脚本时也可以只为这一次另选。采集流程的现场截图接入后同样跟随它。
          </p>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-capture-interval">单实例最小截图间隔（毫秒）</label>
          <input
            id="settings-capture-interval" type="number" inputMode="numeric"
            min={APP_SETTINGS_RANGE.minCaptureIntervalMs.min} max={APP_SETTINGS_RANGE.minCaptureIntervalMs.max} step={APP_SETTINGS_RANGE.minCaptureIntervalMs.step}
            value={Number.isNaN(draft.minCaptureIntervalMs) ? '' : draft.minCaptureIntervalMs}
            onChange={(event) => set('minCaptureIntervalMs', numberInput(event.target.value))}
          />
          <p>低于 {MIN_CAPTURE_INTERVAL_MS} 没有意义：模拟器截图吞吐上限约 4.3 帧/秒，调小只会排队。所有截图（采集、脚本、探测、机器人）都按实例排队执行。</p>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-threshold">默认命中阈值</label>
          <input
            id="settings-threshold" type="number" inputMode="decimal"
            min={APP_SETTINGS_RANGE.matchThreshold.min} max={APP_SETTINGS_RANGE.matchThreshold.max} step={APP_SETTINGS_RANGE.matchThreshold.step}
            value={Number.isNaN(draft.matchThreshold) ? '' : draft.matchThreshold}
            onChange={(event) => set('matchThreshold', numberInput(event.target.value))}
          />
          <p>脚本运行（计划与临时运行）与模板库「测试模板」在步骤和模板都没写阈值时用它（采集流程用自己的阈值，不受影响）。低于 0.7 会开始误判，高于 0.95 会漏判。</p>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-shrink">匹配降采样倍率</label>
          <input
            id="settings-shrink" type="number" inputMode="numeric"
            min={APP_SETTINGS_RANGE.shrink.min} max={APP_SETTINGS_RANGE.shrink.max} step={APP_SETTINGS_RANGE.shrink.step}
            value={Number.isNaN(draft.shrink) ? '' : draft.shrink}
            onChange={(event) => set('shrink', numberInput(event.target.value))}
          />
          <p>脚本运行与模板库「测试模板」共用这个倍率，测试结果与脚本实际看到的一致。2 是实测甜点：全屏匹配 87ms 降到 22ms，判别余量仍充足。</p>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-log-level">日志记录级别</label>
          <select id="settings-log-level" value={draft.logLevel} onChange={(event) => set('logLevel', event.target.value as AppSettings['logLevel'])}>
            {APP_LOG_PERSIST_LEVELS.map((level) => <option key={level} value={level}>{APP_LOG_PERSIST_LABEL[level]}</option>)}
          </select>
          <p>警告与错误总会写入日志文件（打包后的应用没有控制台可看）；一般信息量大，排查问题时再打开。</p>
        </div>
        <div className="settings-field">
          <label htmlFor="settings-locale">界面语言</label>
          <select id="settings-locale" value={draft.locale} disabled><option value="zh-CN">简体中文</option></select>
        </div>
        {problems.length > 0 && <ul className="settings-problems" role="alert">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      </form>
    </Card>
  );
}
