import { useState } from 'react';
import { RESOURCE_NAME, type ResourceType } from '@avdm/automation/wanlong/pure';
import goldIcon from '../assets/resources/gold.png';
import ironIcon from '../assets/resources/iron.png';
import manaIcon from '../assets/resources/mana.png';
import woodIcon from '../assets/resources/wood.png';
import './ResourceBadge.css';

/** Transparent resource art (resources/icons/raw → scripts/resource-icons.mjs → assets/resources/<type>.png). */
export const RESOURCE_ICON: Readonly<Record<ResourceType, string>> = { gold: goldIcon, wood: woodIcon, iron: ironIcon, mana: manaIcon };

/** One character per resource, on the resource's series colour: the fallback when an icon cannot be shown. */
export const RESOURCE_GLYPH: Readonly<Record<ResourceType, string>> = { gold: '金', wood: '木', iron: '铁', mana: '魔' };

/**
 * Resource badge (original ResourceBadge): the resource icon, or a glyph on the resource colour when the image cannot
 * load. Shared by the statistics page and the gather pages.
 */
export function ResourceBadge({ type, size = 22, title }: { type: ResourceType; size?: number; title?: string }) {
  const [broken, setBroken] = useState(false);
  const label = RESOURCE_NAME[type];
  if (!broken) {
    return (
      <span className="resource-badge has-icon" style={{ width: size, height: size }} role="img" aria-label={label} title={title ?? label}>
        <img src={RESOURCE_ICON[type]} alt="" draggable={false} onError={() => setBroken(true)} />
      </span>
    );
  }
  return (
    <span
      className={`resource-badge is-${type}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.55)) }}
      role="img"
      aria-label={label}
      title={title ?? label}
    >
      {RESOURCE_GLYPH[type]}
    </span>
  );
}
