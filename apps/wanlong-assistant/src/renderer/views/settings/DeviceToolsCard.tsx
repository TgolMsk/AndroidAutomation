import { useEffect, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { OccupancyHolder } from '../../../shared/ipc';
import { isRetryLaterCode } from '../../../shared/errors';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { isRunning } from '../../format';
import { useSelection } from '../../state/selection';
import { DEVICE_TOOL_SLOTS } from './device-tool-slots';

/** The instance the card starts on: the global current one when it runs, else the first running one (pure). */
export function defaultToolIndex(instances: readonly InstanceState[], current: number | null): number | null {
  const running = instances.filter(isRunning);
  if (current !== null && running.some((instance) => instance.record.index === current)) return current;
  return running[0]?.record.index ?? null;
}

/** 「a.apk」 or 「a.apk 等 3 个文件」 (pure). */
export function apkSummary(paths: readonly string[]): string {
  const first = paths[0]?.split(/[\\/]/).pop() ?? '';
  return paths.length > 1 ? `${first} 等 ${paths.length} 个文件` : first;
}

/**
 * 设备工具 (original SettingsView 「设备工具」): pick a running instance, install an APK on it, and the Chinese
 * input method tool that the script engine plugs into `DEVICE_TOOL_SLOTS`. Installing waits on the instance's device
 * lane; when a gather, login or script is using the instance the user confirms first (installing a new game build
 * ends the running game).
 */
export function DeviceToolsCard() {
  const toast = useToast();
  const { instances, instancesLoaded, index: current } = useSelection();
  const [index, setIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ index: number; paths: string[]; holders: OccupancyHolder[] } | null>(null);

  const runningIndices = instances.filter(isRunning).map((instance) => instance.record.index);
  // Keep the choice while that instance runs; otherwise follow the global current / first running instance.
  useEffect(() => {
    if (index === null || !runningIndices.includes(index)) setIndex(defaultToolIndex(instances, current));
  }, [instances, current]);

  async function install(target: number, paths: string[]): Promise<void> {
    setBusy(true);
    setOutput(null);
    try {
      const out = await avdm.appInstallApk(target, paths);
      setOutput(out || null);
      toast.push({ kind: 'success', title: `实例 #${target} 已安装 ${apkSummary(paths)}` });
    } catch (cause) {
      if (isRetryLaterCode(errorCodeOf(cause))) toast.push({ kind: 'warn', title: '实例正忙，暂时不能安装', detail: errMsg(cause) });
      else toast.error('安装 APK 失败', errMsg(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pickAndInstall(): Promise<void> {
    if (index === null || busy) return;
    const target = index;
    let paths: string[];
    try { paths = await avdm.pickApks(); }
    catch (cause) { toast.error('无法打开文件选择框', errMsg(cause)); return; }
    if (paths.length === 0) return;
    let holders: OccupancyHolder[] = [];
    try { holders = (await avdm.instanceOccupancy(target)).filter((holder) => holder.blocking); }
    catch { /* Unknown occupancy: install anyway, the device lane still keeps adb calls in order. */ }
    if (holders.length > 0) setConfirm({ index: target, paths, holders });
    else await install(target, paths);
  }

  const noRunning = instancesLoaded && runningIndices.length === 0;
  const reason = busy ? '正在安装…' : index === null ? (noRunning ? '没有运行中的实例，请先启动实例' : '请先选择实例') : undefined;
  return (
    <Card title="设备工具" icon="package">
      <div className="settings-device-tools">
        <div className="notice warn">
          <Icon name="alert" />
          <span>中文输入必须装 ADBKeyboard：adb 自带的 input text 会静默丢弃所有非 ASCII 字符，打 80 个汉字和什么都不打一样。脚本里的中文只能经 ADBKeyboard（com.android.adbkeyboard）的 base64 广播输入。</span>
        </div>
        <div className="settings-device-row">
          <select
            aria-label="目标实例" value={index ?? ''} disabled={busy || !instancesLoaded}
            onChange={(event) => setIndex(event.target.value === '' ? null : Number(event.target.value))}
          >
            {index === null && <option value="">{noRunning ? '没有运行中的实例' : '选择目标实例'}</option>}
            {instances.map((instance) => (
              <option key={instance.record.index} value={instance.record.index} disabled={!isRunning(instance)}>
                实例 #{instance.record.index} · {instance.record.name}{isRunning(instance) ? '' : '（未运行）'}
              </option>
            ))}
          </select>
          <button type="button" className="btn sm" onClick={() => void pickAndInstall()} disabled={reason !== undefined} title={reason}>
            {busy ? <Spinner size={12} /> : <Icon name="download" size={14} />}安装 APK…
          </button>
        </div>
        {noRunning && <p className="settings-muted">只能对运行中、Android 已启动的实例操作。</p>}
        {output && <pre className="mono settings-device-output" aria-live="polite">{output}</pre>}
        {DEVICE_TOOL_SLOTS.map(({ key, component: Slot }) => <Slot key={key} index={index} busy={busy} />)}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`确认在实例 #${confirm.index} 上安装`}
          danger
          confirmLabel="仍然安装"
          message={(
            <>
              <ul className="confirm-list">{confirm.holders.map((holder) => <li key={holder.label}>实例 #{confirm.index} 正在{holder.label}</li>)}</ul>
              <p>安装会排在这些操作之后执行；如果安装的是游戏新版本，正在运行的游戏会被结束，采集或脚本会失败并在下次重试。确定继续吗？</p>
            </>
          )}
          onConfirm={() => install(confirm.index, confirm.paths)}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}
