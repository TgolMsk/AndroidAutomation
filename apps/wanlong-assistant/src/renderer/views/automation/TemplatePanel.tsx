import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Rect, TemplateDefinition, TemplateSet } from '@avdm/automation';
import type { TemplateAlphaPreview, TemplateCapture, TemplateTestResult } from '../../../shared/ipc';
import type { AdvisorTemplateProposal } from '../../../main/automation/advisor/types';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import type { TemplateInsertRequest, TemplateSavedForScript } from './script-template-flow';
import './TemplatePanel.css';

interface TemplatePanelProps {
  gameId: string;
  index: number | null;
  onChanged?: (directory: string) => void;
  proposal?: AdvisorTemplateProposal | null;
  scriptInsert?: TemplateInsertRequest | null;
  onScriptTemplateSaved?: (saved: TemplateSavedForScript, requestId: string) => void;
  onCancelScriptInsert?: () => void;
}

type BusyAction = 'load' | 'create' | 'switch' | 'capture' | 'compare' | 'alpha' | 'save' | 'delete' | 'test' | null;
type DrawMode = 'crop' | 'roi';

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

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Template edits are based on a fresh, read-only screen capture and an explicit crop. */
export function TemplatePanel({ gameId, index, onChanged, proposal, scriptInsert, onScriptTemplateSaved, onCancelScriptInsert }: TemplatePanelProps) {
  const toast = useToast();
  const [sets, setSets] = useState<TemplateSet[]>([]);
  const [activeSet, setActiveSet] = useState<TemplateSet | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSetName, setNewSetName] = useState('');
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState(0.85);
  const [roi, setRoi] = useState<Rect | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [frame, setFrame] = useState<TemplateCapture | null>(null);
  const [compare, setCompare] = useState<TemplateCapture | null>(null);
  const [alpha, setAlpha] = useState<TemplateAlphaPreview | null>(null);
  const [alphaTolerance, setAlphaTolerance] = useState(24);
  const [testResult, setTestResult] = useState<TemplateTestResult | null>(null);
  const [templateImage, setTemplateImage] = useState<Uint8Array | null>(null);
  const [drawMode, setDrawMode] = useState<DrawMode>('crop');
  const [busy, setBusy] = useState<BusyAction>('load');
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [usingProposal, setUsingProposal] = useState(false);
  const [proposalReviewed, setProposalReviewed] = useState(false);
  const drawStart = useRef<{ x: number; y: number; mode: DrawMode } | null>(null);
  const startedScriptInsert = useRef<string | null>(null);

  const selected = useMemo(() => activeSet?.templates.find((item) => item.id === selectedId) ?? null, [activeSet, selectedId]);
  const matchingProposal = proposal && proposal.gameId === gameId && proposal.index === index ? proposal : null;
  const frameUrl = usePngUrl(frame?.png ?? null);
  const templateUrl = usePngUrl(templateImage);
  const alphaUrl = usePngUrl(alpha?.previewPng ?? null);
  const testUrl = usePngUrl(testResult?.preview.png ?? null);

  const refresh = useCallback(async (preferId?: string | null) => {
    if (!gameId) { setSets([]); setActiveSet(null); setBusy(null); return; }
    const [managed, current] = await Promise.all([
      avdm.automationTemplateSets(gameId),
      index === null ? Promise.resolve(null) : avdm.automationTemplateSet(gameId, index),
    ]);
    setSets(managed);
    setActiveSet(current);
    setSelectedId((previous) => {
      const candidate = preferId === undefined ? previous : preferId;
      return current?.templates.some((item) => item.id === candidate) ? candidate : current?.templates[0]?.id ?? null;
    });
    setError(null);
  }, [gameId, index]);

  useEffect(() => {
    let alive = true;
    setBusy('load'); setError(null); setFrame(null); setCompare(null); setAlpha(null); setTestResult(null);
    setSelectedId(null); setUsingProposal(false); setProposalReviewed(false);
    void refresh().catch((cause) => { if (alive) setError(errMsg(cause)); }).finally(() => { if (alive) setBusy(null); });
    return () => { alive = false; };
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    setTemplateImage(null);
    if (index !== null && selectedId) {
      void avdm.automationTemplateImage(gameId, index, selectedId)
        .then((image) => { if (alive) setTemplateImage(image); })
        .catch((cause) => { if (alive) setError(errMsg(cause)); });
    }
    return () => { alive = false; };
  }, [gameId, index, selectedId, activeSet?.directory]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setThreshold(selected.threshold ?? 0.85);
    setRoi(selected.defaultRoi ?? null);
    setCrop((current) => frame && activeSet ? templateCrop(selected, activeSet, frame) : current);
    setAlpha(null);
    setDeleteConfirm(false);
  }, [selected?.id, activeSet?.directory]);

  useEffect(() => {
    if (!matchingProposal) return;
    setSelectedId(null);
    setName(matchingProposal.suggestedName);
    setThreshold(0.85);
    setRoi(null);
    setCrop(null);
    setFrame(null);
    setCompare(null);
    setAlpha(null);
    setTestResult(null);
    setUsingProposal(true);
    setProposalReviewed(false);
  }, [matchingProposal?.sourceRecordId, gameId, index]);

  async function selectSet(directory: string): Promise<void> {
    if (index === null || busy || directory === activeSet?.directory) return;
    setBusy('switch');
    try {
      await avdm.saveAutomationSettings(gameId, index, { templateDir: directory });
      setFrame(null); setCompare(null); setAlpha(null); setTestResult(null); setSelectedId(null);
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
      setNewSetName(''); setFrame(null); setCompare(null); setAlpha(null); setSelectedId(null);
      await refresh(null);
      onChanged?.(created.directory);
      toast.push({ kind: 'success', title: '模板集已创建' });
    } catch (cause) { toast.error('无法创建模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function importSet(): Promise<void> {
    if (index === null || busy) return;
    setBusy('switch');
    try {
      const directory = await avdm.pickAutomationTemplateSet();
      if (!directory) return;
      await avdm.saveAutomationSettings(gameId, index, { templateDir: directory });
      setFrame(null); setCompare(null); setAlpha(null); setSelectedId(null);
      await refresh(null);
      onChanged?.(directory);
      toast.push({ kind: 'success', title: '已载入本地模板集' });
    } catch (cause) { toast.error('无法载入模板集', errMsg(cause)); }
    finally { setBusy(null); }
  }

  function selectTemplate(item: TemplateDefinition): void {
    setSelectedId(item.id);
    setName(item.name);
    setThreshold(item.threshold ?? 0.85);
    setRoi(item.defaultRoi ?? null);
    setCrop(frame && activeSet ? templateCrop(item, activeSet, frame) : null);
    setAlpha(null); setCompare(null); setTestResult(null); setDeleteConfirm(false);
    setUsingProposal(false); setProposalReviewed(false);
  }

  function newTemplate(): void {
    setSelectedId(null); setName(''); setThreshold(0.85); setRoi(null); setCrop(null);
    setAlpha(null); setCompare(null); setTestResult(null); setDeleteConfirm(false);
    setUsingProposal(false); setProposalReviewed(false);
  }

  async function captureFrame(asNew = false): Promise<void> {
    if (index === null || busy || !activeSet) return;
    setBusy('capture');
    try {
      const next = await avdm.captureAutomationTemplate(gameId, index);
      setFrame(next); setCompare(null); setAlpha(null); setTestResult(null); setProposalReviewed(false);
      setCrop(asNew ? null : usingProposal && matchingProposal ? proposalCrop(matchingProposal, next) : selected ? templateCrop(selected, activeSet, next) : null);
      toast.push({ kind: 'success', title: '已读取当前画面', detail: `${next.width}×${next.height} · ${timeLabel(next.capturedAt)}` });
    } catch (cause) { toast.error('无法读取游戏画面', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function captureCompare(): Promise<void> {
    if (index === null || busy || !frame || !crop) return;
    setBusy('compare');
    try {
      const next = await avdm.captureAutomationTemplate(gameId, index);
      if (next.width !== frame.width || next.height !== frame.height) throw new Error('两次截图尺寸不同，请重新采集第一帧');
      setCompare(next); setAlpha(null);
      toast.push({ kind: 'success', title: '第二帧已读取', detail: '可生成差分透明区域。' });
    } catch (cause) { toast.error('无法读取第二帧', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function previewAlpha(): Promise<void> {
    if (index === null || busy || !frame || !compare || !crop) return;
    setBusy('alpha');
    try {
      const next = await avdm.previewAutomationTemplateAlpha(gameId, index, [frame.png, compare.png], crop, alphaTolerance);
      setAlpha(next);
    } catch (cause) { toast.error('无法生成去底预览', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function save(): Promise<void> {
    if (index === null || busy || !activeSet || !frame || !crop || !name.trim() || !validCrop || !validRoi ||
      !Number.isFinite(threshold) || threshold < 0 || threshold > 1 || (usingProposal && !proposalReviewed)) return;
    setBusy('save');
    try {
      const result = await avdm.saveAutomationTemplate(gameId, index, {
        ...(selectedId ? { id: selectedId } : {}), name: name.trim(), image: frame.png,
        authoredWidth: frame.width, authoredHeight: frame.height, crop,
        ...(roi ? { defaultRoi: roi } : {}), threshold,
        ...(alpha ? { alpha: alpha.alphaPng } : {}),
      });
      await refresh(result.definition.id);
      setSelectedId(result.definition.id);
      onChanged?.(activeSet.directory);
      if (scriptInsert && scriptInsert.gameId === gameId && scriptInsert.index === index) {
        onScriptTemplateSaved?.({ templateId: result.definition.id, templateName: result.definition.name, templateSetId: activeSet.id }, scriptInsert.id);
      }
      setUsingProposal(false); setProposalReviewed(false);
      toast.push({ kind: 'success', title: '模板已保存', detail: `${result.definition.name} · 图像方差 ${result.std.toFixed(1)}` });
    } catch (cause) { toast.error('无法保存模板', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function remove(): Promise<void> {
    if (index === null || busy || !selectedId || !deleteConfirm) return;
    setBusy('delete');
    try {
      await avdm.deleteAutomationTemplate(gameId, index, selectedId);
      setFrame(null); setCompare(null); setAlpha(null); setTestResult(null); setSelectedId(null);
      await refresh(null);
      if (activeSet) onChanged?.(activeSet.directory);
      setDeleteConfirm(false);
      toast.push({ kind: 'success', title: '模板已删除' });
    } catch (cause) { toast.error('无法删除模板', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function test(): Promise<void> {
    if (index === null || busy || !selectedId) return;
    setBusy('test'); setTestResult(null);
    try {
      const result = await avdm.testAutomationTemplate(gameId, index, selectedId);
      setTestResult(result);
      toast.push({ kind: result.match.found ? 'success' : 'warn', title: result.match.found ? '最新画面命中模板' : '最新画面未达到阈值',
        detail: `${result.match.score.toFixed(3)} / ${result.match.threshold.toFixed(3)}` });
    } catch (cause) { toast.error('无法测试模板', errMsg(cause)); }
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
    const next = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
    if (next.w < 3 || next.h < 3) return;
    if (start.mode === 'crop') { setCrop(next); setAlpha(null); setProposalReviewed(false); }
    else setRoi(next);
  }

  function endDraw(event: PointerEvent<HTMLDivElement>): void {
    if (!drawStart.current) return;
    moveDraw(event);
    drawStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const validCrop = Boolean(frame && crop && Number.isSafeInteger(crop.x) && Number.isSafeInteger(crop.y) &&
    Number.isSafeInteger(crop.w) && Number.isSafeInteger(crop.h) && crop.x >= 0 && crop.y >= 0 &&
    crop.w >= 3 && crop.h >= 3 && crop.x + crop.w <= frame.width && crop.y + crop.h <= frame.height);
  const validRoi = Boolean(!roi || activeSet && Number.isSafeInteger(roi.x) && Number.isSafeInteger(roi.y) &&
    Number.isSafeInteger(roi.w) && Number.isSafeInteger(roi.h) && roi.x >= 0 && roi.y >= 0 &&
    roi.w >= 3 && roi.h >= 3 && roi.x + roi.w <= activeSet.refWidth && roi.y + roi.h <= activeSet.refHeight);
  const canSave = index !== null && !busy && Boolean(activeSet && frame && validCrop && validRoi && name.trim()) &&
    Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 && (!usingProposal || proposalReviewed) &&
    !(scriptInsert?.expectedTemplateSetId && activeSet?.id !== scriptInsert.expectedTemplateSetId);

  useEffect(() => {
    if (!scriptInsert || scriptInsert.gameId !== gameId || scriptInsert.index !== index || !activeSet || busy !== null ||
      (scriptInsert.expectedTemplateSetId && activeSet.id !== scriptInsert.expectedTemplateSetId) ||
      startedScriptInsert.current === scriptInsert.id) return;
    startedScriptInsert.current = scriptInsert.id;
    newTemplate();
    void captureFrame(true);
  }, [scriptInsert?.id, activeSet?.id, busy, gameId, index]);

  return (
    <section className="template-panel" aria-label="模板编辑器">
      <header className="template-panel-header">
        <div className="template-panel-header-icon"><Icon name="layers" size={20} /></div>
        <div><h2>模板编辑器</h2><p>从实例读取画面，标记识别区域，保存到当前游戏的本地模板集。</p></div>
        <button className="btn" type="button" onClick={() => { setBusy('load'); void refresh().catch((cause) => setError(errMsg(cause))).finally(() => setBusy(null)); }} disabled={busy !== null}><Icon name="refresh" />刷新</button>
      </header>

      {scriptInsert && <div className="template-script-flow" role="status"><div><strong>为脚本步骤截取模板</strong><span>{scriptInsert.createStep ? '保存后会自动生成一块脚本步骤。' : '保存后会自动填入原脚本步骤。'}截图与模板保存在当前本地模板集中。</span></div><button className="btn xs" type="button" onClick={onCancelScriptInsert}>返回脚本</button></div>}
      {scriptInsert?.expectedTemplateSetId && activeSet && activeSet.id !== scriptInsert.expectedTemplateSetId && <p className="template-panel-error" role="alert">当前模板集是 {activeSet.name}，脚本需要 {scriptInsert.expectedTemplateSetId}。请先切换到脚本模板集，或返回脚本修改绑定。</p>}

      {error && <div className="template-panel-error" role="alert"><Icon name="alert" />{error}</div>}
      {index === null && <div className="template-panel-empty"><Icon name="devices" size={22} /><strong>先选择一个实例</strong><span>模板集、截图与测试都跟随当前游戏和实例。</span></div>}

      {index !== null && <>
        <div className="template-library-bar">
          <div className="template-library-current"><span>当前模板集</span><strong>{activeSet?.name ?? '尚未选择'}</strong><small title={activeSet?.directory}>{activeSet ? `${activeSet.refWidth} × ${activeSet.refHeight} · ${activeSet.templates.length} 张模板` : '先新建或载入本地模板集'}</small></div>
          <label className="template-library-select"><span>切换模板集</span><select value={activeSet?.directory ?? ''} onChange={(event) => void selectSet(event.target.value)} disabled={busy !== null || sets.length === 0}><option value="" disabled>选择模板集</option>{activeSet && !sets.some((item) => item.directory === activeSet.directory) && <option value={activeSet.directory}>{activeSet.name}（本地）</option>}{sets.map((item) => <option key={item.id} value={item.directory}>{item.name}</option>)}</select></label>
          <button className="btn" type="button" onClick={() => void importSet()} disabled={busy !== null}><Icon name="folder" />载入文件夹</button>
        </div>

        <div className="template-create-set"><label><span>新建模板集</span><input type="text" value={newSetName} onChange={(event) => setNewSetName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createSet(); }} placeholder="例如：万龙觉醒 1440p" maxLength={100} disabled={busy !== null} /></label><button className="btn" type="button" onClick={() => void createSet()} disabled={busy !== null || !newSetName.trim()}>{busy === 'create' ? <Spinner size={14} /> : <Icon name="plus" />}创建并使用</button></div>

        {activeSet && <div className="template-workspace">
          <aside className="template-library-list" aria-label="当前模板集中的模板">
            <div className="template-library-list-head"><strong>模板列表</strong><span>{activeSet.templates.length}</span></div>
            <button className={`template-list-item ${!selectedId ? 'is-selected' : ''}`} type="button" onClick={newTemplate} disabled={busy !== null}><Icon name="plus" /><span>新建模板</span></button>
            {activeSet.templates.map((item) => <button className={`template-list-item ${selectedId === item.id ? 'is-selected' : ''}`} type="button" key={item.id} onClick={() => selectTemplate(item)} disabled={busy !== null}><Icon name="grid" /><span><strong>{item.name}</strong><small>{item.id}</small></span></button>)}
            {activeSet.templates.length === 0 && <p className="template-library-note">还没有模板。读取游戏画面并拖选第一个识别区域。</p>}
          </aside>

          <div className="template-editor">
            {usingProposal && matchingProposal && <div className="template-proposal" role="status"><Icon name="chip" /><div><strong>来自 AI 顾问的建议</strong><p>建议区域来自旧截图。请重新读取当前画面，检查裁剪框后手动确认保存。</p></div></div>}
            <div className="template-editor-head"><div><h3>{selected ? `编辑 ${selected.name}` : '新建模板'}</h3><p>{selected ? '保存前需要读取新画面，按原位置预填裁剪框供核对。' : '先读取画面，再拖选要识别的图像。'}</p></div><button className="btn primary" type="button" onClick={() => void captureFrame()} disabled={busy !== null}>{busy === 'capture' ? <Spinner size={14} /> : <Icon name="camera" />}{frame ? '重新截图' : '读取当前画面'}</button></div>

            <div className="template-canvas-area">
              <div className="template-canvas-toolbar"><div className="template-mode" role="group" aria-label="框选模式"><button type="button" className={drawMode === 'crop' ? 'is-active' : ''} onClick={() => setDrawMode('crop')} disabled={!frame || busy !== null}>裁剪模板</button><button type="button" className={drawMode === 'roi' ? 'is-active' : ''} onClick={() => setDrawMode('roi')} disabled={!frame || busy !== null}>搜索区域</button></div><span>{frame ? `${frame.width} × ${frame.height} · ${timeLabel(frame.capturedAt)}` : '等待截图'}</span></div>
              {frame && frameUrl ? <div className={`template-frame-stage ${drawMode === 'roi' ? 'is-roi' : ''}`} onPointerDown={startDraw} onPointerMove={moveDraw} onPointerUp={endDraw} onPointerCancel={endDraw}><img src={frameUrl} alt={`实例 #${index} 当前游戏画面`} draggable={false} />{roi && <div className="template-frame-roi" style={rectStyle(roi, activeSet.refWidth, activeSet.refHeight)}><span>搜索区域</span></div>}{crop && <div className="template-frame-crop" style={rectStyle(crop, frame.width, frame.height)}><span>模板裁剪</span></div>}</div> : <div className="template-frame-placeholder"><Icon name="camera" size={28} /><strong>画面尚未读取</strong><span>截图只用于本地模板编辑，不会向游戏发送操作。</span></div>}
              <p className="template-canvas-hint">{drawMode === 'crop' ? '在画面上拖动以框选模板，也可在下方输入像素坐标。' : '在画面上拖动以限制匹配搜索范围；坐标使用模板集参考分辨率。'}</p>
            </div>

            <div className="template-editor-fields"><label className="template-field template-field-name"><span>模板名称</span><input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：世界地图按钮" maxLength={100} disabled={busy !== null} /></label><label className="template-field"><span>匹配阈值</span><input type="number" min={0} max={1} step={0.01} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} disabled={busy !== null} /></label></div>
            <div className="template-coordinate-group"><div><strong>模板裁剪</strong><span>截图像素坐标</span></div><div className="template-coordinate-inputs">{(['x', 'y', 'w', 'h'] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" min={key === 'w' || key === 'h' ? 3 : 0} value={crop?.[key] ?? ''} onChange={(event) => { const value = Number(event.target.value); setCrop((old) => ({ ...old ?? { x: 0, y: 0, w: 3, h: 3 }, [key]: value })); setAlpha(null); setProposalReviewed(false); }} disabled={!frame || busy !== null} /></label>)}</div></div>
            <div className="template-coordinate-group"><div><strong>搜索区域</strong><span>参考画布坐标，留空则自动扩展</span></div><div className="template-coordinate-inputs">{(['x', 'y', 'w', 'h'] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" min={key === 'w' || key === 'h' ? 3 : 0} value={roi?.[key] ?? ''} onChange={(event) => setRoi((old) => ({ ...old ?? { x: 0, y: 0, w: activeSet.refWidth, h: activeSet.refHeight }, [key]: Number(event.target.value) }))} disabled={busy !== null} /></label>)}<button className="btn xs" type="button" onClick={() => setRoi(null)} disabled={!roi || busy !== null}>自动</button></div></div>

            <details className="template-alpha-section"><summary>双帧差分去底 <span>适合动画背景上的固定按钮</span></summary><div className="template-alpha-content"><p>保持同一界面，等待背景变化后读取第二帧。稳定像素保留，变化像素透明。</p><div className="template-alpha-actions"><button className="btn" type="button" onClick={() => void captureCompare()} disabled={!frame || !validCrop || busy !== null}>{busy === 'compare' ? <Spinner size={14} /> : <Icon name="camera" />}{compare ? '重取第二帧' : '读取第二帧'}</button><label><span>容差</span><input type="number" min={0} max={255} step={1} value={alphaTolerance} onChange={(event) => { setAlphaTolerance(Number(event.target.value)); setAlpha(null); }} disabled={busy !== null} /></label><button className="btn" type="button" onClick={() => void previewAlpha()} disabled={!compare || !validCrop || busy !== null || !Number.isInteger(alphaTolerance) || alphaTolerance < 0 || alphaTolerance > 255}><Icon name="search" />预览去底</button></div>{compare && <small>第二帧：{timeLabel(compare.capturedAt)} · {compare.width} × {compare.height}</small>}{alpha && alphaUrl && <div className="template-alpha-result"><img src={alphaUrl} alt="差分去底预览，品红色表示被忽略的像素" /><div><strong>保留 {(alpha.coverage * 100).toFixed(1)}% 像素</strong><span>保存模板时会应用此掩码。修改裁剪区域后需重新生成。</span><button className="btn xs" type="button" onClick={() => setAlpha(null)}>不用掩码</button></div></div>}</div></details>

            {usingProposal && matchingProposal && <label className="template-review-check"><input type="checkbox" checked={proposalReviewed} onChange={(event) => setProposalReviewed(event.target.checked)} disabled={!frame || !validCrop || frame.capturedAt <= matchingProposal.sourceCapturedAt || busy !== null} /><span>我已在新截图中核对裁剪区域，确认保存为本地模板</span></label>}
            {frame && !validCrop && <p className="template-validation" role="status">请在画面中框选至少 3 × 3 像素的有效裁剪区域。</p>}
            {!validRoi && <p className="template-validation" role="status">搜索区域超出 {activeSet.refWidth} × {activeSet.refHeight} 参考画布。</p>}
            <div className="template-editor-actions"><div>{selected && templateUrl && <div className="template-original"><img src={templateUrl} alt={`${selected.name} 已保存图像`} /><span>当前保存的图像</span></div>}</div><div className="template-editor-action-buttons">{selected && (deleteConfirm ? <><button className="btn" type="button" onClick={() => setDeleteConfirm(false)} disabled={busy !== null}>取消</button><button className="btn danger" type="button" onClick={() => void remove()} disabled={busy !== null}>{busy === 'delete' ? <Spinner size={14} /> : <Icon name="trash" />}确认删除</button></> : <button className="btn danger-ghost" type="button" onClick={() => setDeleteConfirm(true)} disabled={busy !== null}><Icon name="trash" />删除模板</button>)}<button className="btn primary" type="button" onClick={() => void save()} disabled={!canSave}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}{selected ? '保存修改' : '保存模板'}</button></div></div>

            {selected && <section className="template-test"><div><h4>最新画面测试</h4><p>重新截图并运行一次本地匹配，结果不会触发任何点击。</p></div><button className="btn" type="button" onClick={() => void test()} disabled={busy !== null}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="search" />}测试匹配</button></section>}
            {testResult && testUrl && <div className="template-test-result"><div className={`template-test-verdict ${testResult.match.found ? 'is-found' : ''}`}><Icon name={testResult.match.found ? 'check' : 'alert'} /><strong>{testResult.match.found ? '命中' : '未命中'}</strong><span>分数 {testResult.match.score.toFixed(3)} / 阈值 {testResult.match.threshold.toFixed(3)}</span></div><div className="template-test-frame"><img src={testUrl} alt="最新画面模板匹配结果" />{testResult.match.w > 0 && testResult.match.h > 0 && <div className={`template-test-box ${testResult.match.found ? 'is-found' : ''}`} style={rectStyle(testResult.match, activeSet.refWidth, activeSet.refHeight)} />}</div>{testResult.match.reason && <p>{testResult.match.reason}</p>}</div>}
          </div>
        </div>}
      </>}
    </section>
  );
}
