/**
 * Resource meta for badges (original features/gather/types.ts GATHER_RESOURCE_META). Names come from the single
 * source `RESOURCE_LABEL`; this adds only the one-character glyph and a token colour.
 *
 * ★ Glyph and colour only: the original's processed game art (assets/resources/*.png) is game art and never enters
 *   the repository (DECISIONS A.5), so every badge is the original's text-badge fallback.
 */
import { RESOURCE_LABEL, type GatherResourceType } from '@avdm/automation/wanlong/pure';

export interface GatherResourceMeta {
  /** Name in the bag (木材 …). */
  resource: string;
  /** Category name in the world-map search panel (伐木场 …). */
  category: string;
  /** Category tap x in reference space (y 1310); display and troubleshooting only. */
  categoryTapX: number;
  /** One-character glyph drawn on the badge. */
  glyph: string;
  /** Design-token colour of the badge background. */
  colorVar: string;
}

export const GATHER_RESOURCE_META: Readonly<Record<GatherResourceType, GatherResourceMeta>> = {
  wood: { ...RESOURCE_LABEL.wood, categoryTapX: 1276, glyph: '木', colorVar: 'var(--green)' },
  gold: { ...RESOURCE_LABEL.gold, categoryTapX: 874, glyph: '金', colorVar: 'var(--amber)' },
  iron: { ...RESOURCE_LABEL.iron, categoryTapX: 1686, glyph: '铁', colorVar: 'var(--grey)' },
  mana: { ...RESOURCE_LABEL.mana, categoryTapX: 2088, glyph: '魔', colorVar: 'var(--accent)' },
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
