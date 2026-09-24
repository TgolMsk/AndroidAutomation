import { useEffect, useState } from 'react';
import type { ImeStatus } from '../../../main/plans/types';
import { avdm, errMsg } from '../../api';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import type { DeviceToolSlotProps } from '../settings/device-tool-slots';

/** One line for the slot: the check result, a check failure, or why nothing is shown yet (pure). */
export function imeToolLine(index: number | null, status: ImeStatus | null, error: string | null): string {
  if (index === null) return '选择一个运行中的实例后显示它的中文输入法状态。';
  if (error) return `检查失败（${error}）。请确认实例已开机且 adb 连接正常后点「重新检查」。`;
  return status ? status.message : '正在检查…';
}

/**
 * 设置 → 设备工具 → 中文输入法 (original device:setupIme): the script engine's ADBKeyboard check and setup
 * (`imeStatus` / `imeSetup`) for the instance picked in the card. The APK is always the user's own file; the setup
 * takes the instance lease, so it is refused while a script, gather or login uses the instance.
 */
export function ImeTool({ index, busy }: DeviceToolSlotProps) {
  const toast = useToast();
  const [status, setStatus] = useState<ImeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState(0);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    setStatus(null);
    setError(null);
    if (index === null) return;
    let active = true;
    void avdm.imeStatus(index).then((next) => { if (active) setStatus(next); }, (cause: unknown) => { if (active) setError(errMsg(cause)); });
    return () => { active = false; };
  }, [index, check]);

  async function setup(): Promise<void> {
    if (index === null || working || busy) return;
    setWorking(true);
    try {
      const next = await avdm.imeSetup(index);
      if (next) {
        setStatus(next);
        setError(null);
        toast.push({ kind: next.available ? 'success' : 'warn', title: next.available ? 'ADBKeyboard 已启用' : 'ADBKeyboard 尚未可用', detail: next.message });
      }
    } catch (cause) {
      toast.error('安装输入法失败', errMsg(cause));
    } finally {
      setWorking(false);
    }
  }

  const disabled = index === null || busy || working;
  return (
    <div className="settings-device-slot">
      <strong>中文输入法（ADBKeyboard）</strong>
      <p className={status?.available ? 'settings-muted' : undefined} role={error ? 'alert' : undefined}>{imeToolLine(index, status, error)}</p>
      <div className="settings-device-row">
        <button type="button" className="btn sm" onClick={() => void setup()} disabled={disabled || status?.available === true}
          title={status?.available ? '已可用，无需安装' : undefined}>
          {working && <Spinner size={12} />}安装并启用中文输入法…
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setCheck((value) => value + 1)} disabled={disabled}>重新检查</button>
      </div>
      <p className="settings-muted">选择你自己下载的 ADBKeyboard 安装包，装到所选实例并设为当前输入法（助手不附带安装包）。脚本里的中文只能经它输入。</p>
    </div>
  );
}
