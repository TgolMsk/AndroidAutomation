/**
 * Extra tools inside the 设备工具 card that other modules own. The script engine replaces the `ime` entry with its
 * 「安装并启用中文输入法」 tool (user-picked ADBKeyboard APK → install → `ime enable/set`, DECISIONS 脚本引擎) —
 * one line here, no other edit. Each slot gets the instance chosen in the card (null when none is running).
 */
import type { ComponentType } from 'react';

export interface DeviceToolSlotProps {
  /** A running instance picked in the card, or null. */
  index: number | null;
  /** True while the card itself runs a device action on that instance (disable conflicting buttons). */
  busy: boolean;
}

export interface DeviceToolSlot {
  key: 'ime' | string;
  component: ComponentType<DeviceToolSlotProps>;
}

/** Placeholder until the script engine plugs in its IME tool: says what it will do and why it is not here yet. */
function ImeSlotPlaceholder(_props: DeviceToolSlotProps) {
  return (
    <div className="settings-device-slot">
      <strong>中文输入法（ADBKeyboard）</strong>
      <div className="settings-device-row">
        <button type="button" className="btn sm" disabled title="由脚本引擎接入后可用">安装并启用中文输入法</button>
      </div>
      <p className="settings-muted">
        将由脚本执行模块提供：选择你自己下载的 ADBKeyboard 安装包，装到所选实例并设为当前输入法（助手不附带安装包）。
        在此之前，可先用上面的「安装 APK…」安装它，再在实例的系统设置里把它设为当前输入法。
      </p>
    </div>
  );
}

export const DEVICE_TOOL_SLOTS: readonly DeviceToolSlot[] = [
  { key: 'ime', component: ImeSlotPlaceholder },
];
