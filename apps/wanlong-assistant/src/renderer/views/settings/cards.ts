/**
 * The settings page is a list of cards, one file each. A module that owns a setting puts its card here: replace
 * the slot entry with the same `key` (版本与更新 → the update card, 通知与推送 → the alerts card, …) or append a new
 * entry. Order within a column is the order of this array.
 */
import type { ComponentType } from 'react';
import { AboutCard } from './AboutCard';
import { DataPathsCard } from './DataPathsCard';
import { DeviceToolsCard } from './DeviceToolsCard';
import { EmulatorSettingsCard } from './EmulatorSettingsCard';
import { FeatureLinksCard } from './FeatureLinksCard';
import { HealthCard } from './HealthCard';
import { LogsCard } from './LogsCard';
import { PanelSettingsCard } from './PanelSettingsCard';
import { ServiceFailuresCard } from './ServiceFailuresCard';
import { AiSlotCard, BotSlotCard, LegacyImportSlotCard, NotificationsSlotCard } from './SlotCards';
import { UpdateCard } from './UpdateCard';

export interface SettingsCardProps {
  /** False while the settings page is hidden (pause polling and live streams). */
  visible: boolean;
}

export type SettingsCardKey =
  | 'services' | 'panel' | 'emulator' | 'notifications' | 'bot' | 'ai' | 'logs' | 'health' | 'update' | 'paths'
  | 'legacyImport' | 'about' | 'deviceTools' | 'features';

export interface SettingsCardEntry {
  key: SettingsCardKey;
  /** `main` = the wide left column, `side` = the right column (a single column on narrow windows). */
  column: 'main' | 'side';
  component: ComponentType<SettingsCardProps>;
}

export const SETTINGS_CARDS: readonly SettingsCardEntry[] = [
  { key: 'services', column: 'main', component: ServiceFailuresCard },
  { key: 'panel', column: 'main', component: PanelSettingsCard },
  { key: 'notifications', column: 'main', component: NotificationsSlotCard },
  { key: 'bot', column: 'main', component: BotSlotCard },
  { key: 'ai', column: 'main', component: AiSlotCard },
  { key: 'features', column: 'main', component: FeatureLinksCard },
  { key: 'logs', column: 'main', component: LogsCard },
  { key: 'health', column: 'side', component: HealthCard },
  { key: 'update', column: 'side', component: UpdateCard },
  { key: 'emulator', column: 'side', component: EmulatorSettingsCard },
  { key: 'paths', column: 'side', component: DataPathsCard },
  { key: 'deviceTools', column: 'side', component: DeviceToolsCard },
  { key: 'legacyImport', column: 'side', component: LegacyImportSlotCard },
  { key: 'about', column: 'side', component: AboutCard },
];
