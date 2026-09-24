/**
 * Visual script editor: the script's steps drawn as a column of block cards, edited without touching JSON
 * (wanlong-panel `features/blocks/BlockEditor.tsx`).
 *
 * Design choices kept from the original:
 *  · A collapsed card shows one sentence (`describeBlock`); only the selected card opens its form — a 30-step
 *    script must fit on one screen or the visual mode reads worse than JSON.
 *  · Ordering uses up / down buttons, not drag and drop: dragging in a tree (into if branches) is fiddly and error
 *    prone, buttons are deterministic and keyboard friendly. The one drag that pays is drawing a box on the screen.
 *  · No live red crosses. Obvious slips (no template picked, coordinates still 0,0) get a yellow tag on the card;
 *    reference integrity stays with the main-process validation — the same rule is never written twice.
 *
 * Every change goes through the pure block-tree functions of `@avdm/automation/script` and comes back as a new
 * steps array, which the page serialises into its JSON text (the single source of truth).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateDefinition } from '@avdm/automation';
import {
  BLOCK_CATALOG, BLOCK_GROUPS, BRANCH_TEXT, SCRIPT_LIMITS, blockIssue, blockMeta, branchesOf, canAddAtDepth, childrenOf, cloneWithNewIds,
  collectIds, countBlocks, describeBlock, describeCond, findPathById, idPrefixOf, insertAfter, kindOfStep, makeBlock, moveAt, nextStepId,
  pathDepth, pathKey, removeAt, samePath, updateAt,
  type BlockKind, type BlockPath, type Branch, type ScriptDef, type ScriptStep,
} from '@avdm/automation/script';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { StepFields } from './StepFields';
import { collectLabels, placeBlock, targetAfter, type InsertTarget } from './script-editor';
import './BlockEditor.css';

export interface BlockEditorProps {
  script: ScriptDef;
  templates: readonly TemplateDefinition[];
  /** The game's package (launch / stop / foreground are locked to it). */
  gamePackage: string;
  /** How cards name the game in 「启动 / 关闭」 sentences. */
  appLabel: string;
  /** The selected block (by id, so the selection follows moves); null = none. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Bumped when the page asks the selected card to scroll into view (「点问题定位」). */
  revealSeq: number;
  onChange: (steps: ScriptStep[]) => void;
  /** Open 「从画面截取」 for this insertion target. */
  onCapture: (target: InsertTarget) => void;
  /** Why capturing is impossible right now (no template set …), or null. */
  captureBlocked: string | null;
}

interface EditorContext {
  root: ScriptStep[];
  script: ScriptDef;
  templates: readonly TemplateDefinition[];
  templateIds: ReadonlySet<string>;
  gamePackage: string;
  appLabel: string;
  labels: string[];
  selectedPath: BlockPath | null;
  revealSeq: number;
  select: (id: string | null) => void;
  change: (steps: ScriptStep[]) => void;
  capture: (target: InsertTarget) => void;
  captureBlocked: string | null;
  addToBranch: (parentPath: BlockPath, parentId: string, branch: Branch, kind: BlockKind) => void;
  askRemove: (path: BlockPath, step: ScriptStep) => void;
}

export function BlockEditor({ script, templates, gamePackage, appLabel, selectedId, onSelect, revealSeq, onChange, onCapture, captureBlocked }: BlockEditorProps) {
  const steps = script.steps;
  const templateIds = useMemo(() => new Set(templates.map((t) => t.id)), [templates]);
  const labels = useMemo(() => collectLabels(steps), [steps]);
  const selectedPath = useMemo(() => selectedId ? findPathById(steps, selectedId) : null, [steps, selectedId]);
  const [removing, setRemoving] = useState<{ path: BlockPath; step: ScriptStep; nested: number } | null>(null);

  const newBlock = (kind: BlockKind): ScriptStep => makeBlock(kind, nextStepId(steps, idPrefixOf(kind)));
  const addBlock = (kind: BlockKind): void => {
    const step = newBlock(kind);
    onChange(placeBlock(steps, targetAfter(steps, selectedPath), step).steps);
    onSelect(step.id);
  };
  const addToBranch = (parentPath: BlockPath, parentId: string, branch: Branch, kind: BlockKind): void => {
    const step = newBlock(kind);
    onChange(placeBlock(steps, { kind: 'branch', parentPath, parentId, branch }, step).steps);
    onSelect(step.id);
  };
  const remove = (path: BlockPath, step: ScriptStep): void => {
    onChange(removeAt(steps, path));
    // The ids of a removed subtree are free again: never leave the selection on one that a new block may reuse.
    if (selectedId && collectIds([step]).has(selectedId)) onSelect(null);
  };
  const askRemove = (path: BlockPath, step: ScriptStep): void => {
    const nested = countBlocks([step]) - 1;
    if (nested > 0) setRemoving({ path, step, nested });
    else remove(path, step);
  };

  const ctx: EditorContext = {
    root: steps, script, templates, templateIds, gamePackage, appLabel, labels, selectedPath, revealSeq,
    select: onSelect, change: onChange, capture: onCapture, captureBlocked, addToBranch, askRemove,
  };

  return (
    <div className="blk-editor">
      <div className="blk-toolbar">
        <button type="button" className="btn sm primary" disabled={Boolean(captureBlocked)} onClick={() => onCapture(targetAfter(steps, selectedPath))}
          title={captureBlocked ?? '抓一帧画面，拉个框，直接变成一块'}>
          <Icon name="camera" size={14} />从画面截取
        </button>
        <AddBlockMenu onPick={addBlock} hasTemplates={templates.length > 0} depth={selectedPath ? pathDepth(selectedPath) : 0} />
        <span className="blk-toolbar-hint">
          {captureBlocked ? `${captureBlocked}。` : ''}{selectedPath ? '新块会插在选中的那块后面' : '没选中任何块，新块加在最后'}
        </span>
      </div>

      {steps.length === 0 ? (
        <div className="blk-empty">
          {script.templateSetId
            ? '还是空的。点「从画面截取」把游戏里的按钮框下来，它会直接变成第一块。'
            : '还是空的。先在上面给脚本选一个模板集，然后就能从画面截取了。'}
        </div>
      ) : (
        <BlockList steps={steps} basePath={[]} ctx={ctx} />
      )}

      {removing && (
        <ConfirmDialog
          title={`删除「${blockMeta(kindOfStep(removing.step)).label}」这一块？`}
          message={`它里面还有 ${removing.nested} 块，会一起删掉。没保存之前可以不保存、重新打开脚本来撤回。`}
          confirmLabel="删除" danger
          onConfirm={() => remove(removing.path, removing.step)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

// ── Block list (recursive) ─────────────────────────────────────────────────

function BlockList({ steps, basePath, ctx }: { steps: ScriptStep[]; basePath: BlockPath; ctx: EditorContext }) {
  return (
    <div className="blk-list">
      {steps.map((step, i) => {
        const path: BlockPath = [...basePath, i];
        return <BlockCard key={`${pathKey(path)}-${step.id}`} step={step} path={path} index={i} count={steps.length} ctx={ctx} />;
      })}
    </div>
  );
}

// ── One card ───────────────────────────────────────────────────────────────

function BlockCard({ step, path, index, count, ctx }: { step: ScriptStep; path: BlockPath; index: number; count: number; ctx: EditorContext }) {
  const isSelected = ctx.selectedPath !== null && samePath(ctx.selectedPath, path);
  const meta = blockMeta(kindOfStep(step));
  const issue = blockIssue(step, ctx.templateIds);
  const branches = branchesOf(step);
  const canElse = step.kind === 'if' && !step.else;
  const card = useRef<HTMLDivElement>(null);
  const toggle = (): void => ctx.select(isSelected ? null : step.id);
  const summary = `${step.name ? `${step.name} —— ` : ''}${describeBlock(step, ctx.templates, { appLabel: ctx.appLabel })}`;

  useEffect(() => {
    if (isSelected && ctx.revealSeq > 0) card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    // Only a reveal request scrolls; selecting by click keeps the page where it is.
  }, [ctx.revealSeq]);

  return (
    <div ref={card} className={`blk-card${isSelected ? ' is-selected' : ''}`}>
      <div className="blk-card-head">
        <button type="button" className="blk-icon-btn blk-chevron" onClick={toggle} aria-expanded={isSelected} aria-label={isSelected ? '收起这一块' : '展开这一块'}>
          <Icon name="back" size={14} />
        </button>
        <div className="blk-card-title" role="button" tabIndex={0} onClick={toggle}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } }}>
          <span className="blk-ordinal">{index + 1}.</span>
          <span className="blk-kind" title={meta.hint}>{meta.label}</span>
          <span className="blk-summary" title={summary}>{summary}</span>
          {step.when && <span className="blk-tag" title={`只有「${describeCond(step.when, ctx.templates)}」时才执行这一块`}>有前置条件</span>}
          {issue && <span className="blk-tag is-warning" title={issue}>{issue}</span>}
        </div>
        <div className="blk-card-actions">
          <button type="button" className="blk-icon-btn blk-up" title="上移" aria-label="上移" disabled={index === 0}
            onClick={() => ctx.change(moveAt(ctx.root, path, -1))}><Icon name="back" size={14} /></button>
          <button type="button" className="blk-icon-btn blk-down" title="下移" aria-label="下移" disabled={index === count - 1}
            onClick={() => ctx.change(moveAt(ctx.root, path, 1))}><Icon name="back" size={14} /></button>
          <button type="button" className="blk-icon-btn" title="复制一块" aria-label="复制一块"
            onClick={() => ctx.change(insertAfter(ctx.root, path, [cloneWithNewIds(ctx.root, step)]))}><Icon name="copy" size={14} /></button>
          <button type="button" className="blk-icon-btn is-danger" title="删除" aria-label="删除"
            onClick={() => ctx.askRemove(path, step)}><Icon name="trash" size={14} /></button>
        </div>
      </div>

      {isSelected && (
        <div className="blk-card-body">
          <StepFields
            step={step} script={ctx.script} templates={ctx.templates} gamePackage={ctx.gamePackage} labels={ctx.labels}
            onPatch={(next) => ctx.change(updateAt(ctx.root, path, next))}
            onCapture={() => ctx.capture({ kind: 'after', path, stepId: step.id })} captureBlocked={ctx.captureBlocked}
          />
        </div>
      )}

      {branches.length > 0 && (
        <div className="blk-branches">
          {branches.map((branch) => {
            const children = childrenOf(step, branch);
            return (
              <div key={branch} className="blk-branch">
                <span className="blk-branch-title">{BRANCH_TEXT[branch]}</span>
                {children.length === 0
                  ? <span className="blk-branch-empty">这个分支还是空的</span>
                  : <BlockList steps={children} basePath={[...path, branch]} ctx={ctx} />}
                <div className="blk-branch-foot">
                  <AddBlockMenu small label={`往${BRANCH_TEXT[branch]}加一块`} hasTemplates={ctx.templates.length > 0} depth={pathDepth(path) + 1}
                    onPick={(kind) => ctx.addToBranch(path, step.id, branch, kind)} />
                  <button type="button" className="btn xs" disabled={Boolean(ctx.captureBlocked)}
                    title={ctx.captureBlocked ?? `抓一帧画面拉个框，在「${BRANCH_TEXT[branch]}」末尾插入一块`}
                    onClick={() => ctx.capture({ kind: 'branch', parentPath: path, parentId: step.id, branch })}>
                    <Icon name="camera" size={12} />截取到这里
                  </button>
                </div>
              </div>
            );
          })}
          {canElse && (
            <button type="button" className="btn xs blk-add-else" onClick={() => ctx.change(updateAt(ctx.root, path, { ...step, else: [] }))}>
              <Icon name="plus" size={12} />加一个「否则」分支
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── 「加一块」 (grouped menu) ───────────────────────────────────────────────

function AddBlockMenu({ onPick, hasTemplates, depth, label = '加一块', small }: {
  onPick: (kind: BlockKind) => void;
  hasTemplates: boolean;
  /** Nesting depth where the block would land (if / loop are refused at the validator's limit). */
  depth: number;
  label?: string;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  return (
    <div className="blk-add" ref={root}>
      <button type="button" className={`btn ${small ? 'xs' : 'sm'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="plus" size={small ? 12 : 14} />{label}
      </button>
      {open && (
        <div className="blk-add-menu" role="menu" aria-label={label}>
          {BLOCK_GROUPS.map((group) => (
            <div key={group} className="blk-add-group" role="group" aria-label={group}>
              <span className="blk-add-group-title">{group}</span>
              {BLOCK_CATALOG.filter((b) => b.group === group).map((b) => {
                const noTemplate = Boolean(b.needsTemplate) && !hasTemplates;
                const tooDeep = !canAddAtDepth(b.kind, depth);
                const hint = noTemplate ? '模板集里还没有模板，先去截一张'
                  : tooDeep ? `嵌套已到上限（${SCRIPT_LIMITS.maxDepth} 层），这里不能再加${b.label}` : b.hint;
                return (
                  <button key={b.kind} type="button" role="menuitem" className="blk-add-item" disabled={noTemplate || tooDeep} title={hint}
                    onClick={() => { setOpen(false); onPick(b.kind); }}>
                    <strong>{b.label}</strong>
                    <span>{hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
