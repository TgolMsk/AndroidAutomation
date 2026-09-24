/**
 * 「资源统计模板」 checklist of the template page (pure; the component is ResourceTemplatesCard.tsx): which ids of the
 * resource-statistics spec (RESOURCE_TEMPLATE_CATALOG, a hand copy of game-data/wanlong/resource-stats.json) the set
 * has, which are missing, and which have no material in the reference screenshots yet (待补裁: 5 / 8 / comma / 万).
 */
import {
  RES_GLYPH, RES_TPL, RESOURCE_REQUIRED_TEMPLATES, RESOURCE_SEED_FRAME_LABEL, RESOURCE_TEMPLATE_CATALOG,
  type ResourceTemplateSpec,
} from '@avdm/automation/wanlong/pure';
import type { ResourceTemplateSeedResult } from '../../../shared/ipc';
import { rectText, type QuickPick } from './template-editor';

export type ResourceTemplateState = 'present' | 'missing' | 'pending';

export interface ResourceTemplateRow {
  id: string;
  name: string;
  kind: ResourceTemplateSpec['kind'];
  priority: ResourceTemplateSpec['priority'];
  state: ResourceTemplateState;
  /** Which screen the crop comes from, or why there is no material yet. */
  source: string;
  /** Spec crop box in reference coordinates (2560×1440), '' when the spec has none. */
  bounds: string;
  note: string;
  /** Fills the editor's 「新建模板」 form (fixed id, name, tags, note) for a manual crop from a live frame. */
  pick: QuickPick;
}

export interface ResourceTemplateChecklist {
  rows: ResourceTemplateRow[];
  counts: Record<'ui' | 'unit' | 'glyph', { present: number; total: number }>;
  /** What still blocks 「读一次资源统计」: required UI templates, the 亿 unit, at least one glyph. */
  blocking: string[];
  /** Spec entries still missing that no reference screenshot has yet (to crop once the game shows them). */
  pending: string[];
}

const KIND_LABEL: Record<ResourceTemplateSpec['kind'], string> = { ui: '界面', unit: '单位字', glyph: '字形' };

export function resourceKindLabel(kind: ResourceTemplateSpec['kind']): string {
  return KIND_LABEL[kind];
}

/** The checklist for a set holding these template ids. */
export function resourceTemplateChecklist(ids: Iterable<string>): ResourceTemplateChecklist {
  const have = new Set(ids);
  const counts: ResourceTemplateChecklist['counts'] = { ui: { present: 0, total: 0 }, unit: { present: 0, total: 0 }, glyph: { present: 0, total: 0 } };
  const rows = RESOURCE_TEMPLATE_CATALOG.map((spec): ResourceTemplateRow => {
    const present = have.has(spec.id);
    counts[spec.kind].total++;
    if (present) counts[spec.kind].present++;
    const bounds = rectText(spec.bounds);
    const source = spec.frame ? RESOURCE_SEED_FRAME_LABEL[spec.frame] : '现有截图里没有素材，等游戏里真出现时再裁';
    return {
      id: spec.id, name: spec.name, kind: spec.kind, priority: spec.priority,
      state: present ? 'present' : spec.frame ? 'missing' : 'pending',
      source, bounds, note: spec.note,
      pick: {
        key: `res:${spec.id}`, id: spec.id, name: spec.name,
        group: spec.kind === 'glyph' ? 'glyph' : spec.priority === '必需' ? 'critical' : 'optional',
        detail: bounds ? `${source}；参考框 ${bounds}` : source,
        ...(spec.tags ? { tags: [...spec.tags] } : {}),
        note: spec.note,
      },
    };
  });
  const blocking: string[] = RESOURCE_REQUIRED_TEMPLATES.filter((id) => !have.has(id));
  if (!have.has(RES_TPL.unitYi)) blocking.push(RES_TPL.unitYi);
  if (counts.glyph.present === 0) blocking.push(`${RES_GLYPH}_*（数字字形）`);
  const pending = rows.filter((row) => row.state === 'pending').map((row) => row.id);
  return { rows, counts, blocking, pending };
}

/** The seed result as Chinese lines for the page. */
export function seedSummary(result: ResourceTemplateSeedResult): { title: string; tone: 'success' | 'info' | 'warn'; lines: string[] } {
  const lines: string[] = [];
  const frames = result.frames.map((frame) => result.files[frame] ? `${RESOURCE_SEED_FRAME_LABEL[frame]}（${result.files[frame]}）` : RESOURCE_SEED_FRAME_LABEL[frame]);
  if (frames.length > 0) lines.push(`用到的截图：${frames.join('、')}`);
  if (result.saved.length > 0) lines.push(`已入库 ${result.saved.length} 张：${result.saved.join('、')}`);
  for (const item of result.failed) lines.push(`没存进去 ${item.id}：${item.reason}`);
  const kept = result.skipped.filter((item) => item.reason.startsWith('模板集里已有'));
  if (kept.length > 0) lines.push(`已有、没动 ${kept.length} 张：${kept.map((item) => item.id).join('、')}`);
  const otherSkips = result.skipped.filter((item) => !kept.includes(item));
  if (otherSkips.length > 0) lines.push(`跳过 ${otherSkips.length} 张（没给对应截图，或规格里还没有素材）：${otherSkips.map((item) => item.id).join('、')}`);
  if (result.pausedSchedule) lines.push('模板变了，该实例的自动续跑已关闭；重新校准画面后再开启。');
  const title = result.saved.length > 0
    ? `资源统计模板已入库 ${result.saved.length} 张${result.failed.length ? `，${result.failed.length} 张失败` : ''}`
    : result.failed.length > 0 ? '资源统计模板没有存进去' : '没有需要裁的资源统计模板';
  const tone = result.failed.length > 0 ? 'warn' : result.saved.length > 0 ? 'success' : 'info';
  return { title, tone, lines };
}
