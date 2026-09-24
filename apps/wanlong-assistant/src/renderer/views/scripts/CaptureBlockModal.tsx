/**
 * 「从画面截取 → 直接变成一块」 (wanlong-panel `features/blocks/CaptureBlockModal.tsx`).
 *
 * One straight line: pick a running instance → grab a frame → DRAG A BOX on it → choose the block → name it →
 * save and insert. One click does two things: the template goes into the template library and the block into the
 * script — 「截图直接拖成功能块」.
 *
 * Split with the template library page: that page is the WAREHOUSE (thresholds, 透明底, 立即验证, delete); this is
 * the author's shortcut with only the most common path. Both save through the same `saveAutomationTemplate`.
 *
 * ★ Three pitfalls from the template page, kept as they are:
 *   1. The box is in the PNG's own pixels and is passed as the crop unchanged (the save contract wants that).
 *   2. No defaultRoi: the main process widens one around the template's position (up to 43× faster matching).
 *   3. A low-variance crop (flat colour, gradient) is refused by the main process; TEMPLATE_LOW_VARIANCE is turned
 *      into guidance (「换一块有图标或文字的区域」), never shown as an error code.
 *
 * The Assistant's rules on top: templates always go into the set the instance is using (that is also the set a
 * run uses), so saving is only offered when that set is the script's own; the result is checked again when it
 * comes back (stale-request protection, `insertCapturedBlock`).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Rect, TemplateDefinition, TemplateSet } from '@avdm/automation';
import type { TemplateCapture } from '../../../shared/ipc';
import { avdm, errMsg, errorCodeOf } from '../../api';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { canLaunchOnTarget, useSelection, useSelectionLock } from '../../state/selection';
import { lowVarianceGuidance, type LowVarianceGuidance } from '../templates/template-editor';
import { Segmented } from './fields';
import {
  CAPTURE_KINDS, MAX_CAPTURE_NAME, captureDraft, captureProblem, normRect,
  type CaptureKind, type CaptureRequest, type CapturedTemplate,
} from './script-editor';
import './CaptureBlockModal.css';

export interface CaptureSaved extends CapturedTemplate {
  definition: TemplateDefinition;
  std: number;
  /** Instance whose template set received the template, and that set's folder. */
  index: number;
  directory: string;
}

export interface CaptureBlockModalProps {
  gameId: string;
  request: CaptureRequest;
  /** The script's set name, for the texts. */
  templateSetName: string;
  onClose: () => void;
  /** The template is saved: insert the block (the page re-checks it against its current script). */
  onSaved: (saved: CaptureSaved) => void;
  /** Re-bind the script to the set the chosen instance is using. */
  onUseInstanceSet: (set: TemplateSet) => void;
}

function usePngUrl(bytes: Uint8Array | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) { setUrl(null); return; }
    const next = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    setUrl(next);
    // A 2560×1440 frame is megabytes: release it as soon as it is replaced or the dialog closes.
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}

function rectStyle(rect: Rect, width: number, height: number): CSSProperties {
  return { left: `${rect.x / width * 100}%`, top: `${rect.y / height * 100}%`, width: `${rect.w / width * 100}%`, height: `${rect.h / height * 100}%` };
}

export function CaptureBlockModal({ gameId, request, templateSetName, onClose, onSaved, onUseInstanceSet }: CaptureBlockModalProps) {
  const toast = useToast();
  const { targets, index: currentIndex } = useSelection();
  const running = useMemo(() => targets.filter((target) => canLaunchOnTarget(target.instance)), [targets]);
  const [instanceIndex, setInstanceIndex] = useState<number | null>(() =>
    running.some((target) => target.index === currentIndex) ? currentIndex : running[0]?.index ?? null);
  const [instanceSet, setInstanceSet] = useState<TemplateSet | null | undefined>(undefined);
  const [setLoadError, setSetLoadError] = useState<string | null>(null);
  const [frame, setFrame] = useState<TemplateCapture | null>(null);
  const [crop, setCrop] = useState<Rect | null>(null);
  const [kind, setKind] = useState<CaptureKind>('tapTemplate');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'capture' | 'save' | null>(null);
  const [error, setError] = useState<{ message: string; guidance: LowVarianceGuidance | null } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const captureSeq = useRef(0);
  const frameUrl = usePngUrl(frame?.png ?? null);
  useSelectionLock(busy === 'save' ? '正在保存截取的模板，完成后再切换实例' : null);

  // Pick a running instance once one shows up; forget a choice that stopped running.
  useEffect(() => {
    if (instanceIndex !== null && running.some((target) => target.index === instanceIndex)) return;
    setInstanceIndex(running[0]?.index ?? null);
  }, [running, instanceIndex]);

  // The chosen instance's template set: saving puts the template there.
  useEffect(() => {
    captureSeq.current++;
    setFrame(null); setCrop(null); setError(null); setInstanceSet(undefined); setSetLoadError(null);
    if (instanceIndex === null) return;
    let alive = true;
    void avdm.automationTemplateSet(gameId, instanceIndex)
      .then((set) => { if (alive) setInstanceSet(set); })
      .catch((cause) => { if (alive) { setInstanceSet(null); setSetLoadError(errMsg(cause)); } });
    return () => { alive = false; };
  }, [gameId, instanceIndex]);

  const setMismatch = instanceSet !== undefined && instanceSet?.id !== request.templateSetId;
  const problem = captureProblem({ hasSet: Boolean(request.templateSetId), frame, crop, name });

  async function capture(): Promise<void> {
    if (instanceIndex === null) { toast.push({ kind: 'warn', title: '请先选一个已开机的实例' }); return; }
    const seq = ++captureSeq.current;
    setBusy('capture'); setError(null);
    try {
      const next = await avdm.captureAutomationTemplate(gameId, instanceIndex);
      if (seq !== captureSeq.current) return; // the instance changed meanwhile: this frame belongs to another one
      setFrame(next); setCrop(null);
    } catch (cause) {
      if (seq === captureSeq.current) toast.error('抓不到画面', errMsg(cause));
    } finally { setBusy(null); }
  }

  async function save(): Promise<void> {
    if (busy) return;
    if (problem) { toast.push({ kind: 'warn', title: problem }); return; }
    if (instanceIndex === null || !frame || !crop || !instanceSet || setMismatch) return;
    const index = instanceIndex;
    const target = instanceSet;
    setBusy('save'); setError(null);
    try {
      const result = await avdm.saveAutomationTemplate(gameId, index, captureDraft(frame, crop, name));
      // Stale-request protection: the template went into whatever set the instance uses NOW; only when that is still
      // the script's set is the block inserted (the page checks the ids again).
      const templateSetId = result.directory === target.directory ? target.id : `（${result.directory}）`;
      onSaved({ templateId: result.definition.id, templateSetId, kind, definition: result.definition, std: result.std, index, directory: result.directory });
    } catch (cause) {
      setError({ message: errMsg(cause), guidance: lowVarianceGuidance(errorCodeOf(cause), errMsg(cause)) });
    } finally { setBusy(null); }
  }

  function pointer(event: PointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    if (!frame) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(frame.width, Math.max(0, (event.clientX - bounds.left) / bounds.width * frame.width)),
      y: Math.min(frame.height, Math.max(0, (event.clientY - bounds.top) / bounds.height * frame.height)),
    };
  }

  return (
    <Modal
      title="从画面截取一块"
      subtitle={`模板存进「${templateSetName}」，块插进脚本 —— 一次完成`}
      width={860}
      busy={busy === 'save'}
      onClose={onClose}
      className="capblk"
      footer={
        <>
          <span className="footer-left capblk-foot-hint">{busy === null && !setMismatch ? problem ?? '按回车也能保存' : ''}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy === 'save'}>取消</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={busy !== null || setMismatch || !instanceSet}>
            {busy === 'save' && <Spinner size={12} />}保存并插入
          </button>
        </>
      }
    >
      <div className="capblk-body">
        <div className="capblk-toolbar">
          <select aria-label="从哪个实例截取" value={instanceIndex ?? ''} disabled={busy !== null || running.length === 0}
            onChange={(event) => setInstanceIndex(Number(event.target.value))}>
            {running.length === 0 && <option value="">没有已开机的实例</option>}
            {running.map((target) => <option key={target.index} value={target.index}>#{target.index} · {target.instance?.record.name ?? `实例 ${target.index}`}</option>)}
          </select>
          <button type="button" className="btn primary sm" onClick={() => void capture()} disabled={busy !== null || instanceIndex === null}>
            {busy === 'capture' ? <Spinner size={12} /> : <Icon name="camera" size={14} />}抓一帧
          </button>
          <span className="capblk-hint">在画面上按住拖一个框，框住要认的图标或文字</span>
        </div>

        {setLoadError && <p className="capblk-alert is-error" role="alert">读不出实例 #{instanceIndex} 的模板集：{setLoadError}</p>}
        {instanceSet === null && !setLoadError && instanceIndex !== null && (
          <p className="capblk-alert is-warning" role="alert">实例 #{instanceIndex} 还没有模板集。先到「模板库」给它选或建一个模板集（脚本的是「{templateSetName}」）。</p>
        )}
        {instanceSet && setMismatch && (
          <div className="capblk-alert is-warning" role="alert">
            <span>实例 #{instanceIndex} 正在用模板集「{instanceSet.name}」，脚本的是「{templateSetName}」。截取的模板只能存进实例正在用的模板集（脚本运行时也用它），所以现在不能保存。</span>
            <span className="capblk-alert-actions">
              <button type="button" className="btn xs" onClick={() => onUseInstanceSet(instanceSet)}>把脚本改用「{instanceSet.name}」</button>
              <span>或到「模板库」把实例切到「{templateSetName}」。</span>
            </span>
          </div>
        )}

        {!frame ? (
          <div className="capblk-placeholder">
            <Icon name="camera" size={26} />
            <span>{running.length === 0 ? '先到「模拟器实例」页把实例开起来，并让游戏停在前台' : '点「抓一帧」把当前画面取过来（游戏要在前台）'}</span>
          </div>
        ) : (
          <div className="capblk-stage" onPointerDown={(event) => {
            if (busy !== null || event.button !== 0) return;
            const p = pointer(event);
            if (!p) return;
            dragStart.current = p;
            setCrop({ x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 });
            setError(null);
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }} onPointerMove={(event) => {
            if (!dragStart.current) return;
            const p = pointer(event);
            if (p) setCrop(normRect(dragStart.current, p));
          }} onPointerUp={(event) => {
            dragStart.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => { dragStart.current = null; }}>
            {frameUrl && <img src={frameUrl} alt={`实例 #${instanceIndex} 的游戏画面`} draggable={false} />}
            {crop && crop.w > 0 && crop.h > 0 && <div className="capblk-crop" style={rectStyle(crop, frame.width, frame.height)} />}
          </div>
        )}
        {frame && <span className="capblk-meta">{frame.width} × {frame.height} · {beijingTime(frame.capturedAt, 'clock')}</span>}

        <div className="capblk-form">
          <div className="capblk-cell">
            <strong>做成哪种块</strong>
            <Segmented label="做成哪种块" value={kind} options={CAPTURE_KINDS} onChange={setKind} disabled={busy === 'save'} />
          </div>
          <label className="capblk-cell">
            <strong>叫什么名字</strong>
            <input type="text" placeholder="例如：联盟按钮" value={name} maxLength={MAX_CAPTURE_NAME} disabled={busy === 'save'}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } }} />
          </label>
          {crop && crop.w > 0 && (
            <div className="capblk-cell">
              <strong>框住的区域</strong>
              <span className="capblk-hint">{crop.w} × {crop.h} 像素 @ ({crop.x}, {crop.y})</span>
            </div>
          )}
        </div>
        <p className="capblk-note">保存和在「模板库」里一样：这个实例的自动采集会先关掉（模板变了要重新探针）。</p>

        {error && (
          <div className="capblk-alert is-error" role="alert">
            <strong>{error.guidance ? '这块图案太单调，不能当模板' : '保存失败'}</strong>
            {error.guidance
              ? error.guidance.paragraphs.map((text) => <span key={text}>{text}</span>)
              : <span>{error.message}</span>}
          </div>
        )}
      </div>
    </Modal>
  );
}
