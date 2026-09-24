/**
 * 脚本: the script library and editor (wanlong-panel `views/ScriptsView.tsx`). Two editing modes, one piece of data.
 *
 *   可视化: the script as a column of block cards (`BlockEditor`). The most valuable path is 「从画面截取」: grab a
 *          frame, draw a box, and the template is saved while the 「点这张图 / 等它出现」 block lands in the script.
 *          No JSON knowledge needed.
 *   JSON:  the plain text area with validation. Composite conditions (and / or / not), bulk edits and pasting a
 *          whole section from elsewhere still go through it.
 *
 * ★ Single source of truth: the TEXT (the JSON string). Every visual change is serialised back into it, so switching
 *   modes back and forth can never disagree or lose an edit (iron rule 1). Never keep a parsed copy on the side.
 *
 * Kept alive by the shell, so an unsaved draft survives page switches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TemplateSet } from '@avdm/automation';
import { SCRIPT_LIMITS, countBlocks, findPathById, getAt, isBuiltinScriptId, type ScriptDef, type ScriptIssue, type ScriptMeta } from '@avdm/automation/script';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useActivity } from '../../state/activity';
import { useNavigation } from '../../state/navigation';
import { usePlanImport } from '../../state/plan-import';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import { importLegacyScripts, withImportedScripts } from '../automation/plan-legacy-import';
import type { ViewProps } from '../types';
import { BlockEditor } from './BlockEditor';
import { CaptureBlockModal, type CaptureSaved } from './CaptureBlockModal';
import { NumberInput, Segmented } from './fields';
import { VisualGuard } from './VisualGuard';
import {
  insertCapturedBlock, isUnreadableMeta, mergeTemplateSets, newScriptDef, overwriteClash, parseScriptObject, parseScriptText, prettyScript, readEditMode,
  saveGate, scriptListDetail, scriptToSave, stepIdRange, summarizeIssues, templatesOfSet, withSavedTemplate, writeEditMode,
  type CaptureRequest, type EditMode, type InsertTarget,
} from './script-editor';
import './ScriptsView.css';

const MODE_OPTIONS = [{ value: 'visual', label: '可视化' }, { value: 'json', label: 'JSON' }] as const;
/** Rough line height of the JSON text area, to scroll a located step into view. */
const JSON_LINE_PX = 18;

type Pending =
  | { kind: 'delete'; meta: ScriptMeta }
  | { kind: 'discard'; title: string; run: () => void }
  | { kind: 'createSet'; index: number; name: string };

export function ScriptsView({ visible }: ViewProps) {
  const { game } = useSelection();
  if (!game) return null;
  return <ScriptLibrary key={game.id} gameId={game.id} gameName={game.name} packageName={game.packageName} visible={visible} />;
}

function ScriptLibrary({ gameId, gameName, packageName, visible }: { gameId: string; gameName: string; packageName: string; visible: boolean }) {
  const toast = useToast();
  const { index } = useSelection();
  const { navigate } = useNavigation();
  const { refreshPlanRuns } = usePlanRuns();
  const { refreshSchedules } = useActivity();
  const flow = useTemplateFlow();
  const { legacy, updateLegacy } = usePlanImport();

  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [managedSets, setManagedSets] = useState<TemplateSet[]>([]);
  const [instanceSet, setInstanceSet] = useState<TemplateSet | null>(null);
  const [pinnedSets, setPinnedSets] = useState<TemplateSet[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [issues, setIssues] = useState<ScriptIssue[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [mode, setModeState] = useState<EditMode>(() => readEditMode(() => window.localStorage));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealSeq, setRevealSeq] = useState(0);
  const [capture, setCapture] = useState<CaptureRequest | null>(null);
  const [busy, setBusy] = useState<'validate' | 'save' | 'import' | 'run' | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const jsonArea = useRef<HTMLTextAreaElement>(null);
  const loadSeq = useRef(0);
  const autoLoaded = useRef(false);

  const parsed = useMemo(() => parseScriptText(text), [text]);
  const def = parsed.def;
  const dirty = text !== savedText;
  const sets = useMemo(() => mergeTemplateSets(managedSets, [instanceSet, ...pinnedSets]), [managedSets, instanceSet, pinnedSets]);
  const templates = useMemo(() => templatesOfSet(sets, def?.templateSetId), [sets, def?.templateSetId]);
  const builtin = def ? isBuiltinScriptId(def.id) : currentId !== null && isBuiltinScriptId(currentId);
  const summary = summarizeIssues(issues);

  const setMode = (next: EditMode): void => {
    setModeState(next);
    writeEditMode(() => window.localStorage, next);
  };
  /** Visual edits always go back into the text: the single source of truth. */
  const applyDef = useCallback((next: ScriptDef): void => { setText(prettyScript(next)); }, []);
  const editText = (next: string): void => { setText(next); setParseError(null); };

  const refreshList = useCallback(async (): Promise<ScriptMeta[]> => {
    try {
      const list = await avdm.scriptList(gameId);
      setScripts(list);
      setListError(null);
      return list;
    } catch (cause) {
      setListError(errMsg(cause));
      return [];
    }
  }, [gameId]);

  const refreshSets = useCallback(async (): Promise<void> => {
    try {
      const [managed, current] = await Promise.all([
        avdm.automationTemplateSets(gameId),
        index === null ? Promise.resolve(null) : avdm.automationTemplateSet(gameId, index).catch(() => null),
      ]);
      setManagedSets(managed);
      setInstanceSet(current);
    } catch (cause) {
      toast.error('读不出模板集列表', errMsg(cause));
    }
  }, [gameId, index, toast]);

  const loadScript = useCallback(async (id: string): Promise<void> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const loaded = await avdm.scriptGet(gameId, id);
      if (seq !== loadSeq.current) return;
      const next = prettyScript(loaded);
      setText(next); setSavedText(next); setCurrentId(id);
      setIssues(null); setParseError(null); setSelectedId(null);
    } catch (cause) {
      if (seq === loadSeq.current) toast.error('读不出这个脚本', errMsg(cause));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [gameId, toast]);

  // A kept-alive page refreshes whenever it is shown again.
  useEffect(() => {
    if (!visible) return;
    void refreshList();
    void refreshSets();
  }, [visible, refreshList, refreshSets]);
  useAvdmEvent('templates-changed', (change) => { if (change.gameId === gameId) void refreshSets(); });

  // First visit: open the first script, like the original.
  useEffect(() => {
    if (autoLoaded.current || currentId || text || scripts.length === 0) return;
    autoLoaded.current = true;
    const first = scripts.find((meta) => !isUnreadableMeta(meta));
    if (first) void loadScript(first.id);
  }, [scripts, currentId, text, loadScript]);

  /** Leaving an unsaved draft asks first. */
  const guarded = (title: string, run: () => void): void => {
    if (dirty && text.trim()) setPending({ kind: 'discard', title, run });
    else run();
  };

  const createNew = (): void => {
    const next = prettyScript(newScriptDef(packageName));
    loadSeq.current++;
    setLoading(false);
    setText(next); setSavedText(''); setCurrentId(null);
    setIssues(null); setParseError(null); setSelectedId(null);
  };

  async function validate(): Promise<void> {
    const object = parseScriptObject(text);
    if (!object.value) { setParseError(object.error); return; }
    setParseError(null);
    setBusy('validate');
    try {
      const list = await avdm.scriptValidate(gameId, object.value, index);
      setIssues(list);
      if (list.length === 0) toast.push({ kind: 'success', title: '校验通过，没有发现问题' });
    } catch (cause) {
      toast.error('校验失败', errMsg(cause));
    } finally { setBusy(null); }
  }

  async function save(): Promise<void> {
    const sentText = text;
    const object = parseScriptObject(sentText);
    if (!object.value) { setParseError(object.error); toast.error('JSON 读不出来，没有保存', object.error ?? undefined); return; }
    setParseError(null);
    setBusy('save');
    try {
      // Validate first: a structural problem is not written to disk (it would only blow up at run time).
      const listed = await avdm.scriptList(gameId);
      const taken = listed.map((meta) => meta.id);
      const { value, copiedFrom } = scriptToSave(object.value, taken);
      const clash = overwriteClash(value, currentId, listed);
      if (clash) { toast.error(clash); return; }
      const list = await avdm.scriptValidate(gameId, value, index);
      setIssues(list);
      const gate = saveGate(list);
      if (gate.refuse) { toast.error(gate.refuse); return; }
      const meta = await avdm.scriptSave(gameId, value);
      const stored = copiedFrom ? prettyScript(value) : sentText;
      if (copiedFrom) setText((current) => current === sentText ? stored : current);
      setSavedText(stored);
      setCurrentId(meta.id);
      toast.push({
        kind: gate.draftWarning ? 'warn' : 'success',
        title: `脚本「${meta.name}」已保存（${meta.stepCount} 步）`,
        detail: copiedFrom ? `内置示例不会被改动，已另存为「${meta.id}」。${gate.draftWarning ?? ''}` : gate.draftWarning ?? undefined,
      });
      await refreshList();
    } catch (cause) {
      toast.error('保存失败', errMsg(cause));
    } finally { setBusy(null); }
  }

  function format(): void {
    const object = parseScriptObject(text);
    if (!object.value) { setParseError(object.error); return; }
    setParseError(null);
    setText(prettyScript(object.value));
  }

  async function remove(meta: ScriptMeta): Promise<void> {
    try {
      await avdm.scriptDelete(gameId, meta.id);
    } catch (cause) {
      toast.error('删除失败', errMsg(cause));
      throw cause;
    }
    toast.push({ kind: 'success', title: `脚本「${meta.name}」已删除` });
    if (currentId === meta.id) {
      loadSeq.current++;
      setLoading(false);
      setCurrentId(null); setText(''); setSavedText(''); setIssues(null); setSelectedId(null);
    }
    await refreshList();
  }

  async function importFiles(files: File[]): Promise<void> {
    if (!files.length || busy) return;
    setBusy('import');
    try {
      // Fresh ids: an import never overwrites a script, even one saved a moment ago on another page.
      const existing = (await avdm.scriptList(gameId)).map((meta) => meta.id);
      const { mapping, message } = await importLegacyScripts(avdm, gameId, packageName, files, existing);
      updateLegacy((current) => withImportedScripts(current, mapping, message));
      toast.push({ kind: 'success', title: '旧脚本已导入', detail: message });
      await refreshList();
    } catch (cause) {
      toast.error('导入旧脚本失败', errMsg(cause));
    } finally { setBusy(null); }
  }

  async function tryRun(): Promise<void> {
    if (!currentId || busy) return;
    if (index === null) { toast.push({ kind: 'warn', title: '请先在顶部选择实例' }); return; }
    setBusy('run');
    try {
      await avdm.scriptRun(gameId, index, currentId);
      await refreshPlanRuns();
      navigate('runs');
    } catch (cause) {
      toast.error('试跑失败', errMsg(cause));
    } finally { setBusy(null); }
  }

  /** 「点问题定位」: select the step id in the JSON text, or open that card in the visual mode. */
  function locate(stepId: string | null): void {
    if (!stepId) return;
    if (mode === 'visual' && def) {
      if (!findPathById(def.steps, stepId)) { toast.push({ kind: 'warn', title: `在脚本里没找到步骤 id「${stepId}」` }); return; }
      setSelectedId(stepId);
      setRevealSeq((n) => n + 1);
      return;
    }
    const area = jsonArea.current;
    const range = stepIdRange(text, stepId);
    if (!range || !area) { toast.push({ kind: 'warn', title: `在脚本里没找到步骤 id「${stepId}」` }); return; }
    area.focus();
    area.setSelectionRange(range.start, range.end);
    area.scrollTop = Math.max(0, (range.line - 6) * JSON_LINE_PX);
  }

  // ── 从画面截取 ──
  const scriptSet = def?.templateSetId ? sets.find((set) => set.id === def.templateSetId) : undefined;
  const captureBlocked = !def ? null
    : !def.templateSetId ? '先给脚本选一个模板集'
      : !scriptSet ? '脚本绑定的模板集在本机找不到，先换一个模板集' : null;
  const openCapture = (target: InsertTarget): void => {
    if (!def?.templateSetId || captureBlocked) return;
    setCapture({ id: crypto.randomUUID(), scriptId: def.id, templateSetId: def.templateSetId, target });
  };

  function onCaptured(saved: CaptureSaved): void {
    const request = capture;
    setCapture(null);
    if (!request) return;
    setManagedSets((current) => withSavedTemplate(current, saved.templateSetId, saved.definition));
    setInstanceSet((current) => current ? withSavedTemplate([current], saved.templateSetId, saved.definition)[0]! : current);
    setPinnedSets((current) => withSavedTemplate(current, saved.templateSetId, saved.definition));
    // Same as a save in the template library: the gather page drops its probe, schedules show auto-resume off.
    flow.noteTemplateChanged(gameId, saved.index, saved.directory);
    void refreshSchedules();
    void refreshSets();
    const current = parseScriptText(textRef.current).def;
    const outcome = current ? insertCapturedBlock(current, request, saved) : null;
    if (!outcome) {
      toast.error('模板已保存，但没有插进脚本', '截取期间脚本或模板集变了（或实例换了模板集）。模板已经在模板集里，请在对应的块里手动选它。');
      return;
    }
    applyDef(outcome.def);
    const added = getAt(outcome.def.steps, outcome.path);
    if (added) { setSelectedId(added.id); setRevealSeq((n) => n + 1); }
    toast.push({
      kind: outcome.fellBack ? 'warn' : 'success',
      title: `已存为模板「${saved.definition.name}」并插入一块（标准差 ${saved.std.toFixed(1)}）`,
      detail: outcome.fellBack ? '原来要插的位置已经不在了，新块加在了最后。' : undefined,
    });
  }

  function adoptInstanceSet(set: TemplateSet): void {
    const current = parseScriptText(textRef.current).def;
    if (!current) return;
    setPinnedSets((pinned) => [...pinned.filter((item) => item.id !== set.id), set]);
    applyDef({ ...current, templateSetId: set.id });
    setCapture((request) => request && request.scriptId === current.id ? { ...request, templateSetId: set.id } : request);
  }

  async function createSet(targetIndex: number, name: string): Promise<void> {
    try {
      const set = await avdm.createAutomationTemplateSet(gameId, targetIndex, name);
      const current = parseScriptText(textRef.current).def;
      if (current) applyDef({ ...current, templateSetId: set.id });
      flow.noteTemplateChanged(gameId, targetIndex, set.directory);
      void refreshSchedules();
      await refreshSets();
      toast.push({ kind: 'success', title: `已建模板集「${set.name}」并挂到这个脚本上`, detail: `实例 #${targetIndex} 已切换到这个模板集。` });
    } catch (cause) {
      toast.error('没能新建模板集', errMsg(cause));
      throw cause;
    }
  }

  const blockCount = def ? countBlocks(def.steps) : 0;
  const shownParseError = parseError ?? (mode === 'json' ? parsed.error : null);

  return (
    <section className="scriptlib" aria-label="脚本">
      <header className="scriptlib-head">
        <div>
          <h2>脚本</h2>
          <p>脚本是纯数据，同一游戏的所有账号都能复用。可视化模式里点「从画面截取」，框一下按钮就能变成一块。</p>
        </div>
        <label className={`btn sm scriptlib-file${busy ? ' is-disabled' : ''}`} title="可多选旧面板 scripts 目录里的 JSON；导入后逐个校验，不会自动执行">
          {busy === 'import' ? <Spinner size={12} /> : <Icon name="download" size={14} />}导入旧脚本 JSON
          <input type="file" accept=".json,application/json" multiple disabled={busy !== null}
            onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void importFiles(files); }} />
        </label>
      </header>
      {legacy.message && <p className="scriptlib-note" role="status">{legacy.message}</p>}

      <div className="scriptlib-layout">
        <aside className="scriptlib-list" aria-label="脚本列表">
          <div className="scriptlib-list-head">
            <strong>脚本列表</strong>
            <span>
              <button type="button" className="btn xs" onClick={() => { void refreshList(); void refreshSets(); }}><Icon name="refresh" size={12} />刷新</button>
              <button type="button" className="btn xs primary" onClick={() => guarded('新建脚本前放弃未保存的修改？', createNew)}><Icon name="plus" size={12} />新建</button>
            </span>
          </div>
          {listError && <p className="scriptlib-error" role="alert">{listError}</p>}
          {scripts.length === 0 && !listError && <p className="scriptlib-empty">还没有脚本。点「新建」得到一个空脚本，然后往里加块。</p>}
          <ul>
            {scripts.map((meta) => (
              <li key={meta.id} className={currentId === meta.id ? 'is-current' : ''}>
                <button type="button" className="scriptlib-item" title={meta.description}
                  onClick={() => { if (meta.id !== currentId) guarded(`打开「${meta.name}」前放弃未保存的修改？`, () => void loadScript(meta.id)); }}>
                  <span className="scriptlib-item-name">
                    <span>{meta.name}</span>
                    <SemanticTag tone="neutral">v{meta.version}</SemanticTag>
                    {meta.builtin && <SemanticTag tone="info" title="内置脚本随包分发，不能删除">内置</SemanticTag>}
                    {meta.loop && <SemanticTag tone="accent">循环</SemanticTag>}
                  </span>
                  <small>{scriptListDetail(meta, sets)}</small>
                </button>
                {!meta.builtin && (
                  <button type="button" className="scriptlib-icon-btn" title={`删除脚本「${meta.name}」`} aria-label={`删除脚本「${meta.name}」`}
                    onClick={() => setPending({ kind: 'delete', meta })}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>

        <div className="scriptlib-editor">
          <div className="scriptlib-bar">
            <div className="scriptlib-bar-left">
              <Segmented label="编辑模式" value={mode} options={MODE_OPTIONS} onChange={setMode} />
              {mode === 'visual' && def && <span className="scriptlib-count">共 {blockCount} 块</span>}
              {def && blockCount > SCRIPT_LIMITS.maxSteps && <SemanticTag tone="danger">超过 {SCRIPT_LIMITS.maxSteps} 块上限</SemanticTag>}
              {text && dirty && <SemanticTag tone="warning">未保存</SemanticTag>}
              {issues && summary.errors === 0 && summary.warnings === 0 && <SemanticTag tone="success">校验通过</SemanticTag>}
              {summary.errors > 0 && <SemanticTag tone="danger">{summary.errors} 个错误</SemanticTag>}
              {summary.warnings > 0 && <SemanticTag tone="warning">{summary.warnings} 个提醒</SemanticTag>}
              {loading && <span className="scriptlib-count"><Spinner size={12} /> 正在读取脚本…</span>}
            </div>
            <div className="scriptlib-bar-right">
              <button type="button" className="btn sm" onClick={() => void validate()} disabled={!text || busy !== null}>
                {busy === 'validate' ? <Spinner size={12} /> : <Icon name="check" size={14} />}校验
              </button>
              {mode === 'json' && <button type="button" className="btn sm" onClick={format} disabled={!text}>格式化</button>}
              <button type="button" className="btn sm primary" onClick={() => void save()} disabled={!text || busy !== null}
                title={builtin ? '内置示例只读：保存时另存为一份副本' : undefined}>
                {busy === 'save' && <Spinner size={12} />}{builtin ? '另存为副本' : '保存'}
              </button>
              {currentId && (
                <button type="button" className="btn sm" onClick={() => void tryRun()} disabled={busy !== null || index === null || !currentId}
                  title={index === null ? '请先在顶部选择实例' : dirty ? '有未保存的修改：试跑的是已保存的版本' : '在当前实例上运行已保存的版本，并打开执行监控'}>
                  {busy === 'run' ? <Spinner size={12} /> : <Icon name="play" size={12} />}在当前实例试跑
                </button>
              )}
            </div>
          </div>

          {builtin && (
            <p className="scriptlib-banner is-info" role="note">
              内置示例（只读）：可以在这里改着试，保存时会另存为一份副本，原示例不会被改动。
            </p>
          )}
          {shownParseError && <p className="scriptlib-banner is-error" role="alert">{shownParseError}</p>}

          {!text ? (
            <div className="scriptlib-placeholder">左边选一个脚本，或点「新建」开始写</div>
          ) : mode === 'json' ? (
            <textarea ref={jsonArea} className="scriptlib-json" aria-label="脚本 JSON" spellCheck={false} value={text}
              onChange={(event) => editText(event.target.value)} />
          ) : def ? (
            <VisualGuard resetKey={text}>
              <ScriptHeaderFields
                def={def} sets={sets} instanceSet={instanceSet} index={index} gamePackage={packageName} onChange={applyDef}
                onCreateSet={() => { if (index !== null) setPending({ kind: 'createSet', index, name: `${def.name || '未命名脚本'} 的模板` }); }}
              />
              <BlockEditor
                script={def} templates={templates} gamePackage={packageName} appLabel={gameName}
                selectedId={selectedId} onSelect={setSelectedId} revealSeq={revealSeq}
                onChange={(steps) => applyDef({ ...def, steps })} onCapture={openCapture} captureBlocked={captureBlocked}
              />
            </VisualGuard>
          ) : (
            <div className="scriptlib-banner is-warning" role="alert">
              <strong>这份脚本的 JSON 现在读不出来，可视化模式帮不上忙</strong>
              <span>{parsed.error} —— 先切到 JSON 模式把语法修好，再回来。</span>
            </div>
          )}

          {issues && issues.length > 0 && (
            <div className="scriptlib-issues" role="status" aria-label="校验结果">
              <strong>校验结果</strong>
              <ul>
                {issues.map((issue, i) => (
                  <li key={i}>
                    <button type="button" disabled={!issue.stepId} onClick={() => locate(issue.stepId)}>
                      <SemanticTag tone={issue.level === 'error' ? 'danger' : 'warning'}>{issue.level === 'error' ? (issue.fatal ? '必须修复' : '错误') : '提醒'}</SemanticTag>
                      {issue.stepId && <code>{issue.stepId}</code>}
                      <span>{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <span className="scriptlib-hint">点一条问题可以跳到脚本里对应的步骤。「必须修复」的问题不改好就存不了；其余错误可以先存成草稿，但运行前必须改好。</span>
            </div>
          )}

          {mode === 'json' && text && (
            <div className="scriptlib-banner is-info" role="note">
              <strong>脚本坐标一律写在参考分辨率空间</strong>
              <span>所有 x/y/w/h（包括 tap 的 at、ROI、模板 bounds）都以脚本自身的 refWidth × refHeight 为准，执行器负责换算到实例真实像素。不要直接填设备像素。</span>
            </div>
          )}
        </div>
      </div>

      {capture && (
        <CaptureBlockModal
          gameId={gameId} request={capture} templateSetName={sets.find((set) => set.id === capture.templateSetId)?.name ?? capture.templateSetId}
          onClose={() => setCapture(null)} onSaved={onCaptured} onUseInstanceSet={adoptInstanceSet}
        />
      )}
      {pending?.kind === 'delete' && (
        <ConfirmDialog
          title={`删除脚本「${pending.meta.name}」？`} message="删除后无法恢复，正在跑这个脚本的执行不受影响。" confirmLabel="删除" danger
          onConfirm={() => remove(pending.meta)} onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'discard' && (
        <ConfirmDialog
          title={pending.title} message="当前脚本有还没保存的修改，继续的话这些修改会丢掉。" confirmLabel="放弃修改" danger
          onConfirm={() => pending.run()} onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'createSet' && (
        <ConfirmDialog
          title={`新建模板集「${pending.name}」？`} confirmLabel="新建并挂上"
          message={`会新建一个空模板集并挂到这个脚本上，同时把实例 #${pending.index} 切换到它（和在「模板库」里新建一样）：该实例的自动采集会先关掉，采集要用的模板也要放进新模板集。只想给脚本换个现成的模板集，直接在下拉里选即可。`}
          onConfirm={() => createSet(pending.index, pending.name)} onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}

/**
 * Script-level settings in the visual mode. Only what authors really change: name, template set, target app,
 * 跑完再来一轮. Version, reference size and parameters stay in the JSON mode.
 */
function ScriptHeaderFields({ def, sets, instanceSet, index, gamePackage, onChange, onCreateSet }: {
  def: ScriptDef;
  sets: readonly TemplateSet[];
  instanceSet: TemplateSet | null;
  index: number | null;
  gamePackage: string;
  onChange: (next: ScriptDef) => void;
  onCreateSet: () => void;
}) {
  const bound = def.templateSetId ? sets.find((set) => set.id === def.templateSetId) : undefined;
  const mismatch = Boolean(def.templateSetId && instanceSet && instanceSet.id !== def.templateSetId);
  return (
    <div className="scriptlib-header-fields">
      <label className="scriptlib-cell">
        <span>脚本名</span>
        <input type="text" aria-label="脚本名" maxLength={120} value={def.name} onChange={(event) => onChange({ ...def, name: event.target.value })} />
      </label>
      <div className="scriptlib-cell is-wide">
        <span>模板集（从画面截取的模板存到这里）</span>
        <span className="scriptlib-inline">
          <select aria-label="模板集" value={def.templateSetId ?? ''} onChange={(event) => onChange({ ...def, templateSetId: event.target.value || undefined })}>
            <option value="">{sets.length === 0 ? '还没有模板集' : '（不绑定模板集）'}</option>
            {def.templateSetId && !bound && <option value={def.templateSetId}>{def.templateSetId} · 本机找不到</option>}
            {sets.map((set) => (
              <option key={set.id} value={set.id}>{set.name}（{set.templates.length} 张）{instanceSet?.id === set.id ? ` · 实例 #${index} 在用` : ''}</option>
            ))}
          </select>
          <button type="button" className="btn sm" onClick={onCreateSet} disabled={index === null} aria-label="就地新建模板集"
            title={index === null ? '先在顶部选择实例（新模板集会挂到那个实例上）' : `就地建一个空模板集并挂到这个脚本上（实例 #${index} 会切换到它）`}>
            <Icon name="plus" size={14} />
          </button>
        </span>
      </div>
      <div className="scriptlib-cell">
        <span>目标应用</span>
        <span className="scriptlib-readonly" title="助手只操作当前游戏，保存时包名固定为游戏包名">{gamePackage}</span>
      </div>
      <div className="scriptlib-cell">
        <span>跑完再来一轮</span>
        <span className="scriptlib-inline">
          <label className="check small">
            <input type="checkbox" checked={def.loop === true}
              onChange={(event) => onChange(event.target.checked
                ? { ...def, loop: true, loopIntervalMs: Math.max(SCRIPT_LIMITS.minLoopIntervalMs, def.loopIntervalMs ?? 3000) }
                : { ...def, loop: undefined })} />
            循环
          </label>
          {def.loop && (
            <NumberInput label="每轮间隔" suffix="ms 间隔" width={150} min={SCRIPT_LIMITS.minLoopIntervalMs} max={SCRIPT_LIMITS.maxLoopIntervalMs} step={1000}
              value={def.loopIntervalMs} empty={SCRIPT_LIMITS.minLoopIntervalMs} onChange={(loopIntervalMs) => onChange({ ...def, loopIntervalMs })} />
          )}
        </span>
      </div>
      <p className={`scriptlib-context${mismatch ? ' is-warning' : ''}`}>
        {mismatch && instanceSet
          ? `实例 #${index} 正在用模板集「${instanceSet.name}」，与脚本的「${bound?.name ?? def.templateSetId}」不一致：在这台实例上运行会被拒绝；截取模板时要选正在用「${bound?.name ?? def.templateSetId}」的实例。`
          : !def.templateSetId
            ? '没绑模板集时，运行时用实例当前的模板集；要从画面截取，先选一个模板集。'
            : `运行时实例用的模板集必须就是「${bound?.name ?? def.templateSetId}」。循环脚本在计划里受「最长运行」限制，每轮间隔至少 1 秒。`}
      </p>
    </div>
  );
}
