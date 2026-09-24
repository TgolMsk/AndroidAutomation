/**
 * Settings → 「通知与推送」 (original `features/alerts/AlertSettingsCard.tsx`): Telegram and local notifications with a
 * test push, the robot switches, the detection thresholds, 「卡死自动重启」 and the recent alerts.
 *
 * ★★ Credentials: main sends a masked view with no `botToken` key. A newly typed token lives only in `tokenInput`
 *    until the save patch carries it (empty input = keep the saved token); it is never stored or logged here.
 * ★ Defaults come from `defaultAlertsConfig()` and ranges from `ALERT_RANGE` — no literal defaults in this file.
 * ★ A form the user edited is never overwritten by pushes from main; an untouched one always takes the config that
 *   arrives (the first real load after the placeholder defaults included — `refillOnView`). 「测试推送」 saves a dirty
 *   form first (it tests what main has). The controls stay disabled until the first load answered.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ALERT_RANGE, ALERT_SPECS, FIELD_LABEL, NOTIFIER_LABEL, SUBSCRIBABLE_ALERT_TYPES, deliveryText, pausesInstance,
  type AlertDetectConfig, type AlertsConfigView, type NotifierId, type NotifyResult,
} from '../../../shared/alerts';
import type { FreezeInstanceStatus } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { saveAlertsConfig, testAlertPush, useAlerts } from '../../state/alerts';
import type { SettingsCardProps } from '../settings/cards';
import {
  defaultsKeepingContacts, draftFromView, durationText, formDirty, patchFromDraft, refillOnView, remotePreflight, saveProblems,
  telegramPreflight, type AlertsDraft, type AlertsFormState,
} from './alert-form';
import './alerts.css';

function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange(value: boolean): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="alerts-switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

function SwitchRow({ title, help, checked, disabled, onChange }: { title: string; help: ReactNode; checked: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  return (
    <div className="alerts-switch-row">
      <span><strong>{title}</strong><small className="alerts-help">{help}</small></span>
      <Switch checked={checked} label={title} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function NumberField({ label, value, range, step = 1, help, disabled, onChange }: {
  label: string; value: number; range: readonly [number, number]; step?: number; help?: string; disabled?: boolean; onChange(value: number): void;
}) {
  const invalid = !Number.isInteger(value) || value < range[0] || value > range[1];
  return (
    <label className={`alerts-field${invalid ? ' is-invalid' : ''}`} title={help}>
      <span>{label}</span>
      <input
        type="number" min={range[0]} max={range[1]} step={step} value={Number.isFinite(value) ? value : ''} disabled={disabled}
        aria-invalid={invalid} onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
      />
      {help && <small className="alerts-help">{help}</small>}
    </label>
  );
}

function TestResult({ result }: { result: NotifyResult }) {
  return (
    <div className={`alerts-result ${result.ok ? 'is-ok' : 'is-bad'}`} role="status" aria-live="polite">
      <strong>{NOTIFIER_LABEL[result.channel]}{result.ok ? '测试推送成功' : '测试推送失败'}</strong>
      <span>{result.message}</span>
      <small>
        尝试 {result.attempts} 次 · 耗时 {result.elapsedMs} ms · {beijingTime(result.at, 'full')}（北京时间）
        {result.retryAfterSec != null ? ` · 对方要求等待 ${result.retryAfterSec} 秒` : ''}
      </small>
    </div>
  );
}

export function AlertsSettingsCard({ visible }: SettingsCardProps) {
  const { config: view, configFromMain, loaded, error, history } = useAlerts();
  const toast = useToast();
  const [form, setForm] = useState<AlertsFormState>(() => ({ draft: draftFromView(view), touched: false }));
  const draft = form.draft;
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState<'save' | 'clear' | NotifierId | 'bot' | null>(null);
  const [testResult, setTestResult] = useState<NotifyResult | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [freeze, setFreeze] = useState<FreezeInstanceStatus[]>([]);
  const dirty = formDirty(form, view, tokenInput);

  const latest = useRef({ form, tokenInput });
  latest.current = { form, tokenInput };
  const shownView = useRef(view);
  // A config from main (the first real load, a save, a push) refills the form unless the user edited it.
  useEffect(() => {
    const previous = shownView.current;
    shownView.current = view;
    if (previous === view) return;
    const refilled = refillOnView(latest.current.form, previous, view, latest.current.tokenInput);
    if (refilled) setForm(refilled);
  }, [view]);

  // The watchdog's evidence, while the page is shown.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    const load = () => avdm.freezeStatus().then((items) => { if (active) setFreeze(items); }, () => undefined);
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [visible]);

  /** Every user edit goes through here: it marks the form as touched. */
  const edit = (update: (current: AlertsDraft) => AlertsDraft) => setForm((current) => ({ draft: update(current.draft), touched: true }));
  const change = (patch: Partial<AlertsDraft['telegram']>) => edit((current) => ({ ...current, telegram: { ...current.telegram, ...patch } }));
  const changeDetect = (patch: Partial<AlertDetectConfig>) => edit((current) => ({ ...current, detect: { ...current.detect, ...patch } }));
  const filled = (saved: AlertsConfigView) => setForm({ draft: draftFromView(saved), touched: false });
  // Until main answered, the form shows placeholder defaults: nothing may be saved from them.
  const disabled = busy !== null || !loaded;

  async function save(): Promise<boolean> {
    const blocking = saveProblems(draft, view, tokenInput);
    setProblems(blocking);
    if (blocking.length > 0) { toast.push({ kind: 'warn', title: '设置还不完整，先按提示补齐再保存' }); return false; }
    setBusy('save');
    try {
      const saved = await saveAlertsConfig(patchFromDraft(draft, tokenInput));
      filled(saved);
      // The token reached main; there is no reason to keep it on screen.
      setTokenInput('');
      toast.push({ kind: 'success', title: '通知与推送设置已保存' });
      return true;
    } catch (cause) {
      toast.error('无法保存通知与推送设置', cause);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function test(channel: NotifierId): Promise<void> {
    if (channel === 'telegram') {
      const preflight = telegramPreflight(draft, view, tokenInput);
      setProblems(preflight);
      if (preflight.length > 0) { toast.push({ kind: 'warn', title: '配置还不完整，先按下面的提示补齐再测' }); return; }
    }
    // The test uses the config main has saved: save pending edits first.
    if (dirty && !await save()) return;
    setBusy(channel);
    setTestResult(null);
    try {
      const result = await testAlertPush(channel);
      setTestResult(result);
      if (result.ok) toast.push({ kind: 'success', title: channel === 'telegram' ? '测试推送已发出，去手机上的 Telegram 看一眼' : result.message });
      else toast.error('测试推送失败', result.message);
    } catch (cause) {
      toast.error('无法测试推送', cause);
    } finally {
      setBusy(null);
    }
  }

  async function clearToken(): Promise<void> {
    setBusy('clear');
    try {
      const saved = await saveAlertsConfig({ telegram: { botToken: '' } });
      filled(saved);
      setTokenInput('');
      toast.push({ kind: 'success', title: '已清除保存的 Bot Token，Telegram 推送与机器人都已关闭' });
    } catch (cause) {
      toast.error('清除 Token 失败', cause);
      throw cause;
    } finally {
      setBusy(null);
    }
  }

  async function testBot(): Promise<void> {
    setBusy('bot');
    try {
      const result = await avdm.testRemoteBot();
      if (result.ok) toast.push({ kind: 'success', title: result.message });
      else toast.error('机器人测试未通过', result.message);
    } catch (cause) {
      toast.error('无法测试机器人', errMsg(cause));
    } finally {
      setBusy(null);
    }
  }

  const tokenPlaceholder = view.telegram.botTokenSet ? `已配置 ${view.telegram.botTokenMasked}（留空表示不修改）` : '形如 123456789:AAE…（找 @BotFather 发 /newbot 拿）';
  const recent = history.slice(0, 5);
  const botProblems = draft.telegram.remoteControlEnabled || draft.telegram.remoteReadOnlyEnabled ? remotePreflight(draft, view, tokenInput) : [];

  return (
    <Card
      title="通知与推送" icon="alert"
      extra={<>
        <button type="button" className="btn sm" disabled={disabled} onClick={() => { edit(defaultsKeepingContacts); toast.push({ kind: 'info', title: '已填入默认值，点「保存」才会生效（Token、Chat ID 与授权用户 ID 保持不变）' }); }}>恢复默认值</button>
        <button type="button" className="btn sm primary" disabled={disabled || !dirty} onClick={() => void save()}>{busy === 'save' ? <Spinner size={12} /> : <Icon name="check" size={14} />}保存</button>
      </>}
    >
      <div className="alerts-settings">
        {loaded && error && <p className="notice warn" role="alert">告警设置没能读到：{error}</p>}
        {loaded && !error && !configFromMain && <p className="notice info">当前显示的是默认值，点「保存」会以这里的值为准写入。</p>}
        <p className="alerts-intro">
          被顶号、弹维护 / 更新公告、模拟器崩溃、网络断开，都会让采集卡在认不出的界面上。助手的兜底判定是「未知界面恢复阶梯连续用尽」或
          「连续多轮采集失败」就<strong>关掉这个实例的自动调度</strong>（不再排唤醒、不再操作游戏）、留一张现场截图并推送；处理完之后到
          「采集总览」的红色横幅上点「恢复」。模拟器<strong>卡死</strong>（画面长时间纹丝不动或截图一直超时，但进程还在）是另一条路，见下方「卡死自动重启」。
        </p>
        {dirty && <p className="alerts-help">有未保存的改动。</p>}

        <section className="alerts-section" aria-label="Telegram 推送">
          <h3 className="alerts-section-title">Telegram 推送<small>{view.telegram.enabled ? '已开启' : '未开启'}</small></h3>
          <SwitchRow title="开启 Telegram 推送" help="关掉之后异常照样检测、照样暂停，只是不往外发消息。" checked={draft.telegram.enabled} disabled={disabled} onChange={(enabled) => change({ enabled })} />
          <div className="alerts-fields is-wide">
            <label className="alerts-field">
              <span>Bot Token {view.telegram.botTokenSet ? `（已配置 ${view.telegram.botTokenMasked}）` : '（未配置）'}</span>
              <input type="password" autoComplete="off" value={tokenInput} placeholder={tokenPlaceholder} disabled={disabled} onChange={(event) => { setTokenInput(event.target.value); setForm((current) => (current.touched ? current : { ...current, touched: true })); }} />
              <small className="alerts-help">
                在 Telegram 里搜 <strong>@BotFather</strong> → 发 <code>/newbot</code> → 按提示起名字，它会回一行 <code>123456789:AAE…</code>，
                只复制冒号连着的那一整串（别把前面的「HTTP API:」一起粘进来）。Token 等同于密码：用系统钥匙串加密保存，界面上不显示任何一位，
                也不会写进日志或错误信息。留空表示不修改已保存的值。
              </small>
            </label>
            <div className="alerts-actions">
              <button type="button" className="btn sm danger-ghost" disabled={disabled || !view.telegram.botTokenSet} onClick={() => setConfirmClear(true)}>清除 Token</button>
            </div>
            <label className="alerts-field">
              <span>Chat ID</span>
              <input type="text" inputMode="numeric" autoComplete="off" value={draft.telegram.chatId} placeholder="例如 123456789 或 -1001234567890" disabled={disabled} onChange={(event) => change({ chatId: event.target.value })} />
              <small className="alerts-help">
                先给你的机器人随便发一条消息（否则它没权限主动找你），然后找 <strong>@userinfobot</strong> 发一句话，它会回你的数字 id。
                推到群里就把机器人拉进群，用 <strong>@getidsbot</strong> 拿群 id（群和频道是负数，形如 -1001234567890）。这里只认数字，@用户名 不支持。
              </small>
            </label>
          </div>
          <div className="alerts-fields">
            <NumberField label={FIELD_LABEL['cooldownSeconds']!} value={draft.telegram.cooldownSeconds} range={ALERT_RANGE.cooldownSeconds} step={60} disabled={disabled}
              help="同一实例同一原因在这段时间内只推一次；期间被压掉几条会在下次推送里带出来。" onChange={(cooldownSeconds) => change({ cooldownSeconds })} />
            <NumberField label={FIELD_LABEL['retryCount']!} value={draft.telegram.retryCount} range={ALERT_RANGE.retryCount} disabled={disabled}
              help="不含首次。Token / Chat ID 配错这类错误不会重试。" onChange={(retryCount) => change({ retryCount })} />
            <NumberField label={FIELD_LABEL['timeoutMs']!} value={draft.telegram.timeoutMs} range={ALERT_RANGE.timeoutMs} step={1000} disabled={disabled}
              help="国内直连 api.telegram.org 经常连不上，需要代理时把这个调大一点。" onChange={(timeoutMs) => change({ timeoutMs })} />
          </div>
          <SwitchRow title="本机通知" help="在 macOS 通知中心也提醒一次（与 Telegram 共用下面的订阅与冷却）。" checked={draft.local.enabled} disabled={disabled}
            onChange={(enabled) => edit((current) => ({ ...current, local: { enabled } }))} />
          <div className="alerts-field">
            <span>推送哪些事件（不勾的事件照样检测、该暂停照样暂停，只是不推送）</span>
            <div className="alerts-events">
              {SUBSCRIBABLE_ALERT_TYPES.map((type) => (
                <label key={type} className="alerts-event" title={ALERT_SPECS[type].summary}>
                  <input
                    type="checkbox" checked={draft.telegram.subscribedTypes.includes(type)} disabled={disabled}
                    onChange={(event) => change({ subscribedTypes: event.target.checked
                      ? SUBSCRIBABLE_ALERT_TYPES.filter((item) => item === type || draft.telegram.subscribedTypes.includes(item))
                      : draft.telegram.subscribedTypes.filter((item) => item !== type) })}
                  />
                  {ALERT_SPECS[type].title}
                  {pausesInstance(type) && <span className="alerts-event-pauses">会暂停任务</span>}
                </label>
              ))}
            </div>
          </div>
          <div className="alerts-actions">
            <button type="button" className="btn sm" disabled={disabled} onClick={() => void test('telegram')}>{busy === 'telegram' ? <Spinner size={12} /> : <Icon name="external" size={14} />}测试 Telegram 推送</button>
            <button type="button" className="btn sm" disabled={disabled} onClick={() => void test('local')}>{busy === 'local' ? <Spinner size={12} /> : <Icon name="alert" size={14} />}测试本机通知</button>
            <span className="alerts-help">用的是已保存的配置；有没保存的改动会先自动保存再测。</span>
          </div>
          {problems.length > 0 && <ul className="alerts-problems" role="alert">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          {testResult && <TestResult result={testResult} />}
        </section>

        <section className="alerts-section" aria-label="手机机器人">
          <h3 className="alerts-section-title">手机机器人<small>只响应上面的 Chat ID 与下面的授权用户</small></h3>
          <SwitchRow title="允许手机查看状态与截图" help="在授权会话里用 /status 查看实例状态，/shot 1 取实例 #1 的当前游戏画面。默认关闭。"
            checked={draft.telegram.remoteReadOnlyEnabled} disabled={disabled} onChange={(remoteReadOnlyEnabled) => change({ remoteReadOnlyEnabled })} />
          <SwitchRow
            title={view.remoteControlAvailable ? '允许手机远程操作' : '允许手机远程操作（机器人模块接入后生效）'}
            help={view.remoteControlAvailable
              ? '打开后，会暂停任务的告警消息下面带「恢复自动调度」「重启游戏并恢复」「查看状态」按钮，由机器人执行、只认授权用户。默认关闭；它不会顺带打开上面的查看状态与截图。'
              : '这一版还没有处理这些按钮的机器人：打开也不会在告警消息下面附加任何按钮，也不会顺带打开上面的查看状态与截图。默认关闭。'}
            checked={draft.telegram.remoteControlEnabled} disabled={disabled} onChange={(remoteControlEnabled) => change({ remoteControlEnabled })}
          />
          <label className="alerts-field">
            <span>授权用户 ID</span>
            <input type="text" inputMode="numeric" autoComplete="off" value={draft.telegram.authorizedUserId} placeholder="发命令的 Telegram 用户数字 ID" disabled={disabled}
              onChange={(event) => change({ authorizedUserId: event.target.value })} />
          </label>
          {botProblems.length > 0 && <ul className="alerts-problems">{botProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
          <div className="alerts-actions">
            <button type="button" className="btn sm" disabled={disabled || dirty || !view.telegram.remoteReadOnlyEnabled} onClick={() => void testBot()}>{busy === 'bot' ? <Spinner size={12} /> : <Icon name="external" size={14} />}测试机器人连接</button>
            {dirty && <span className="alerts-help">先保存再测试。</span>}
          </div>
        </section>

        <section className="alerts-section" aria-label="异常判定阈值">
          <h3 className="alerts-section-title">异常判定阈值</h3>
          <SwitchRow title={FIELD_LABEL['autoPauseEnabled']!} help="关掉之后只记录告警、只推送，不动自动调度开关（排查期可能想让它继续跑）。"
            checked={draft.detect.autoPauseEnabled} disabled={disabled} onChange={(autoPauseEnabled) => changeDetect({ autoPauseEnabled })} />
          <div className="alerts-fields">
            <NumberField label={FIELD_LABEL['cycleFailThreshold']!} value={draft.detect.cycleFailThreshold} range={ALERT_RANGE.cycleFailThreshold} disabled={disabled}
              help="调小会因为一次偶发的截图超时就误暂停；调大会让坏状态多跑十几分钟。" onChange={(cycleFailThreshold) => changeDetect({ cycleFailThreshold })} />
            <NumberField label={FIELD_LABEL['recoveryFailThreshold']!} value={draft.detect.recoveryFailThreshold} range={ALERT_RANGE.recoveryFailThreshold} disabled={disabled}
              help="「关弹窗 → BACK → 冷启动游戏」全走完还回不到世界地图，是比普通失败强得多的信号，所以默认比上一项小。" onChange={(recoveryFailThreshold) => changeDetect({ recoveryFailThreshold })} />
            <NumberField label={FIELD_LABEL['sampleFailThreshold']!} value={draft.detect.sampleFailThreshold} range={ALERT_RANGE.sampleFailThreshold} disabled={disabled}
              help="连着读不出「部队管理」面板，通常是模拟器关了或 adb 断了。" onChange={(sampleFailThreshold) => changeDetect({ sampleFailThreshold })} />
            <NumberField label={FIELD_LABEL['stalledMinutes']!} value={draft.detect.stalledMinutes} range={ALERT_RANGE.stalledMinutes} step={10} disabled={disabled}
              help="兵力不够 / 队列一直满 / 搜不到合格资源点。只是提醒，不会暂停任务。" onChange={(stalledMinutes) => changeDetect({ stalledMinutes })} />
          </div>
          <SwitchRow title="尝试精确识别「被顶号」" help="用模板集里的 tpl_dlg_kicked / tpl_login_screen / tpl_dlg_maintenance / tpl_dlg_update 判断；这些模板还没有时打开也只是空跑，不报错、不影响采集，顶号会被上面的通用兜底接住。"
            checked={draft.detect.kickedProbeEnabled} disabled={disabled} onChange={(kickedProbeEnabled) => changeDetect({ kickedProbeEnabled })} />
        </section>

        <section className="alerts-section" aria-label="卡死自动重启">
          <h3 className="alerts-section-title">卡死自动重启<small>{draft.detect.freezeRestartEnabled ? '已开启' : '默认关闭'}</small></h3>
          <SwitchRow
            title="画面长时间不动时自动重启模拟器"
            help="判据是像素级的：健康探针（默认每 3 分钟）和采样截到的图连续一模一样、或截图一直超时但模拟器进程还在，就判定卡死。开启后自动强制重启该实例（冷启动）→ 重新连接 adb → 用 monkey 拉起游戏 → 等主界面，全程约 3~5 分钟，自动调度接着跑。关闭时只推一条「疑似模拟器卡死」提醒，采样随后连续失败会按「掉线」暂停。"
            checked={draft.detect.freezeRestartEnabled} disabled={disabled} onChange={(freezeRestartEnabled) => changeDetect({ freezeRestartEnabled })}
          />
          <div className="alerts-fields">
            <NumberField label={FIELD_LABEL['freezeMinutes']!} value={draft.detect.freezeMinutes} range={ALERT_RANGE.freezeMinutes} disabled={disabled}
              help="至少要跨两次健康探针，实际发现时间 ≈ 这个值 + 一个探针间隔。" onChange={(freezeMinutes) => changeDetect({ freezeMinutes })} />
            <NumberField label={FIELD_LABEL['freezeRestartLimit']!} value={draft.detect.freezeRestartLimit} range={ALERT_RANGE.freezeRestartLimit} disabled={disabled}
              help="超过就不再重启，改判「模拟器或游戏掉线」暂停并推送（防「重启 → 又卡 → 再重启」死循环）。" onChange={(freezeRestartLimit) => changeDetect({ freezeRestartLimit })} />
            <NumberField label={FIELD_LABEL['freezeRestartWindowMin']!} value={draft.detect.freezeRestartWindowMin} range={ALERT_RANGE.freezeRestartWindowMin} step={10} disabled={disabled}
              help="上一项按这个时间窗口滚动计数。" onChange={(freezeRestartWindowMin) => changeDetect({ freezeRestartWindowMin })} />
          </div>
          {freeze.length > 0 && (
            <ul className="alerts-freeze-list" aria-label="卡死看门狗当前证据">
              {freeze.map((item) => (
                <li key={item.index}>
                  实例 #{item.index}：{item.recovering ? '正在自动重启…' : item.staticFrames >= 2 ? `画面 ${durationText(item.staticForMs)}没变（${item.staticFrames} 帧）` : '画面在动'}
                  {item.captureFailures > 0 ? `；截图连续失败 ${item.captureFailures} 次` : ''}
                  ；{item.restartWindowMin} 分钟内已自动重启 {item.restartsUsed}/{item.restartLimit} 次
                </li>
              ))}
            </ul>
          )}
        </section>

        {recent.length > 0 && (
          <section className="alerts-section" aria-label="最近告警">
            <h3 className="alerts-section-title">最近告警<small>保留最近 100 条</small></h3>
            <ul className="alerts-history">
              {recent.map((record) => (
                <li key={record.event.id}>
                  <time>{beijingTime(record.event.at, 'short')}</time>
                  <strong>实例 #{record.event.instanceIndex}｜{ALERT_SPECS[record.event.type].title}</strong>
                  <span className="alerts-reason" title={record.event.reason}>{record.event.reason}</span>
                  <span className="alerts-delivery">{deliveryText(record)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {confirmClear && (
        <ConfirmDialog
          title="清除已保存的 Bot Token？" confirmLabel="清除" danger
          message="清掉之后 Telegram 推送与手机机器人会立刻停止工作，需要重新填一个才能恢复。"
          onConfirm={() => clearToken()} onClose={() => setConfirmClear(false)}
        />
      )}
    </Card>
  );
}
