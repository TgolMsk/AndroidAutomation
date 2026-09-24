/**
 * Resource meta for the gather pages (original features/gather/types.ts GATHER_RESOURCE_META). Names come from the
 * single source `RESOURCE_LABEL`; this adds only the search-panel tap position. The badges themselves are the shared
 * icon badge (components/ResourceBadge.tsx: the original's processed resource icons, a glyph when one cannot load).
 */
import { RESOURCE_LABEL, type GatherResourceType } from '@avdm/automation/wanlong/pure';

export interface GatherResourceMeta {
  /** Name in the bag (木材 …). */
  resource: string;
  /** Category name in the world-map search panel (伐木场 …). */
  category: string;
  /** Category tap x in reference space (y 1310); display and troubleshooting only. */
  categoryTapX: number;
}

export const GATHER_RESOURCE_META: Readonly<Record<GatherResourceType, GatherResourceMeta>> = {
  wood: { ...RESOURCE_LABEL.wood, categoryTapX: 1276 },
  gold: { ...RESOURCE_LABEL.gold, categoryTapX: 874 },
  iron: { ...RESOURCE_LABEL.iron, categoryTapX: 1686 },
  mana: { ...RESOURCE_LABEL.mana, categoryTapX: 2088 },
};

const TYPES: readonly GatherResourceType[] = ['wood', 'gold', 'iron', 'mana'];

/**
 * What a march row is gathering, read tolerantly: the gathering rows carry `resourceType` from the thumbnail
 * (tpl_row_res_*), marching / returning rows only when the dispatch bookkeeping matched the coordinate. Unknown → null
 * (the UI shows 「?」 and explains why — never a guess).
 */
export function readResourceType(march: unknown): GatherResourceType | null {
  if (!march || typeof march !== 'object') return null;
  const value = (march as Record<string, unknown>)['resourceType'];
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value) ? value as GatherResourceType : null;
}
