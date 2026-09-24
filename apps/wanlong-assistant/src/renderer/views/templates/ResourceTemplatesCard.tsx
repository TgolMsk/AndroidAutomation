import { useMemo, useState } from 'react';
import type { TemplateSet } from '@avdm/automation';
import { RESOURCE_SEED_FRAMES, RESOURCE_SEED_FRAME_LABEL, RESOURCE_SEED_LEGACY_FILES, type ResourceSeedFrame } from '@avdm/automation/wanlong/pure';
import type { ResourceTemplateSeedResult, ResourceTemplateSeedSource } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useSelectionLock } from '../../state/selection';
import { resourceKindLabel, resourceTemplateChecklist, seedSummary, type ResourceTemplateState } from './resource-templates';
import type { QuickPick } from './template-editor';
import './ResourceTemplatesCard.css';

const STATE_LABEL: Record<ResourceTemplateState, string> = { present: '已有', missing: '缺', pending: '待补裁' };

export interface ResourceTemplatesCardProps {
  gameId: string;
  index: number;
  set: TemplateSet;
  /** The editor is busy (capture, save …): the card's actions wait. */
  disabled: boolean;
  /** Prefill the editor's 「新建模板」 form for a manual crop from a live frame. */
  onPick: (pick: QuickPick) => void;
  /** Templates of `directory` were written (same notification as a save). */
  onChanged?: (directory: string) => void;
}

/**
 * 「资源统计模板」 (the template page's checklist for 读一次资源统计): what the set has of the resource-statistics spec,
 * and the one-click crop by the spec from screenshots (a folder of them, or the instance's current screen per frame
 * role). Templates and screenshots stay on this machine.
 */
export function ResourceTemplatesCard({ gameId, index, set, disabled, onPick, onChanged }: ResourceTemplatesCardProps) {
  const toast = useToast();
  const checklist = useMemo(() => resourceTemplateChecklist(set.templates.map((item) => item.id)), [set]);
  const [frame, setFrame] = useState<ResourceSeedFrame>('stats');
  const [overwrite, setOverwrite] = useState(false);
  const [working, setWorking] = useState<ResourceTemplateSeedSource['kind'] | null>(null);
  const [result, setResult] = useState<ResourceTemplateSeedResult | null>(null);
  useSelectionLock(working ? '正在裁资源统计模板，完成后再切换实例' : null);

  const ready = checklist.blocking.length === 0;
  const off = disabled || working !== null;

  async function seed(source: ResourceTemplateSeedSource): Promise<void> {
    if (off) return;
    setWorking(source.kind);
    try {
      const next = await avdm.resourcesSeedTemplates(gameId, index, source, overwrite);
      if (!next) return;
      setResult(next);
      const summary = seedSummary(next);
      toast.push({ kind: summary.tone, title: summary.title, detail: summary.lines.slice(0, 2).join('；') || undefined });
      if (next.saved.length > 0) onChanged?.(next.directory);
    } catch (cause) {
      toast.error('裁资源统计模板失败', errMsg(cause));
    } finally {
      setWorking(null);
    }
  }

  const summary = result ? seedSummary(result) : null;
  const count = (kind: 'ui' | 'unit' | 'glyph') => `${checklist.counts[kind].present}/${checklist.counts[kind].total}`;

  return (
    <details className="res-tpl" open={!ready}>
      <summary>
        <span className={`tag ${ready ? 'ok' : 'warn'}`}>{ready ? '资源统计可以读表' : `资源统计缺 ${checklist.blocking.length} 项`}</span>
        <span>资源统计模板 · 界面 {count('ui')} · 单位字 {count('unit')} · 字形 {count('glyph')}{checklist.pending.length ? ` · ${checklist.pending.length} 张待补裁` : ''}</span>
      </summary>
      <div className="res-tpl-body">
        <p>
          「读一次资源统计」（道具 → 资源 → 资源统计）按固定 ID 找这些模板。可以按规格从截图一键裁：选一个放着截图的文件夹（旧面板的
          <code>docs/game/shots/resources/</code>，或自己截的 {RESOURCE_SEED_FRAMES.map((item) => RESOURCE_SEED_LEGACY_FILES[item]).join(' / ')}），
          或者把游戏停在对应画面后「用当前画面裁」。截图最好是 2560×1440（至少 16:9 整帧）；模板与截图只留在本机。
        </p>
        {!ready && <p className="res-tpl-blocking">还缺：{checklist.blocking.join('、')}</p>}

        <div className="res-tpl-actions">
          <button className="btn sm" type="button" onClick={() => void seed({ kind: 'folder' })} disabled={off}>
            {working === 'folder' ? <Spinner size={14} /> : <Icon name="folder" />}从截图文件夹裁…
          </button>
          <label className="res-tpl-frame">
            <span>当前画面是</span>
            <select value={frame} onChange={(event) => setFrame(event.target.value as ResourceSeedFrame)} disabled={off}>
              {RESOURCE_SEED_FRAMES.map((item) => <option key={item} value={item}>{RESOURCE_SEED_FRAME_LABEL[item]}</option>)}
            </select>
          </label>
          <button className="btn sm" type="button" onClick={() => void seed({ kind: 'screen', frame })} disabled={off}>
            {working === 'screen' ? <Spinner size={14} /> : <Icon name="camera" />}用当前画面裁
          </button>
          <label className="res-tpl-overwrite">
            <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} disabled={off} />
            <span>覆盖已有（同 ID 按截图重裁）</span>
          </label>
        </div>

        {summary && <div className={`notice ${summary.tone === 'warn' ? 'warn' : 'info'} res-tpl-result`} role="status" aria-live="polite">
          <Icon name={summary.tone === 'warn' ? 'alert' : 'check'} />
          <div><strong>{summary.title}</strong>{summary.lines.length > 0 && <ul>{summary.lines.map((line) => <li key={line}>{line}</li>)}</ul>}</div>
          <button className="icon-btn small" type="button" aria-label="关闭裁切结果" onClick={() => setResult(null)}><Icon name="close" size={14} /></button>
        </div>}

        <ul className="res-tpl-list" aria-label="资源统计模板清单">
          {checklist.rows.map((row) => (
            <li key={row.id} className={`res-tpl-row is-${row.state}`}>
              <span className={`res-tpl-state is-${row.state}`}>{STATE_LABEL[row.state]}</span>
              <span className="res-tpl-kind">{row.priority} · {resourceKindLabel(row.kind)}</span>
              <span className="res-tpl-id" title={row.note}><code>{row.id}</code><small>{row.name}</small></span>
              <span className="res-tpl-source" title={row.note}>{row.source}{row.bounds ? ` · ${row.bounds}` : ''}</span>
              <button className="btn xs" type="button" onClick={() => onPick(row.pick)} disabled={off}
                title="在下方编辑器里新建这张模板（ID、名称、标签、备注已填好），读取画面后框选保存">
                {row.state === 'present' ? '重裁' : '手动裁'}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
