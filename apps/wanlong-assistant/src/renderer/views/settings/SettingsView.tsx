import type { ViewProps } from '../types';
import { SETTINGS_CARDS } from './cards';
import './SettingsView.css';

/**
 * 设置 (original SettingsView): panel settings, environment self-check, logs, data directories, the emulator
 * settings shared with the desktop manager, and the cards other modules mount (notifications, bot, AI, update,
 * legacy import). Two columns on wide windows, one on narrow ones. The cards come from `cards.ts`.
 */
export function SettingsView({ visible }: ViewProps) {
  const columns = (['main', 'side'] as const).map((column) => SETTINGS_CARDS.filter((card) => card.column === column));
  return (
    <div className="settings-view">
      {columns.map((cards, i) => (
        <div key={i} className="settings-column">
          {cards.map(({ key, component: CardComponent }) => <CardComponent key={key} visible={visible} />)}
        </div>
      ))}
    </div>
  );
}
