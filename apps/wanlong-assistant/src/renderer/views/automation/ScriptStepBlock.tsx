import { useEffect, useState, type ReactNode } from 'react';
import type { TemplateDefinition } from '@avdm/automation';
import type { ScriptStep } from '../../../main/plans/types';

const labels: Record<ScriptStep['kind'], string> = {
  tap: '点击坐标', tapTemplate: '识别并点击', waitFor: '等待画面', swipe: '滑动', longPress: '长按',
  key: '按键', text: '输入文本', sleep: '等待', launchApp: '启动游戏', stopApp: '停止游戏',
  screenshot: '截图', log: '记录日志', label: '标签', goto: '跳转', if: '条件', loop: '循环',
};
const keyOptions = ['BACK', 'HOME', 'ENTER', 'MENU', 'APP_SWITCH', 'DEL', 'ESCAPE', 'VOLUME_UP', 'VOLUME_DOWN'] as const;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const point = (value: unknown): boolean => object(value) && typeof value.x === 'number' && typeof value.y === 'number';
function renderableStep(value: unknown, current: ScriptStep): value is ScriptStep {
  if (!object(value) || value.id !== current.id || value.kind !== current.kind) return false;
  switch (value.kind) {
    case 'tap': case 'longPress': return point(value.at);
    case 'tapTemplate': return typeof value.templateId === 'string';
    case 'waitFor': return object(value.cond) && typeof value.cond.kind === 'string';
    case 'swipe': return point(value.from) && point(value.to);
    case 'key': return typeof value.key === 'string';
    case 'text': return typeof value.text === 'string';
    case 'sleep': return typeof value.ms === 'number';
    case 'screenshot': return value.label === undefined || typeof value.label === 'string';
    case 'log': return typeof value.message === 'string';
    case 'label': case 'goto': return typeof value.label === 'string';
    default: return true;
  }
}
function NumberField({ label, value, onChange, min, max, step }: {
  label: string; value: number | undefined; onChange(value: number | undefined): void;
  min?: number; max?: number; step?: number;
}) {
  const [raw, setRaw] = useState(value === undefined ? '' : String(value));
  useEffect(() => setRaw(value === undefined ? '' : String(value)), [value]);
  return <label className="plan-block-field"><span>{label}</span><input type="number" value={raw} min={min} max={max} step={step} onChange={(event) => {
    const next = event.target.value;
    setRaw(next);
    if (next === '') onChange(undefined);
    else if (Number.isFinite(Number(next))) onChange(Number(next));
  }} /></label>;
}

function StepJsonEditor({ step, onChange, onValidity }: {
  step: ScriptStep; onChange(next: ScriptStep): void; onValidity(valid: boolean): void;
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(step, null, 2));
  const [invalid, setInvalid] = useState(false);
  return <textarea aria-label={`步骤 ${step.id} JSON`} className={`plan-block-json ${invalid ? 'is-invalid' : ''}`} value={raw} onChange={(event) => {
    const text = event.target.value;
    setRaw(text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (!renderableStep(parsed, step)) throw new Error('步骤类型或基础字段无效');
      onChange(parsed); setInvalid(false); onValidity(true);
    }
    catch { setInvalid(true); onValidity(false); }
  }} spellCheck={false} />;
}

function isVisualStep(step: ScriptStep): boolean {
  return step.kind !== 'if' && step.kind !== 'loop' && step.kind !== 'goto' && step.kind !== 'label' &&
    !(step.kind === 'waitFor' && step.cond.kind !== 'template');
}

function summary(step: ScriptStep, templates: TemplateDefinition[]): string {
  const templateName = (id: string): string => templates.find((item) => item.id === id)?.name ?? (id || '未选模板');
  switch (step.kind) {
    case 'tap': return `点击 (${step.at.x}, ${step.at.y})`;
    case 'tapTemplate': return `找到「${templateName(step.templateId)}」后点击，最多等 ${(step.waitMs ?? 0) / 1000} 秒`;
    case 'waitFor': return step.cond.kind === 'template'
      ? `等待「${templateName(step.cond.templateId)}」${step.cond.present === false ? '消失' : '出现'}，最多等 ${step.waitMs / 1000} 秒`
      : '等待组合条件成立';
    case 'swipe': return `从 (${step.from.x}, ${step.from.y}) 滑到 (${step.to.x}, ${step.to.y})`;
    case 'longPress': return `长按 (${step.at.x}, ${step.at.y}) ${step.durationMs / 1000} 秒`;
    case 'key': return `按 ${step.key}`;
    case 'text': return step.text ? `输入「${step.text.slice(0, 24)}${step.text.length > 24 ? '…' : ''}」` : '输入文本';
    case 'sleep': return `等待 ${step.ms / 1000} 秒`;
    case 'launchApp': return step.cold ? '冷启动目标游戏' : '启动目标游戏';
    case 'stopApp': return '停止目标游戏';
    case 'screenshot': return `保存画面${step.label ? ` · ${step.label}` : ''}`;
    case 'log': return step.message || '记录日志';
    case 'label': return `标签 ${step.label}`;
    case 'goto': return `跳转到 ${step.label}`;
    case 'if': return '按条件执行分支 · 使用 JSON 编辑';
    case 'loop': return '循环执行步骤 · 使用 JSON 编辑';
  }
}

export interface ScriptStepBlockProps {
  step: ScriptStep;
  ordinal: number;
  total: number;
  templates: TemplateDefinition[];
  canCreateTemplate: boolean;
  templateSetMismatch: boolean;
  onChange(next: ScriptStep): void;
  onValidity(valid: boolean): void;
  onCreateTemplate(): void;
  onMove(delta: -1 | 1): void;
  onDuplicate(): void;
  onDelete(): void;
}

export function ScriptStepBlock({ step, ordinal, total, templates, canCreateTemplate, templateSetMismatch,
  onChange, onValidity, onCreateTemplate, onMove, onDuplicate, onDelete }: ScriptStepBlockProps) {
  const visual = isVisualStep(step);
  const [open, setOpen] = useState(true);
  const [advanced, setAdvanced] = useState(!visual);
  const [jsonValid, setJsonValid] = useState(true);
  const isTemplateStep = step.kind === 'tapTemplate' || (step.kind === 'waitFor' && step.cond.kind === 'template');
  const selectedTemplateId = step.kind === 'tapTemplate' ? step.templateId : step.kind === 'waitFor' && step.cond.kind === 'template' ? step.cond.templateId : '';
  const missingTemplate = Boolean(isTemplateStep && selectedTemplateId && !templates.some((item) => item.id === selectedTemplateId));
  const updateTemplate = (templateId: string): void => {
    if (step.kind === 'tapTemplate') onChange({ ...step, templateId });
    else if (step.kind === 'waitFor' && step.cond.kind === 'template') onChange({ ...step, cond: { ...step.cond, templateId } });
  };
  const templateField = <div className="plan-block-template">
    <label className="plan-block-field"><span>识别模板</span><select value={selectedTemplateId} onChange={(event) => updateTemplate(event.target.value)} disabled={templateSetMismatch}>
      <option value="">选择模板</option>
      {missingTemplate && <option value={selectedTemplateId}>未在当前模板集中找到 · {selectedTemplateId}</option>}
      {templates.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
    </select></label>
    <button className="btn xs" type="button" onClick={onCreateTemplate} disabled={!canCreateTemplate || templateSetMismatch}>从画面截取</button>
  </div>;

  let fields: ReactNode;
  switch (step.kind) {
    case 'tap': fields = <div className="plan-block-grid"><NumberField label="X 坐标" value={step.at.x} min={0} onChange={(x) => onChange({ ...step, at: { ...step.at, x: x ?? 0 } })} /><NumberField label="Y 坐标" value={step.at.y} min={0} onChange={(y) => onChange({ ...step, at: { ...step.at, y: y ?? 0 } })} /></div>; break;
    case 'tapTemplate': fields = <>{templateField}<div className="plan-block-grid"><NumberField label="最多等待（毫秒）" value={step.waitMs} min={0} onChange={(waitMs) => onChange({ ...step, waitMs })} /><NumberField label="匹配阈值（可选）" value={step.threshold} min={0} max={1} step={0.01} onChange={(threshold) => onChange({ ...step, threshold })} /><NumberField label="点击偏移 X" value={step.offset?.x} onChange={(x) => onChange({ ...step, offset: { x: x ?? 0, y: step.offset?.y ?? 0 } })} /><NumberField label="点击偏移 Y" value={step.offset?.y} onChange={(y) => onChange({ ...step, offset: { x: step.offset?.x ?? 0, y: y ?? 0 } })} /></div></>; break;
    case 'waitFor': {
      const cond = step.cond;
      fields = cond.kind === 'template' ? <>{templateField}<div className="plan-block-grid"><label className="plan-block-field"><span>等待结果</span><select value={cond.present === false ? 'absent' : 'present'} onChange={(event) => onChange({ ...step, cond: { ...cond, present: event.target.value !== 'absent' } })}><option value="present">出现</option><option value="absent">消失</option></select></label><NumberField label="最多等待（毫秒）" value={step.waitMs} min={0} onChange={(waitMs) => onChange({ ...step, waitMs: waitMs ?? 0 })} /><NumberField label="轮询间隔（毫秒）" value={step.pollMs} min={50} onChange={(pollMs) => onChange({ ...step, pollMs })} /><NumberField label="匹配阈值（可选）" value={cond.threshold} min={0} max={1} step={0.01} onChange={(threshold) => onChange({ ...step, cond: { ...cond, threshold } })} /></div></> : null;
      break;
    }
    case 'swipe': fields = <div className="plan-block-grid"><NumberField label="起点 X" value={step.from.x} min={0} onChange={(x) => onChange({ ...step, from: { ...step.from, x: x ?? 0 } })} /><NumberField label="起点 Y" value={step.from.y} min={0} onChange={(y) => onChange({ ...step, from: { ...step.from, y: y ?? 0 } })} /><NumberField label="终点 X" value={step.to.x} min={0} onChange={(x) => onChange({ ...step, to: { ...step.to, x: x ?? 0 } })} /><NumberField label="终点 Y" value={step.to.y} min={0} onChange={(y) => onChange({ ...step, to: { ...step.to, y: y ?? 0 } })} /><NumberField label="持续（毫秒）" value={step.durationMs} min={1} onChange={(durationMs) => onChange({ ...step, durationMs })} /></div>; break;
    case 'longPress': fields = <div className="plan-block-grid"><NumberField label="X 坐标" value={step.at.x} min={0} onChange={(x) => onChange({ ...step, at: { ...step.at, x: x ?? 0 } })} /><NumberField label="Y 坐标" value={step.at.y} min={0} onChange={(y) => onChange({ ...step, at: { ...step.at, y: y ?? 0 } })} /><NumberField label="持续（毫秒）" value={step.durationMs} min={1} onChange={(durationMs) => onChange({ ...step, durationMs: durationMs ?? 1 })} /></div>; break;
    case 'key': fields = <label className="plan-block-field"><span>按键</span><select value={step.key} onChange={(event) => onChange({ ...step, key: event.target.value as typeof step.key })}>{keyOptions.map((key) => <option key={key}>{key}</option>)}</select></label>; break;
    case 'text': fields = <label className="plan-block-field"><span>输入文本（ADB 支持的字符）</span><input value={step.text} onChange={(event) => onChange({ ...step, text: event.target.value })} /></label>; break;
    case 'sleep': fields = <NumberField label="等待（毫秒）" value={step.ms} min={0} onChange={(ms) => onChange({ ...step, ms: ms ?? 0 })} />; break;
    case 'launchApp': fields = <label className="plan-block-check"><input type="checkbox" checked={step.cold ?? false} onChange={(event) => onChange({ ...step, cold: event.target.checked })} /><span>冷启动（先结束应用进程）</span></label>; break;
    case 'stopApp': fields = <p className="plan-block-hint">结束脚本绑定的目标游戏。</p>; break;
    case 'screenshot': fields = <label className="plan-block-field"><span>截图标签</span><input value={step.label ?? ''} onChange={(event) => onChange({ ...step, label: event.target.value || undefined })} /></label>; break;
    case 'log': fields = <div className="plan-block-grid"><label className="plan-block-field"><span>级别</span><select value={step.level} onChange={(event) => onChange({ ...step, level: event.target.value as typeof step.level })}><option value="debug">调试</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select></label><label className="plan-block-field plan-block-wide"><span>日志内容</span><input value={step.message} onChange={(event) => onChange({ ...step, message: event.target.value })} /></label></div>; break;
    default: fields = null;
  }

  return <article className="plan-step">
    <div className="plan-step-head"><span>{String(ordinal).padStart(2, '0')}</span><strong>{labels[step.kind]}</strong><small>{summary(step, templates)}</small><div className="plan-step-controls"><button type="button" aria-label={`步骤 ${ordinal} ${open ? '收起' : '展开'}`} onClick={() => setOpen(!open)}>{open ? '收起' : '展开'}</button><button type="button" aria-label={`步骤 ${ordinal} 上移`} disabled={ordinal === 1} onClick={() => onMove(-1)}>↑</button><button type="button" aria-label={`步骤 ${ordinal} 下移`} disabled={ordinal === total} onClick={() => onMove(1)}>↓</button><button type="button" aria-label={`复制步骤 ${ordinal}`} onClick={onDuplicate}>复制</button><button type="button" aria-label={`删除步骤 ${ordinal}`} onClick={onDelete}>删除</button></div></div>
    {open && <div className="plan-step-body">
      {!advanced && <label className="plan-block-field"><span>步骤名称（可选）</span><input value={step.name ?? ''} onChange={(event) => onChange({ ...step, name: event.target.value || undefined })} /></label>}
      {templateSetMismatch && isTemplateStep && <p className="plan-block-warning">脚本模板集与当前实例使用的模板集不同。请先在模板页切换到脚本所需模板集。</p>}
      {missingTemplate && !templateSetMismatch && <p className="plan-block-warning">这个模板不在当前模板集中；请重新选择或截取。</p>}
      {!advanced && visual && fields}
      {visual && <button className="plan-block-mode" type="button" disabled={advanced && !jsonValid} onClick={() => setAdvanced(!advanced)}>{advanced ? '返回表单' : '高级步骤 JSON'}</button>}
      {advanced && <StepJsonEditor step={step} onChange={onChange} onValidity={(valid) => { setJsonValid(valid); onValidity(valid); }} />}
      {!advanced && <details className="plan-block-more"><summary>执行选项</summary><div className="plan-block-grid"><NumberField label="步骤超时（毫秒）" value={step.timeoutMs} min={1} onChange={(timeoutMs) => onChange({ ...step, timeoutMs })} /><NumberField label="失败重试次数" value={step.retry} min={0} max={10} onChange={(retry) => onChange({ ...step, retry })} /><NumberField label="重试间隔（毫秒）" value={step.retryDelayMs} min={0} onChange={(retryDelayMs) => onChange({ ...step, retryDelayMs })} /><NumberField label="结束后等待（毫秒）" value={step.afterDelayMs} min={0} onChange={(afterDelayMs) => onChange({ ...step, afterDelayMs })} /><label className="plan-block-field"><span>失败时</span><select value={step.onFail?.kind ?? 'abort'} onChange={(event) => onChange({ ...step, onFail: event.target.value === 'goto' ? { kind: 'goto', label: step.onFail?.kind === 'goto' ? step.onFail.label : '' } : { kind: event.target.value as 'abort' | 'continue' | 'restartApp' } })}><option value="abort">停止脚本</option><option value="continue">跳过此步</option><option value="restartApp">重启游戏</option><option value="goto">跳转到标签</option></select></label>{step.onFail?.kind === 'goto' && <label className="plan-block-field"><span>标签名称</span><input value={step.onFail.label} onChange={(event) => onChange({ ...step, onFail: { kind: 'goto', label: event.target.value } })} /></label>}</div><label className="plan-block-check"><input type="checkbox" checked={step.capture ?? false} onChange={(event) => onChange({ ...step, capture: event.target.checked })} /><span>保存执行截图</span></label></details>}
    </div>}
  </article>;
}
