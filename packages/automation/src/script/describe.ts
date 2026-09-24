/** Chinese one-line summaries for logs and block cards (ported from wanlong-panel `conditions.ts` / `actions.ts`). */
import type { Condition, Rect } from './types.js';

/** A condition as a short Chinese phrase (never the raw JSON). */
export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case 'always': return '总是';
    case 'never': return '从不';
    case 'template': return `${cond.present === false ? '不存在' : '出现'}模板「${cond.templateId}」`;
    case 'anyTemplate': return `出现任一模板「${cond.templateIds.join('/')}」`;
    case 'foreground': return `${cond.equals === false ? '前台不是' : '前台是'}「${cond.packageName}」`;
    case 'and': return cond.all.map(describeCondition).join(' 且 ');
    case 'or': return cond.any.map(describeCondition).join(' 或 ');
    case 'not': return `非(${describeCondition(cond.of)})`;
    default: return '未知条件';
  }
}

/** An ROI for logs; no ROI means the whole screen. */
export function describeRect(rect: Rect | undefined): string {
  return rect ? `(${rect.x},${rect.y} ${rect.w}x${rect.h})` : '全屏';
}
