/**
 * Extra tools inside the 设备工具 card that other modules own. The script engine supplies the `ime` entry: its
 * 「安装并启用中文输入法」 tool (user-picked ADBKeyboard APK → install → `ime enable/set`, DECISIONS 脚本引擎).
 * Each slot gets the instance chosen in the card (null when none is running).
 */
import type { ComponentType } from 'react';
import { ImeTool } from '../runs/ImeTool';

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

export const DEVICE_TOOL_SLOTS: readonly DeviceToolSlot[] = [
  { key: 'ime', component: ImeTool },
];
