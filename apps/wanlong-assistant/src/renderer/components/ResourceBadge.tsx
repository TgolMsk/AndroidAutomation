import { RESOURCE_NAME, type ResourceType } from '@avdm/automation/wanlong/pure';
import './ResourceBadge.css';

/** One character per resource, on the resource's series colour (no game art is shipped). */
export const RESOURCE_GLYPH: Readonly<Record<ResourceType, string>> = { gold: '金', wood: '木', iron: '铁', mana: '魔' };

/**
 * Resource badge (original ResourceBadge's text fallback): a glyph on the resource colour, used by the statistics
 * page and the gather pages. The colours come from the design tokens only.
 */
export function ResourceBadge({ type, size = 22 }: { type: ResourceType; size?: number }) {
  return (
    <span
      className={`resource-badge is-${type}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.55)) }}
      role="img"
      aria-label={RESOURCE_NAME[type]}
      title={RESOURCE_NAME[type]}
    >
      {RESOURCE_GLYPH[type]}
    </span>
  );
}
