import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Rect, SeedResult, TemplateDefinition, TemplateSet } from '@avdm/automation';
import { ALPHA_TOLERANCE_RANGE, DEFAULT_ALPHA_DIFF_TOLERANCE, MAX_DIFF_FRAMES, MIN_TEMPLATE_CROP } from '@avdm/automation/constants';
import type { TemplateCapture, TemplateCoverage, TemplateTestResult } from '../../../shared/ipc';
import type { AdvisorTemplateProposal } from '../../../main/automation/advisor/types';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { beijingTime } from '../../format';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useSelectionLock } from '../../state/selection';
import {
  buildTemplateDraft, clampTolerance, DELETE_WARNING, describeCoverage, importSummary, importTouchesSet, lowVarianceGuidance,
  maskBadge, overwriteTarget, quickPicks, rectText, resolutionWarning, ROI_ADVICE, saveSuccessDetail, stdBadge,
  templateIdProblem, templateSummary, testVerdict, validCrop, type LowVarianceGuidance, type QuickPick,
} from './template-editor';
import { ResourceTemplatesCard } from './ResourceTemplatesCard';
import './TemplatesView.css';

interface TemplateEditorProps {
  gameId: string;
  index: number | null;
  onChanged?: (directory: string) => void;
  proposal?: AdvisorTemplateProposal | null;
}

type BusyAction = 'load' | 'create' | 'switch' | 'capture' | 'compare' | 'save' | 'delete' | 'test' | 'import' | 'coverage' | null;
type DrawMode = 'crop' | 'roi';

const BUSY_LOCK: Partial<Record<Exclude<BusyAction, null>, string>> = {
  capture: '正在读取实例画面，完成后再切换实例',
  compare: '正在读取差分帧，完成后再切换实例',
  test: '正在验证模板，完成后再切换实例',
  save: '正在保存模板，完成后再切换实例',
  delete: '正在删除模板，完成后再切换实例',
  coverage: '正在检查模板覆盖，完成后再切换实例',
};

function usePngUrl(bytes: Uint8Array | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) { setUrl(null); return; }
    const next = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}

function DiffThumb({ shot, label }: { shot: TemplateCapture; label: string }) {
  const url = usePngUrl(shot.png);
  return url ? <img className="template-diff-thumb" src={url} alt={label} title={`${label} · ${beijingTime(shot.capturedAt, 'clock')}`} /> : null;
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function templateCrop(definition: TemplateDefinition, set: TemplateSet, frame: TemplateCapture): Rect {
  const x = clamp(Math.round(definition.bounds.x * frame.width / set.refWidth), 0, frame.width - 3);
  const y = clamp(Math.round(definition.bounds.y * frame.height / set.refHeight), 0, frame.height - 3);
  return {
    x, y,
    w: clamp(Math.round(definition.bounds.w * frame.width / set.refWidth), 3, frame.width - x),
    h: clamp(Math.round(definition.bounds.h * frame.height / set.refHeight), 3, frame.height - y),
  };
}

function proposalCrop(proposal: AdvisorTemplateProposal, frame: TemplateCapture): Rect {
  const x = clamp(Math.round(proposal.box.x * frame.width / proposal.frameWidth), 0, frame.width - 3);
  const y = clamp(Math.round(proposal.box.y * frame.height / proposal.frameHeight), 0, frame.height - 3);
  return {
    x, y,
    w: clamp(Math.round(proposal.box.w * frame.width / proposal.frameWidth), 3, frame.width - x),
    h: clamp(Math.round(proposal.box.h * frame.height / proposal.frameHeight), 3, frame.height - y),
  };
}

function rectStyle(rect: Rect, width: number, height: number): CSSProperties {
  return { left: `${rect.x / width * 100}%`, top: `${rect.y / height * 100}%`,
    width: `${rect.w / width * 100}%`, height: `${rect.h / height * 100}%` };
}

/**
 * The template library of the selected instance's set: capture a fresh read-only frame, crop and ROI, optional
 * 1–3 frame 透明底, fixed id / note / tags, the variance guard's guidance, 立即验证, missing-template quick picks and
 * the only-add legacy import. Ported from wanlong-panel's TemplateEditor onto the target's own CSS.
 */
export function TemplateEditor({ gameId, index, onChanged, proposal }: TemplateEditorProps) {
  const toast = useToast();
  const [sets, setSets] = useState<TemplateSet[]>([]);
  const [activeSet, setActiveSet] = useState<TemplateSet | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSetName, setNewSetName] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [threshold, setThreshold] = useState(0.85);
  const [roi, setRoi] = useState<Rect | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [frame, setFrame] = useState<TemplateCapture | null>(null);
  const [diffShots, setDiffShots] = useState<TemplateCapture[]>([]);
  const [tolerance, setTolerance] = useState(DEFAULT_ALPHA_DIFF_TOLERANCE);
  const [alphaPreview, setAlphaPreview] = useState<{ png: Uint8Array; coverage: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TemplateTestResult | null>(null);
  const [templateImage, setTemplateImage] = useState<Uint8Array | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>('crop');
  const [busy, setBusy] = useState<BusyAction>('load');
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [guidance, setGuidance] = useState<LowVarianceGuidance | null>(null);
  const [usingProposal, setUsingProposal] = useState(false);
  const [proposalReviewed, setProposalReviewed] = useState(false);
  const [coverage, setCoverage] = useState<TemplateCoverage | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ result: SeedResult; pausedSchedules: number[] } | null>(null);
  /** TEMPLATE_EXISTS from the main process for an id this page did not know about yet (another writer added it). */
  const [overwriteConflict, setOverwriteConflict] = useState<string | null>(null);
  const drawStart = useRef<{ x: number; y: number; mode: DrawMode } | null>(null);
  /** Drops coverage responses of an earlier instance / request (a full check can outlive an instance switch). */
  const coverageSeq = useRef(0);
  const busyRef = useRef<BusyAction>(busy);
  busyRef.current = busy;

  useSelectionLock(busy ? BUSY_LOCK[busy] ?? null : null);

  const selected = useMemo(() => activeSet?.templates.find((item) => item.id === selectedId) ?? null, [activeSet, selectedId]);
  const matchingProposal = proposal && proposal.gameId === gameId && proposal.index === index ? proposal : null;
  const frameUrl = usePngUrl(frame?.png ?? null);
  const templateUrl = usePngUrl(templateImage);
  const alphaUrl = usePngUrl(alphaPreview?.png ?? null);
  const testUrl = usePngUrl(testResult?.preview.png ?? null);
  const picks = useMemo(() => quickPicks(coverage), [coverage]);

  const loadCoverage = useCallback(async (compile: boolean) => {
    const seq = ++coverageSeq.current;
    if (index === null) { setCoverage(null); setCoverageError(null); return; }
    try {
      const next = await avdm.automationTemplateCoverage(gameId, index, compile);
      if (seq !== coverageSeq.current) return;
      setCoverage(next);
      setCoverageError(null);
    } catch (cause) {
      if (seq === coverageSeq.current) setCoverageError(errMsg(cause));
    }
  }, [gameId, index]);

  /** `keepNew`: a background reload keeps the 「新建模板」 form instead of jumping to the first template. */
  const refresh = useCallback(async (preferId?: string | null, keepNew = false) => {
    if (!gameId) { setSets([]); setActiveSet(null); setBusy(null); return; }
    const [managed, current] = await Promise.all([
      avdm.automationTemplateSets(gameId),
      index === null ? Promise.resolve(null) : avdm.automationTemplateSet(gameId, index),
    ]);
    setSets(managed);
    setActiveSet(current);
    setSelectedId((previous) => {
      const candidate = preferId === undefined ? previous : preferId;
      if (keepNew && candidate === null) return null;
      return current?.templates.some((item) => item.id === candidate) ? candidate : current?.templates[0]?.id ?? null;
    });
    setError(null);
    void loadCoverage(false);
  }, [gameId, index, loadCoverage]);

  function clearDiffShots(): void {
    setDiffShots([]); setAlphaPreview(null); setPreviewError(null);
  }

  useEffect(() => {
    let alive = true;
    setBusy('load'); setError(null); setFrame(null); clearDiffShots(); setTestResult(null);
    setSelectedId(null); setUsingProposal(false); setProposalReviewed(false); setGuidance(null); setImportResult(null);
    setCoverage(null); setCoverageError(null); setOverwriteConflict(null);
    void refresh().catch((cause) => { if (alive) setError(errMsg(cause)); }).finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, [refresh]);

  // Another writer (AI harvest, tplkit-free save paths, an import) changed this set: reload it.
  useAvdmEvent('templates-changed', (change) => {
    if (change.gameId !== gameId || busyRef.current !== null) return;
    if (activeSet && change.directory === activeSet.directory) void refresh(undefined, true).catch((cause) => setError(errMsg(cause)));
    else if (change.reason === 'import') void avdm.automationTemplateSets(gameId).then(setSets).catch(() => undefined);
  });

  useEffect(() => {
    let alive = true;
    setTemplateImage(null);
    if (index !== null && selectedId) {
      void avdm.automationTemplateImage(gameId, index, selectedId)
        .then((image) => { if (alive) setTemplateImage(image); })
        .catch((cause) => { if (alive) setError(errMsg(cause)); });
    }
    return () => { alive = false; };
  }, [gameId, index, selectedId, activeSet?.directory, selected?.updatedAt]);

  useEffect(() => {
    if (!selected) return;
    fillFrom(selected);
    setCrop((current) => frame && activeSet ? templateCrop(selected, activeSet, frame) : current);
    setDeleteConfirm(false);
  }, [selected?.id, activeSet?.directory]);

  useEffect(() => {
    if (!matchingProposal) return;
    setSelectedId(null);
    setName(matchingProposal.suggestedName);
    setTemplateId(''); setNote(''); setTags('');
    setThreshold(0.85);
    setRoi(null);
    setCrop(null);
    setFrame(null);
    clearDiffShots();
    setTestResult(null);
    setUsingProposal(true);
    setProposalReviewed(false);
  }, [matchingProposal?.sourceRecordId, gameId, index]);

  useEffect(() => { setConfirmOverwrite(false); setOverwriteConflict(null); }, [templateId, selectedId]);

  // Diff frames, crop or tolerance changed: recompute the 透明底 preview (debounced; frames are MB-sized).
  useEffect(() => {
    if (index === null || !frame || diffShots.length === 0 || !crop || !validCrop(crop, frame.width, frame.height)) {
      setAlphaPreview(null);
      setPreviewing(false);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setPreviewing(true);
      setPreviewError(null);
      avdm.previewAutomationTemplateAlpha(gameId, index, [frame.png, ...diffShots.map((shot) => shot.png)], crop, clampTolerance(tolerance), 320)
        .then((result) => { if (alive) setAlphaPreview({ png: result.previewPng, coverage: result.coverage }); })
        .catch((cause) => { if (alive) { setAlphaPreview(null); setPreviewError(errMsg(cause)); } })
        .finally(() => { if (alive) setPreviewing(false); });
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [gameId, index, frame, diffShots, crop, tolerance]);

  function fillFrom(item: TemplateDefinition): void {
    setName(item.name);
    setTemplateId(item.id);
    setNote(item.note ?? '');
    setTags(item.tags?.join(', ') ?? '');
    setThreshold(item.threshold ?? 0.85);
    setRoi(item.defaultRoi ?? null);
    setGuidance(null);
  }

  async function selectSet(directory: string): Promise<void> {
    if (index === null || busy || directory === activeSet?.directory) return;
    setBusy('switch');
    try {
      await avdm.saveAutomationSettings(gameId, index, { templateDir: directory });
      setFrame(null); clearDiffShots(); setTestResult(null); setSelectedId(null);
      await refresh(null);
      onChanged?.(directory);
      toast.push({ kind: 'success', title: '已切换模板集' });
    } catch (cause) { toast.error('无法切换模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function createSet(): Promise<void> {
    if (index === null || busy || !newSetName.trim()) return;
    setBusy('create');
    try {
      const created = await avdm.createAutomationTemplateSet(gameId, index, newSetName.trim());
      await avdm.saveAutomationSettings(gameId, index, { templateDir: created.directory });
      setNewSetName(''); setFrame(null); clearDiffShots(); setSelectedId(null);
      await refresh(null);
      onChanged?.(created.directory);
      toast.push({ kind: 'success', title: `模板集「${created.name}」已创建` });
    } catch (cause) { toast.error('无法创建模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function openFolder(): Promise<void> {
    if (index === null || busy) return;
    setBusy('switch');
    try {
      const directory = await avdm.pickAutomationTemplateSet();
      if (!directory) return;
      await avdm.saveAutomationSettings(gameId, index, { templateDir: directory });
      setFrame(null); clearDiffShots(); setSelectedId(null);
      await refresh(null);
      onChanged?.(directory);
      toast.push({ kind: 'success', title: '已载入本地模板集', detail: '直接在该文件夹里编辑；想留一份独立副本请用「导入 / 合并旧模板集」。' });
    } catch (cause) { toast.error('无法载入模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function importLegacy(): Promise<void> {
    if (busy) return;
    setBusy('import');
    try {
      const directory = await avdm.pickAutomationTemplateSet();
      if (!directory) return;
      const imported = await avdm.importAutomationTemplateSets(gameId, directory);
      setSets(imported.sets);
      setImportResult({ result: imported.result, pausedSchedules: imported.pausedSchedules });
      const summary = importSummary(imported.result, imported.pausedSchedules);
      toast.push({ kind: summary.changed ? 'success' : imported.result.found === 0 ? 'warn' : 'info', title: summary.title,
        detail: summary.lines.slice(0, 3).join('；') || undefined });
      // The active set gained templates: the same notification as a save (the gather page drops its probe).
      if (activeSet && importTouchesSet(imported, activeSet.directory)) onChanged?.(activeSet.directory);
      if (summary.changed && index !== null) await refresh(selectedId, true);
    } catch (cause) { toast.error('无法导入模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  function selectTemplate(item: TemplateDefinition): void {
    setSelectedId(item.id);
    fillFrom(item);
    setCrop(frame && activeSet ? templateCrop(item, activeSet, frame) : null);
    clearDiffShots(); setTestResult(null); setDeleteConfirm(false);
    setUsingProposal(false); setProposalReviewed(false);
  }

  function newTemplate(pick?: QuickPick): void {
    setSelectedId(null); setName(pick?.name ?? ''); setTemplateId(pick?.id ?? ''); setNote(pick?.note ?? ''); setTags(pick?.tags?.join(', ') ?? '');
    setThreshold(pick?.threshold ?? 0.85); setRoi(null); setCrop(null);
    clearDiffShots(); setTestResult(null); setDeleteConfirm(false); setGuidance(null);
    setUsingProposal(false); setProposalReviewed(false);
  }

  async function captureFrame(): Promise<void> {
    if (index === null || busy || !activeSet) return;
    setBusy('capture');
    try {
      const next = await avdm.captureAutomationTemplate(gameId, index);
      // A new main frame means the diff frames are no longer "the same place".
      setFrame(next); clearDiffShots(); setTestResult(null); setProposalReviewed(false); setGuidance(null);
      setCrop(usingProposal && matchingProposal ? proposalCrop(matchingProposal, next) : selected ? templateCrop(selected, activeSet, next) : null);
      toast.push({ kind: 'success', title: '已读取当前画面', detail: `${next.width}×${next.height} · ${beijingTime(next.capturedAt, 'clock')}` });
    } catch (cause) { toast.error('无法读取游戏画面', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function captureDiff(): Promise<void> {
    if (index === null || busy || !frame) return;
    if (diffShots.length >= MAX_DIFF_FRAMES) { toast.push({ kind: 'info', title: `最多 ${MAX_DIFF_FRAMES} 帧差分帧就够了` }); return; }
    setBusy('compare');
    try {
      const next = await avdm.captureAutomationTemplate(gameId, index);
      if (next.width !== frame.width || next.height !== frame.height) {
        throw new Error(`这一帧 ${next.width}×${next.height} 与主帧 ${frame.width}×${frame.height} 尺寸不一致，请在同一实例、同一分辨率下再抓`);
      }
      setDiffShots((current) => [...current, next].slice(0, MAX_DIFF_FRAMES));
    } catch (cause) { toast.error('无法读取差分帧', errMsg(cause)); }
    finally { setBusy(null); }
  }

  const frameReady = Boolean(frame && crop && validCrop(crop, frame.width, frame.height));
  const validRoi = Boolean(!roi || activeSet && [roi.x, roi.y, roi.w, roi.h].every(Number.isSafeInteger) && roi.x >= 0 && roi.y >= 0 &&
    roi.w >= 3 && roi.h >= 3 && roi.x + roi.w <= activeSet.refWidth && roi.y + roi.h <= activeSet.refHeight);
  const idProblem = templateIdProblem(templateId);
  const replaces = activeSet ? overwriteTarget(templateId, selectedId, activeSet.templates) : null;
  const canSave = index !== null && !busy && Boolean(activeSet && frame && frameReady && validRoi && name.trim()) && !idProblem &&
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 && (!usingProposal || proposalReviewed);
  const saveBlocker = !frame ? '先读取当前画面' : !frameReady ? `请在画面上拉出至少 ${MIN_TEMPLATE_CROP}×${MIN_TEMPLATE_CROP} 像素的截取框`
    : !name.trim() ? '给模板起个名字，例如「联盟按钮」' : idProblem ?? (!validRoi ? '搜索区域超出参考画布' : null);

  async function save(confirmed = false): Promise<void> {
    if (!canSave || index === null || !activeSet || !frame || !crop) return;
    if (replaces && !confirmed) { setConfirmOverwrite(true); return; }
    setBusy('save'); setGuidance(null);
    try {
      const result = await avdm.saveAutomationTemplate(gameId, index, buildTemplateDraft({
        templateId, selectedId, name, frame, crop, roi, threshold, note, tags, tolerance,
        diffFrames: diffShots.map((shot) => shot.png), confirmOverwrite: confirmed,
      }));
      setConfirmOverwrite(false); setOverwriteConflict(null);
      clearDiffShots();
      await refresh(result.definition.id);
      setSelectedId(result.definition.id);
      onChanged?.(activeSet.directory);
      setUsingProposal(false); setProposalReviewed(false);
      toast.push({ kind: 'success', title: result.replaced ? '模板已覆盖' : '模板已保存', detail: saveSuccessDetail(result.definition.name, result.std, result.maskCoverage) });
    } catch (cause) {
      const code = errorCodeOf(cause);
      const lowVariance = lowVarianceGuidance(code, errMsg(cause));
      if (lowVariance) setGuidance(lowVariance);
      else if (code === 'TEMPLATE_EXISTS') {
        // Another writer added this id after the page loaded the set: reload it (without touching the form) and ask.
        setOverwriteConflict(errMsg(cause));
        setConfirmOverwrite(true);
        void avdm.automationTemplateSet(gameId, index).then((current) => { if (current) setActiveSet(current); }).catch(() => undefined);
      } else toast.error('无法保存模板', errMsg(cause));
    } finally { setBusy(null); }
  }

  async function remove(): Promise<void> {
    if (index === null || busy || !selectedId || !deleteConfirm) return;
    setBusy('delete');
    try {
      await avdm.deleteAutomationTemplate(gameId, index, selectedId);
      const removed = selected?.name ?? selectedId;
      setFrame(null); clearDiffShots(); setTestResult(null); setSelectedId(null);
      await refresh(null);
      if (activeSet) onChanged?.(activeSet.directory);
      setDeleteConfirm(false);
      toast.push({ kind: 'success', title: `模板「${removed}」已删除` });
    } catch (cause) { toast.error('无法删除模板', errMsg(cause)); }
    finally { setBusy(null); }
  }

  /** 立即验证: a fresh frame, matched and previewed on that same frame. The editor passes its unsaved ROI / threshold. */
  async function test(id: string, fromForm: boolean): Promise<void> {
    if (index === null || busy) return;
    setBusy('test'); setTestResult(null);
    try {
      const options = fromForm ? { ...(roi ? { roi } : {}), threshold } : {};
      const result = await avdm.testAutomationTemplate(gameId, index, id, options);
      setTestResult(result);
      const verdict = testVerdict(result.match);
      toast.push({ kind: verdict.found ? 'success' : 'warn', title: verdict.found ? '最新画面命中模板' : '最新画面未命中', detail: verdict.title });
    } catch (cause) { toast.error('无法验证模板', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function fullCheck(): Promise<void> {
    if (busy) return;
    setBusy('coverage');
    try { await loadCoverage(true); }
    finally { setBusy(null); }
  }

  function pointerPosition(event: PointerEvent<HTMLDivElement>, width: number, height: number): { x: number; y: number } {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: clamp(Math.round((event.clientX - bounds.left) / bounds.width * width), 0, width),
      y: clamp(Math.round((event.clientY - bounds.top) / bounds.height * height), 0, height) };
  }

  function startDraw(event: PointerEvent<HTMLDivElement>): void {
    if (!frame || !activeSet || busy || event.button !== 0) return;
    const width = drawMode === 'crop' ? frame.width : activeSet.refWidth;
    const height = drawMode === 'crop' ? frame.height : activeSet.refHeight;
    drawStart.current = { ...pointerPosition(event, width, height), mode: drawMode };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveDraw(event: PointerEvent<HTMLDivElement>): void {
    const start = drawStart.current;
    if (!start || !frame || !activeSet) return;
    const width = start.mode === 'crop' ? frame.width : activeSet.refWidth;
    const height = start.mode === 'crop' ? frame.height : activeSet.refHeight;
    const end = pointerPosition(event, width, height);
    const next = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    if (next.w < 3 || next.h < 3) return;
    if (start.mode === 'crop') { setCrop(next); setProposalReviewed(false); setGuidance(null); }
    else setRoi(next);
  }

  function endDraw(event: PointerEvent<HTMLDivElement>): void {
    if (!drawStart.current) return;
    moveDraw(event);
    drawStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const lowResolution = frame && activeSet ? resolutionWarning(frame, activeSet) : null;
  const coverageHint = alphaPreview ? describeCoverage(alphaPreview.coverage) : null;
  const verdict = testResult ? testVerdict(testResult.match) : null;
  const importView = importResult ? importSummary(importResult.result, importResult.pausedSchedules) : null;
  const missingGlyphSets = coverage?.glyphs.filter((glyph) => glyph.present.length === 0) ?? [];
  const partialGlyphSets = coverage?.glyphs.filter((glyph) => glyph.present.length > 0 && glyph.missingDigits.length > 0) ?? [];

  return (
    <section className="template-panel" aria-label="模板库">
      <header className="template-panel-header">
        <div className="template-panel-header-icon"><Icon name="layers" size={20} /></div>
        <div><h2>模板库</h2><p>从实例读取画面、框选识别区域，保存到当前实例的本地模板集。模板、截图都只留在本机，不进安装包。</p></div>
        <button className="btn" type="button" onClick={() => void importLegacy()} disabled={busy !== null}>{busy === 'import' ? <Spinner size={14} /> : <Icon name="download" />}导入 / 合并旧模板集</button>
        <button className="btn" type="button" onClick={() => { setBusy('load'); void refresh().catch((cause) => setError(errMsg(cause))).finally(() => setBusy(null)); }} disabled={busy !== null}><Icon name="refresh" />刷新</button>
      </header>


      {error && <div className="template-panel-error" role="alert"><Icon name="alert" />{error}</div>}
      {importView && <div className={`notice ${importView.changed ? 'info' : 'warn'} template-import-result`} role="status" aria-live="polite">
        <Icon name="download" />
        <div><strong>{importView.title}</strong>{importView.lines.length > 0 && <ul>{importView.lines.map((line) => <li key={line}>{line}</li>)}</ul>}
          <span>导入只增不改：已有的模板（阈值、ROI、重裁过的图、AI 自学的模板）一个字节都不会动。导入的模板集要在「切换模板集」里选中才会用于当前实例。</span></div>
        <button className="icon-btn small" type="button" aria-label="关闭导入结果" onClick={() => setImportResult(null)}><Icon name="close" size={14} /></button>
      </div>}
      {index === null && <div className="template-panel-empty"><Icon name="devices" size={22} /><strong>先选择一个实例</strong><span>模板集、截图与测试都跟随当前游戏和实例。</span></div>}

      {index !== null && <>
        <div className="template-library-bar">
          <div className="template-library-current"><span>当前模板集</span><strong>{activeSet?.name ?? '尚未选择'}</strong><small title={activeSet?.directory}>{activeSet ? `参考分辨率 ${activeSet.refWidth}×${activeSet.refHeight} · ${activeSet.templates.length} 张模板${activeSet.packageName ? ` · ${activeSet.packageName}` : ''}` : '先新建、载入文件夹或导入旧模板集'}</small></div>
          <label className="template-library-select"><span>切换模板集</span><select value={activeSet?.directory ?? ''} onChange={(event) => void selectSet(event.target.value)} disabled={busy !== null || sets.length === 0}><option value="" disabled>选择模板集</option>{activeSet && !sets.some((item) => item.directory === activeSet.directory) && <option value={activeSet.directory}>{activeSet.name}（本地文件夹）</option>}{sets.map((item) => <option key={item.id} value={item.directory}>{item.name}（{item.templates.length} 张）</option>)}</select></label>
          <button className="btn" type="button" onClick={() => void openFolder()} disabled={busy !== null}><Icon name="folder" />载入文件夹</button>
        </div>

        <div className="template-create-set"><label><span>新建模板集</span><input type="text" value={newSetName} onChange={(event) => setNewSetName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createSet(); }} placeholder="例如：万龙觉醒 1440p" maxLength={100} disabled={busy !== null} /></label><button className="btn" type="button" onClick={() => void createSet()} disabled={busy !== null || !newSetName.trim()}>{busy === 'create' ? <Spinner size={14} /> : <Icon name="plus" />}创建并使用</button></div>

        {activeSet && !coverage && coverageError && <div className="template-panel-error" role="alert"><Icon name="alert" />模板覆盖检查失败：{coverageError}<button className="btn xs" type="button" onClick={() => void loadCoverage(false)} disabled={busy !== null}>重试</button></div>}
        {activeSet && coverage && <details className="template-coverage" open={!coverage.ready}>
          <summary>
            <span className={`tag ${coverage.ready ? 'ok' : 'warn'}`}>{coverage.ready ? '关键模板齐全' : `缺 ${coverage.critical.length} 张关键模板`}</span>
            <span>可选缺 {coverage.optional.length} 张 · 字形缺 {partialGlyphSets.reduce((sum, glyph) => sum + glyph.missingDigits.length, 0)} 个数字{missingGlyphSets.length ? ` · ${missingGlyphSets.length} 套字形整套缺失` : ''}{coverage.compiled ? ` · 已编译检查，${coverage.failed.length} 张失败` : ''}</span>
          </summary>
          <div className="template-coverage-body">
            <p>自动采集按固定 ID 引用模板。点下面的 ID 会新建一张模板并把 ID、名称（字形还有标签和阈值）填好，读取画面、框选后保存即可。★ 字形集必须覆盖 0~9，缺一个数字读数就会「说谎」。</p>
            {picks.length > 0 ? <div className="template-quick-picks">
              {picks.map((pick) => <button key={pick.key} type="button" className={`template-quick-pick is-${pick.group}`} onClick={() => newTemplate(pick)} disabled={busy !== null} title={pick.detail}>
                <span>{pick.group === 'critical' ? '关键' : pick.group === 'optional' ? '可选' : '字形'}</span><code>{pick.id}</code><small>{pick.detail}</small>
              </button>)}
            </div> : <p className="template-library-note">采集用到的关键、可选模板都在。</p>}
            {missingGlyphSets.length > 0 && <p className="template-coverage-glyphs">整套缺失的字形集：{missingGlyphSets.map((glyph) => `${glyph.name}（${glyph.label}）`).join('、')}。用开发者工具 tplkit 的 glyphs 子命令整串切字最快。</p>}
            {coverage.compiled && coverage.failed.length > 0 && <ul className="template-coverage-failed">{coverage.failed.map((item) => <li key={item.id}><code>{item.id}</code> {item.reason}</li>)}</ul>}
            <div className="template-coverage-actions"><button className="btn sm" type="button" onClick={() => void fullCheck()} disabled={busy !== null}>{busy === 'coverage' ? <Spinner size={14} /> : <Icon name="search" />}完整检查（编译全部模板）</button>{coverageError && <span className="template-validation" role="alert">{coverageError}</span>}</div>
          </div>
        </details>}
        {activeSet && gameId === 'wanlong' && <ResourceTemplatesCard gameId={gameId} index={index} set={activeSet} disabled={busy !== null} onPick={(pick) => newTemplate(pick)} onChanged={onChanged} />}

        {activeSet && <div className="template-workspace">
          <aside className="template-library-list" aria-label="当前模板集中的模板">
            <div className="template-library-list-head"><strong>模板列表</strong><span>{activeSet.templates.length}</span></div>
            <button className={`template-list-item ${!selectedId ? 'is-selected' : ''}`} type="button" onClick={() => newTemplate()} disabled={busy !== null}><Icon name="plus" /><span><strong>新建模板</strong></span></button>
            {activeSet.templates.map((item) => {
              const std = stdBadge(item.std);
              const mask = maskBadge(item.maskCoverage);
              return <div className="template-list-row" key={item.id}>
                <button className={`template-list-item ${selectedId === item.id ? 'is-selected' : ''}`} type="button" onClick={() => selectTemplate(item)} disabled={busy !== null}>
                  <Icon name="grid" />
                  <span>
                    <strong>{item.name}</strong>
                    <span className="template-badges">{std && <em className={`template-badge is-${std.tone}`} title={std.hint}>{std.label}</em>}{mask && <em className="template-badge is-info" title={mask.hint}>{mask.label}</em>}</span>
                    <small title={item.id}>{item.id} · {templateSummary(item)}</small>
                  </span>
                </button>
                <button className="icon-btn small template-list-test" type="button" aria-label={`立即验证 ${item.name}`} title="在当前实例的真实画面上跑一次匹配" onClick={() => void test(item.id, false)} disabled={busy !== null}><Icon name="search" size={14} /></button>
              </div>;
            })}
            {activeSet.templates.length === 0 && <p className="template-library-note">这个集合里还没有模板。读取游戏画面并拖选第一个识别区域。</p>}
          </aside>

          <div className="template-editor">
            {usingProposal && matchingProposal && <div className="template-proposal" role="status"><Icon name="chip" /><div><strong>来自 AI 顾问的建议</strong><p>建议区域来自旧截图。请重新读取当前画面，检查裁剪框后手动确认保存。</p></div></div>}

            {selected && <div className="template-details">
              <div className="template-details-image">{templateUrl ? <img src={templateUrl} alt={`${selected.name} 已保存图像`} /> : <span>图片加载中…</span>}</div>
              <dl>
                <dt>截取时画面</dt><dd>{selected.authoredWidth}×{selected.authoredHeight}</dd>
                <dt>参考坐标</dt><dd>{rectText(selected.bounds)}</dd>
                <dt>默认 ROI</dt><dd>{selected.defaultRoi ? rectText(selected.defaultRoi) : '未设置（全屏搜索，慢 40 倍左右）'}</dd>
                <dt>阈值</dt><dd>{selected.threshold ?? '默认 0.85'}</dd>
                {typeof selected.std === 'number' && <><dt>灰度标准差</dt><dd>{selected.std.toFixed(1)}（下限 12）</dd></>}
                {typeof selected.maskCoverage === 'number' && <><dt>透明底</dt><dd>不透明 {Math.round(selected.maskCoverage * 100)}%，其余像素（会变的背景）不参与匹配</dd></>}
                {selected.tags?.length ? <><dt>标签</dt><dd>{selected.tags.join('、')}</dd></> : null}
                {selected.note && <><dt>备注</dt><dd className="pre-wrap">{selected.note}</dd></>}
                {selected.updatedAt && <><dt>更新时间</dt><dd>{beijingTime(selected.updatedAt, 'minute')}（北京时间）</dd></>}
              </dl>
            </div>}

            <div className="template-editor-head"><div><h3>{selected ? `编辑 ${selected.name}` : '新建模板'}</h3><p>{selected ? '保存前需要读取新画面，按原位置预填裁剪框供核对。' : '先读取画面，再拖选要识别的图像。'}</p></div><button className="btn primary" type="button" onClick={() => void captureFrame()} disabled={busy !== null}>{busy === 'capture' ? <Spinner size={14} /> : <Icon name="camera" />}{frame ? '重新截图' : '读取当前画面'}</button></div>
            {lowResolution && <div className="notice warn template-inline-notice" role="status"><Icon name="alert" /><span>{lowResolution}</span></div>}

            <div className="template-canvas-area">
              <div className="template-canvas-toolbar"><div className="template-mode" role="group" aria-label="框选模式"><button type="button" className={drawMode === 'crop' ? 'is-active' : ''} onClick={() => setDrawMode('crop')} disabled={!frame || busy !== null}>裁剪模板</button><button type="button" className={drawMode === 'roi' ? 'is-active' : ''} onClick={() => setDrawMode('roi')} disabled={!frame || busy !== null}>搜索区域</button></div><button className="btn xs" type="button" onClick={() => { if (drawMode === 'crop') { setCrop(null); setGuidance(null); } else setRoi(null); }} disabled={!frame || busy !== null || (drawMode === 'crop' ? !crop : !roi)}><Icon name="close" size={12} />清除当前框</button><span>{frame ? `无损 PNG · ${frame.width} × ${frame.height} · ${beijingTime(frame.capturedAt, 'clock')}` : '等待截图'}</span></div>
              {frame && frameUrl ? <div className={`template-frame-stage ${drawMode === 'roi' ? 'is-roi' : ''}`} onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={endDraw} onPointerCancel={endDraw}><img src={frameUrl} alt={`实例 #${index} 当前游戏画面`} draggable={false} />{roi && <div className="template-frame-roi" style={rectStyle(roi, activeSet.refWidth, activeSet.refHeight)}><span>搜索区域 ROI</span></div>}{crop && <div className="template-frame-crop" style={rectStyle(crop, frame.width, frame.height)}><span>模板 {crop.w}×{crop.h}</span></div>}</div> : <div className="template-frame-placeholder"><Icon name="camera" size={28} /><strong>画面尚未读取</strong><span>截图只用于本地模板编辑，不会向游戏发送操作。</span></div>}
              <p className="template-canvas-hint">{drawMode === 'crop' ? '在画面上拖动以框选模板（截图像素坐标），也可在下方输入坐标。' : '在画面上拖动以限制匹配搜索范围；坐标使用模板集参考分辨率。'}</p>
            </div>

            <div className="template-editor-fields">
              <label className="template-field template-field-name"><span>模板名称</span><input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：联盟按钮 / 每日签到弹窗" maxLength={100} disabled={busy !== null} /></label>
              <label className="template-field template-field-id"><span>模板 ID（可选）</span><input type="text" value={templateId} onChange={(event) => setTemplateId(event.target.value)} placeholder="留空自动生成，如 tpl_btn_close_popup" maxLength={64} disabled={busy !== null} title="流程 / 调度器按 ID 引用模板：填已有的 ID 会覆盖那张模板（例如补裁 tpl_btn_close_popup）；留空自动生成。" aria-invalid={Boolean(idProblem)} /></label>
              <label className="template-field"><span>匹配阈值</span><input type="number" min={0.5} max={0.999} step={0.01} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} disabled={busy !== null} /></label>
            </div>
            <div className="template-editor-fields">
              <label className="template-field template-field-name"><span>标签（逗号分隔；字形集用 digit + 前缀）</span><input type="text" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="例如：digit, dig_panel_level" maxLength={400} disabled={busy !== null} /></label>
              <label className="template-field template-field-name"><span>备注（可选）</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} disabled={busy !== null} placeholder="例如：从哪个界面、哪个阵营的号裁的" /></label>
            </div>
            {idProblem && <p className="template-validation" role="status">{idProblem}</p>}

            <div className="template-coordinate-group"><div><strong>模板裁剪</strong><span>截图像素坐标，至少 {MIN_TEMPLATE_CROP}×{MIN_TEMPLATE_CROP}</span></div><div className="template-coordinate-inputs">{(['x', 'y', 'w', 'h'] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" min={key === 'w' || key === 'h' ? MIN_TEMPLATE_CROP : 0} value={crop?.[key] ?? ''} onChange={(event) => { const value = Number(event.target.value); setCrop((old) => ({ ...old ?? { x: 0, y: 0, w: MIN_TEMPLATE_CROP, h: MIN_TEMPLATE_CROP }, [key]: value })); setProposalReviewed(false); setGuidance(null); }} disabled={!frame || busy !== null} /></label>)}</div></div>
            <div className="template-coordinate-group"><div><strong>搜索区域</strong><span>参考画布坐标，留空则按模板位置自动外扩</span></div><div className="template-coordinate-inputs">{(['x', 'y', 'w', 'h'] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" min={key === 'w' || key === 'h' ? 3 : 0} value={roi?.[key] ?? ''} onChange={(event) => setRoi((old) => ({ ...old ?? { x: 0, y: 0, w: activeSet.refWidth, h: activeSet.refHeight }, [key]: Number(event.target.value) }))} disabled={busy !== null} /></label>)}<button className="btn xs" type="button" onClick={() => setRoi(null)} disabled={!roi || busy !== null}>自动</button></div></div>
            <div className="notice info template-inline-notice"><Icon name="info" /><span><strong>{ROI_ADVICE.title}</strong>{ROI_ADVICE.detail}</span></div>

            <section className="template-alpha-section" aria-labelledby="template-alpha-title">
              <div className="template-alpha-head">
                <div><h4 id="template-alpha-title">透明底（去掉会变的背景）</h4>{diffShots.length > 0 && <span className="tag">已抓 {diffShots.length}/{MAX_DIFF_FRAMES} 帧</span>}</div>
                <div><button className="btn sm" type="button" onClick={() => void captureDiff()} disabled={!frame || busy !== null || diffShots.length >= MAX_DIFF_FRAMES}>{busy === 'compare' ? <Spinner size={14} /> : <Icon name="camera" />}再抓一帧去底</button><button className="btn sm" type="button" onClick={clearDiffShots} disabled={diffShots.length === 0 || busy !== null}><Icon name="close" size={12} />清空</button></div>
              </div>
              <p>圆环 / 镂空 / 半透明、压在地图或城内地形上的控件，整块裁下来会随背景漂移。做法：先把游戏画面<strong>拖开一点</strong>（让图标底下的背景变了、图标本身没动），再点「再抓一帧去底」，抓 1~{MAX_DIFF_FRAMES} 帧。几帧之间没变的像素才当模板本体，其余抠成透明、不参与匹配。实心控件不需要这一步。</p>
              <div className="template-alpha-actions">
                <label title="RGB 任一通道差值 ≤ 容差视为「没变」。默认 24；背景只是轻微变化时调小，画面有压缩噪点时调大。"><span>容差（{ALPHA_TOLERANCE_RANGE.min}~{ALPHA_TOLERANCE_RANGE.max}）</span><input type="number" min={ALPHA_TOLERANCE_RANGE.min} max={ALPHA_TOLERANCE_RANGE.max} step={1} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} onBlur={() => setTolerance((value) => clampTolerance(value))} disabled={busy !== null} /></label>
                {diffShots.map((shot, i) => <DiffThumb key={shot.capturedAt} shot={shot} label={`差分帧 ${i + 1}`} />)}
              </div>
              {diffShots.length > 0 && <div className="template-alpha-result" aria-live="polite">
                {alphaPreview && alphaUrl && coverageHint ? <>
                  <img src={alphaUrl} alt="去底预览，洋红色表示抠掉、不参与匹配的像素" />
                  <div><span className={`template-badge is-${coverageHint.tone}`}>不透明 {Math.round(alphaPreview.coverage * 100)}%</span><span>{coverageHint.hint}</span><span>保存时主进程会用同一套算法按这 {diffShots.length + 1} 帧重算掩码。</span></div>
                </> : <span>{previewError ? `预览失败：${previewError}` : !frameReady ? '先在画面上拉一个截取框，这里会显示去底效果' : previewing ? '计算中…' : '等待预览'}</span>}
              </div>}
            </section>

            {guidance && <div className="notice bad template-guidance" role="alert">
              <Icon name="alert" />
              <div><strong>{guidance.title}</strong>{guidance.paragraphs.map((text) => <p key={text}>{text}</p>)}</div>
              <button className="icon-btn small" type="button" aria-label="关闭提示" onClick={() => setGuidance(null)}><Icon name="close" size={14} /></button>
            </div>}
            {confirmOverwrite && (replaces || overwriteConflict) && <div className="notice warn template-overwrite" role="alert">
              <Icon name="alert" />
              <span>{replaces ? `模板 ID「${replaces.id}」已被「${replaces.name}」使用。` : `${overwriteConflict} `}保存会覆盖它（清单里的位置与创建时间保留），流程按这个 ID 引用的就是新图。</span>
              <div><button className="btn sm" type="button" onClick={() => { setConfirmOverwrite(false); setOverwriteConflict(null); }} disabled={busy !== null}>取消</button><button className="btn sm danger" type="button" onClick={() => void save(true)} disabled={!canSave}>确认覆盖</button></div>
            </div>}

            {usingProposal && matchingProposal && <label className="template-review-check"><input type="checkbox" checked={proposalReviewed} onChange={(event) => setProposalReviewed(event.target.checked)} disabled={!frame || !frameReady || frame.capturedAt <= matchingProposal.sourceCapturedAt || busy !== null} /><span>我已在新截图中核对裁剪区域，确认保存为本地模板</span></label>}
            {frame && saveBlocker && <p className="template-validation" role="status">{saveBlocker}</p>}
            <div className="template-editor-actions">
              <div>{selected && deleteConfirm && <span className="template-validation">{DELETE_WARNING}</span>}</div>
              <div className="template-editor-action-buttons">
                {selected && (deleteConfirm ? <><button className="btn" type="button" onClick={() => setDeleteConfirm(false)} disabled={busy !== null}>取消</button><button className="btn danger" type="button" onClick={() => void remove()} disabled={busy !== null}>{busy === 'delete' ? <Spinner size={14} /> : <Icon name="trash" />}确认删除</button></> : <button className="btn danger-ghost" type="button" onClick={() => setDeleteConfirm(true)} disabled={busy !== null}><Icon name="trash" />删除模板</button>)}
                <button className="btn primary" type="button" onClick={() => void save()} disabled={!canSave}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}{selected && templateId.trim() === selected.id ? '保存修改' : '保存模板'}</button>
              </div>
            </div>

            {selected && <section className="template-test"><div><h4>立即验证</h4><p>重新截图并在同一帧上跑一次本地匹配（使用上面填的阈值与搜索区域），结果不会触发任何点击。</p></div><button className="btn" type="button" onClick={() => void test(selected.id, true)} disabled={busy !== null}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="search" />}立即验证</button></section>}
            {testResult && testUrl && verdict && <div className="template-test-result" aria-live="polite"><div className={`template-test-verdict ${verdict.found ? 'is-found' : ''}`}><Icon name={verdict.found ? 'check' : 'alert'} /><strong>{verdict.title}</strong><span>{testResult.match.templateId}</span></div><div className="template-test-frame"><img src={testUrl} alt="最新画面模板匹配结果" />{testResult.match.found && <div className="template-test-box is-found" style={rectStyle(testResult.match, activeSet.refWidth, activeSet.refHeight)} />}</div><p>{verdict.detail}</p></div>}
          </div>
        </div>}
      </>}
    </section>
  );
}
