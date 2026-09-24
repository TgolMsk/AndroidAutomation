import { useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateDefinition, TemplateSet } from '@avdm/automation';
import { avdm } from '../../api';
import { Icon } from '../../components/Icon';
import { maskBadge, stdBadge, templateSummary } from './template-editor';
import {
  FILTER_ALL, FILTER_UI, filterTemplates, GLYPH_GROUP, glyphSetOf, inTemplateFilter, isGlyphTemplate, matchesTemplateQuery, pageButtons,
  pageContaining, pageOf, templateFilterOptions, templateGroupOf,
} from './template-groups';
import { ThumbCache } from './thumb-cache';

interface TemplateListProps {
  gameId: string;
  index: number;
  set: TemplateSet;
  selectedId: string | null;
  disabled: boolean;
  onSelect: (item: TemplateDefinition) => void;
  onNew: () => void;
  onTest: (id: string) => void;
}

/** The chosen category is remembered per window (a convenience: storage may be blocked, so every access is guarded). */
const FILTER_STORAGE_KEY = 'wl.templates.filter';

function readStoredFilter(): string {
  try { return window.localStorage.getItem(FILTER_STORAGE_KEY) || FILTER_UI; } catch { return FILTER_UI; }
}

function storeFilter(value: string): void {
  try { window.localStorage.setItem(FILTER_STORAGE_KEY, value); } catch { /* page memory only */ }
}

function ownFilterOf(item: TemplateDefinition): string {
  return isGlyphTemplate(item) ? `${GLYPH_GROUP}:${glyphSetOf(item)}` : templateGroupOf(item).key;
}

function TemplateThumb({ cache, id, version }: { cache: ThumbCache | null; id: string; version: number | undefined }) {
  const [url, setUrl] = useState<string | null>(() => cache?.peek(id, version) ?? null);
  useEffect(() => {
    setUrl(cache?.peek(id, version) ?? null);
    if (!cache) return;
    let alive = true;
    void cache.get(id, version).then((next) => { if (alive) setUrl(next); });
    return () => { alive = false; };
  }, [cache, id, version]);
  return <span className="template-thumb" aria-hidden="true">{url ? <img src={url} alt="" draggable={false} /> : <Icon name="grid" size={14} />}</span>;
}

/**
 * The template list of the library page: category filter (界面模板 by default — the digit glyphs, more than half of a
 * bundled set, only matter to the OCR), search over name / id / tags / note, thumbnails and pages of
 * `TEMPLATE_PAGE_SIZE`, so the template being debugged is found without scrolling through the whole set.
 */
export function TemplateList({ gameId, index, set, selectedId, disabled, onSelect, onNew, onTest }: TemplateListProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(readStoredFilter);
  const [page, setPage] = useState(0);
  const [cache, setCache] = useState<ThumbCache | null>(null);

  // One cache per instance set; created in the effect so StrictMode's second mount gets a live one.
  useEffect(() => {
    const next = new ThumbCache((id) => avdm.automationTemplateImage(gameId, index, id));
    setCache(next);
    return () => next.dispose();
  }, [gameId, index, set.directory]);

  const options = useMemo(() => templateFilterOptions(set.templates), [set.templates]);
  const activeFilter = [...options.main, ...options.glyphs].some((option) => option.value === filter) ? filter : FILTER_UI;
  const filtered = useMemo(() => filterTemplates(set.templates, activeFilter, query), [set.templates, activeFilter, query]);
  const elsewhere = useMemo(() => query.trim() && activeFilter !== FILTER_ALL
    ? filterTemplates(set.templates, FILTER_ALL, query).length - filtered.length : 0, [set.templates, activeFilter, query, filtered.length]);
  const view = pageOf(filtered, page);

  function chooseFilter(value: string): void {
    setFilter(value);
    storeFilter(value);
    setPage(0);
  }

  // Follow a selection made outside the list (save, quick pick, AI proposal, refresh): bring it into view — its own
  // category when the current filter or search hides it.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || followed.current === selectedId) return;
    const item = set.templates.find((template) => template.id === selectedId);
    if (!item) return;
    followed.current = selectedId;
    if (!inTemplateFilter(item, activeFilter) || !matchesTemplateQuery(item, query)) {
      const own = ownFilterOf(item);
      setFilter(own);
      setQuery('');
      setPage(pageContaining(filterTemplates(set.templates, own, ''), selectedId) ?? 0);
      return;
    }
    const at = pageContaining(filtered, selectedId);
    if (at !== null) setPage(at);
  }, [selectedId, set.templates]);

  return (
    <aside className="template-library-list" aria-label="当前模板集中的模板">
      <div className="template-library-list-head"><strong>模板列表</strong><span title="模板集里的模板总数">{set.templates.length}</span></div>
      <div className="template-list-tools">
        <label className="search template-list-search">
          <Icon name="search" />
          <input type="search" value={query} placeholder="搜索名称 / ID / 标签" aria-label="搜索模板"
            onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        </label>
        <select value={activeFilter} aria-label="模板分类" onChange={(event) => chooseFilter(event.target.value)}>
          {options.main.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
          {options.glyphs.length > 0 && <optgroup label="数字字形（给读数用，脚本一般用不到）">
            {options.glyphs.map((option) => <option key={option.value} value={option.value}>{option.label}（{option.count}）</option>)}
          </optgroup>}
        </select>
      </div>

      <button className={`template-list-item template-list-new ${!selectedId ? 'is-selected' : ''}`} type="button" onClick={onNew} disabled={disabled}>
        <Icon name="plus" /><span><strong>新建模板</strong></span>
      </button>

      <div className="template-list-rows">
        {view.items.map((item) => {
          const std = stdBadge(item.std);
          const mask = maskBadge(item.maskCoverage);
          return <div className="template-list-row" key={item.id}>
            <button className={`template-list-item ${selectedId === item.id ? 'is-selected' : ''}`} type="button" onClick={() => onSelect(item)} disabled={disabled}
              title={`${item.name}\n${item.id} · ${templateSummary(item)}${item.note ? `\n${item.note}` : ''}`} aria-current={selectedId === item.id ? 'true' : undefined}>
              <TemplateThumb cache={cache} id={item.id} version={item.updatedAt} />
              <span>
                <strong>{item.name}</strong>
                <span className="template-list-meta">
                  {std && <em className={`template-badge is-${std.tone}`} title={std.hint}>{std.label}</em>}
                  {mask && <em className="template-badge is-info" title={mask.hint}>透明底</em>}
                  <small>{item.id}</small>
                </span>
              </span>
            </button>
            <button className="icon-btn small template-list-test" type="button" aria-label={`立即验证 ${item.name}`} title="在当前实例的真实画面上跑一次匹配"
              onClick={() => onTest(item.id)} disabled={disabled}><Icon name="search" size={14} /></button>
          </div>;
        })}
      </div>

      {set.templates.length === 0
        ? <p className="template-library-note">这个集合里还没有模板。读取游戏画面并拖选第一个识别区域。</p>
        : filtered.length === 0 && <div className="template-library-note">
          <span>{query.trim() ? `这个分类里没有匹配「${query.trim()}」的模板。` : '这个分类里没有模板。'}</span>
          {elsewhere > 0 && <button className="btn xs" type="button" onClick={() => chooseFilter(FILTER_ALL)}>在全部模板里找到 {elsewhere} 个</button>}
        </div>}

      {view.pages > 1 && <nav className="template-pager" aria-label="模板列表分页">
        <span className="template-pager-pages">
          <button type="button" onClick={() => setPage(view.page - 1)} disabled={view.page === 0} aria-label="上一页" title="上一页">‹</button>
          {pageButtons(view.page, view.pages).map((entry, i) => entry === 'gap'
            ? <span key={`gap-${i}`} className="template-pager-gap" aria-hidden="true">…</span>
            : <button key={entry} type="button" className={entry === view.page ? 'is-active' : ''} aria-current={entry === view.page ? 'page' : undefined}
              aria-label={`第 ${entry + 1} 页`} onClick={() => setPage(entry)}>{entry + 1}</button>)}
          <button type="button" onClick={() => setPage(view.page + 1)} disabled={view.page >= view.pages - 1} aria-label="下一页" title="下一页">›</button>
        </span>
        <span className="template-pager-range">第 {view.from}–{view.to} 张，共 {view.total} 张</span>
      </nav>}
    </aside>
  );
}
