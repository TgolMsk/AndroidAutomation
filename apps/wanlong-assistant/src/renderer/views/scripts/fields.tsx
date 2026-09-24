import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TemplateDefinition } from '@avdm/automation';
import { COND_MODE_TEXT, condModeOf, describeCond, seedCondition, type CondMode, type Condition } from '@avdm/automation/script';
import { Icon } from '../../components/Icon';
import { groupTemplates, matchesTemplateQuery, pickableTemplates } from '../templates/template-groups';

/** A labelled form cell: small caption, the control(s), an optional one-line hint (the original `Field`). */
export function Field({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`blk-field${wide ? ' is-wide' : ''}`}>
      <span className="blk-field-label">{label}</span>
      {children}
      {hint && <span className="blk-field-hint">{hint}</span>}
    </div>
  );
}

/**
 * A number input that keeps what is being typed (「1.」, an empty box) until it is a number. An empty box reports
 * `empty` (undefined = 「留空」, or a fallback such as 0 like the original InputNumber's `v ?? 0`).
 */
export function NumberInput({ value, onChange, min, max, step, placeholder, empty, prefix, suffix, width = 120, label, disabled }: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  empty?: number;
  prefix?: string;
  suffix?: string;
  width?: number;
  /** Accessible name of the input. */
  label: string;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setRaw((current) => current !== '' && Number(current) === value ? current : value === undefined ? '' : String(value));
  }, [value]);
  return (
    <span className="blk-num" style={{ width }}>
      {prefix && <span className="blk-num-affix">{prefix}</span>}
      <input
        type="number" aria-label={label} value={raw} min={min} max={max} step={step} placeholder={placeholder} disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          if (next.trim() === '') onChange(empty);
          else if (Number.isFinite(Number(next))) onChange(Number(next));
        }}
      />
      {suffix && <span className="blk-num-affix">{suffix}</span>}
    </span>
  );
}

/** Two numbers side by side (x / y in the script's reference canvas). */
export function PointInput({ value, onChange, label, width = 104 }: {
  value: { x: number; y: number };
  onChange: (value: { x: number; y: number }) => void;
  label: string;
  width?: number;
}) {
  return (
    <span className="blk-pair">
      <NumberInput label={`${label} x`} prefix="x" width={width} value={value.x} empty={0} onChange={(x) => onChange({ ...value, x: x ?? 0 })} />
      <NumberInput label={`${label} y`} prefix="y" width={width} value={value.y} empty={0} onChange={(y) => onChange({ ...value, y: y ?? 0 })} />
    </span>
  );
}

/** Text buttons in one row, one active (the original Segmented). */
export function Segmented<T extends string>({ value, options, onChange, label, disabled }: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="blk-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className={option.value === value ? 'is-active' : ''} aria-pressed={option.value === value}
          title={option.hint} disabled={disabled} onClick={() => { if (option.value !== value) onChange(option.value); }}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

const FILTER_FROM = 12;

function optionText(template: Pick<TemplateDefinition, 'id' | 'name'>): string {
  return `${template.name}（${template.id}）`;
}

/** The pickable templates of a set, narrowed by the filter box, in screen groups (digit glyphs hidden). */
function useTemplateGroups(templates: readonly TemplateDefinition[], keep: readonly string[], filter: string) {
  return useMemo(() => {
    const pickable = pickableTemplates(templates, keep, filter);
    const shown = filter.trim() ? pickable.filter((t) => keep.includes(t.id) || matchesTemplateQuery(t, filter)) : pickable;
    return { groups: groupTemplates(shown), pickable: pickable.length, hiddenGlyphs: templates.length - pickable.length, shown: shown.length };
  }, [templates, keep.join('\n'), filter]);
}

function glyphHint(hidden: number): string | undefined {
  return hidden > 0 ? `已隐藏 ${hidden} 张数字字形（只给读数用）；筛选框里输入 dig_ 或「字形」可以显示` : undefined;
}

/**
 * Template dropdown shown as 「名字（id）」 in screen groups (the library's `groupTemplates`). Digit glyphs are left out
 * (a script never taps a glyph; they are more than half of a bundled set) unless already chosen or asked for in the
 * filter. A long set gets a filter box; a referenced id missing from the set stays selectable, marked 「不在模板集里」.
 */
export function TemplatePicker({ value, templates, onChange, label, placeholder = '选一张模板' }: {
  value: string;
  templates: readonly TemplateDefinition[];
  onChange: (id: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [filter, setFilter] = useState('');
  const keep = useMemo(() => (value ? [value] : []), [value]);
  const { groups, pickable, hiddenGlyphs, shown } = useTemplateGroups(templates, keep, filter);
  const missing = Boolean(value) && !templates.some((t) => t.id === value);
  return (
    <span className="blk-picker">
      {pickable > FILTER_FROM && (
        <input type="search" className="blk-picker-filter" aria-label={`${label}：筛选`} placeholder="筛选名称 / ID / 标签" value={filter}
          title={glyphHint(hiddenGlyphs)} onChange={(event) => setFilter(event.target.value)} />
      )}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} title={glyphHint(hiddenGlyphs)}>
        <option value="" disabled>{templates.length ? (filter.trim() && shown === 0 ? '没有匹配的模板' : placeholder) : '模板集里还没有模板'}</option>
        {missing && <option value={value}>{value}（不在模板集里）</option>}
        {groups.map((group) => (
          <optgroup key={group.key} label={`${group.label}（${group.templates.length}）`}>
            {group.templates.map((t) => <option key={t.id} value={t.id}>{optionText(t)}</option>)}
          </optgroup>
        ))}
      </select>
    </span>
  );
}

/**
 * 「出现任意一张」: the chosen templates as removable chips, then the set's pickable templates in screen groups with a
 * filter box (the same grouping and glyph rule as `TemplatePicker`) instead of one long wall of checkboxes.
 */
function TemplateMultiPicker({ value, templates, onChange, label }: {
  value: readonly string[];
  templates: readonly TemplateDefinition[];
  onChange: (ids: string[]) => void;
  label: string;
}) {
  const [filter, setFilter] = useState('');
  const { groups, hiddenGlyphs, shown } = useTemplateGroups(templates, value, filter);
  const nameOf = (id: string): string => templates.find((t) => t.id === id)?.name ?? `${id}（不在模板集里）`;
  const toggle = (id: string, on: boolean): void => onChange(on ? [...value, id] : value.filter((item) => item !== id));
  return (
    <div className="blk-multi-picker" role="group" aria-label={label}>
      <div className="blk-multi-head">
        {value.length === 0 ? <span className="blk-field-hint">还没选模板：在下面勾选，任意一张出现在画面上就算成立</span>
          : value.map((id) => (
            <span key={id} className={`blk-chip${templates.some((t) => t.id === id) ? '' : ' is-missing'}`} title={id}>
              {nameOf(id)}
              <button type="button" aria-label={`去掉 ${nameOf(id)}`} onClick={() => toggle(id, false)}><Icon name="close" size={10} /></button>
            </span>
          ))}
      </div>
      {templates.length === 0 ? <span className="blk-field-hint">模板集里还没有模板，先去截一张</span> : <>
        <input type="search" className="blk-picker-filter" aria-label={`${label}：筛选`} placeholder="筛选名称 / ID / 标签" value={filter}
          title={glyphHint(hiddenGlyphs)} onChange={(event) => setFilter(event.target.value)} />
        <div className="blk-multi">
          {shown === 0 && <span className="blk-field-hint">没有匹配的模板</span>}
          {groups.map((group) => (
            <fieldset key={group.key} className="blk-multi-group">
              <legend>{group.label}（{group.templates.length}）</legend>
              {group.templates.map((t) => (
                <label key={t.id} className="check small" title={t.id}>
                  <input type="checkbox" checked={value.includes(t.id)} onChange={(event) => toggle(t.id, event.target.checked)} />
                  {t.name}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </>}
    </div>
  );
}

/** The camera next to a template picker: 「现截一张新的」 inserts a NEW block after this one (original semantics). */
export function CaptureButton({ onCapture, blocked }: { onCapture?: () => void; blocked?: string | null }) {
  if (!onCapture) return null;
  return (
    <button type="button" className="btn xs blk-camera" onClick={onCapture} disabled={Boolean(blocked)}
      title={blocked ?? '现截一张新的：抓一帧画面拉个框，在这块后面插入一块新块'} aria-label="现截一张新的">
      <Icon name="camera" size={14} />
    </button>
  );
}

/**
 * Condition editor. Covers everyday use; and / or / not / never are shown read-only and edited in the JSON mode —
 * a visual expression tree for a few percent of cases is not worth it (iron rule 5).
 *
 * The Assistant only checks its own game in the foreground, so that mode shows the package and flips 是 / 不是.
 */
export function CondEditor({ cond, templates, onChange, onCapture, captureBlocked, allowEmpty, gamePackage, label }: {
  cond?: Condition;
  templates: readonly TemplateDefinition[];
  onChange: (cond: Condition | null) => void;
  onCapture?: () => void;
  captureBlocked?: string | null;
  allowEmpty?: boolean;
  gamePackage: string;
  label: string;
}) {
  const mode = condModeOf(cond);
  const options = useMemo(() => (['none', 'has', 'hasNot', 'anyOf', 'foreground', 'always'] as const)
    .filter((m) => allowEmpty || m !== 'none')
    .map((m) => ({ value: m as CondMode, label: COND_MODE_TEXT[m] })), [allowEmpty]);

  if (mode === 'complex' && cond) {
    return (
      <div className="blk-note is-info" role="note">
        <strong>组合条件：{describeCond(cond, templates)}</strong>
        <span>这种条件要到 JSON 模式里改。可视化模式不会动它。</span>
      </div>
    );
  }

  return (
    <div className="blk-cond">
      <Segmented label={label} value={mode} options={options} onChange={(next) => onChange(seedCondition(next, templates, gamePackage))} />
      {(mode === 'has' || mode === 'hasNot') && cond?.kind === 'template' && (
        <span className="blk-row">
          <TemplatePicker label={`${label}：模板`} value={cond.templateId} templates={templates} onChange={(templateId) => onChange({ ...cond, templateId })} />
          <CaptureButton onCapture={onCapture} blocked={captureBlocked} />
          <NumberInput label={`${label}：匹配阈值`} prefix="阈值" width={128} min={0.5} max={0.99} step={0.01} placeholder="模板自带" value={cond.threshold}
            onChange={(threshold) => onChange({ ...cond, threshold })} />
        </span>
      )}
      {mode === 'anyOf' && cond?.kind === 'anyTemplate' && (
        <TemplateMultiPicker label={`${label}：出现任意一张就算成立`} value={cond.templateIds} templates={templates}
          onChange={(templateIds) => onChange({ ...cond, templateIds })} />
      )}
      {mode === 'foreground' && cond?.kind === 'foreground' && (
        <span className="blk-row">
          <span className={`blk-readonly${cond.packageName && cond.packageName !== gamePackage ? ' is-warning' : ''}`} title="助手只允许检查当前游戏">
            {cond.packageName || '（未填包名）'}
          </span>
          {cond.packageName !== gamePackage && gamePackage && (
            <button type="button" className="btn xs" onClick={() => onChange({ ...cond, packageName: gamePackage })}>改成当前游戏</button>
          )}
          <Segmented label={`${label}：是 / 不是`} value={cond.equals === false ? 'no' : 'yes'}
            options={[{ value: 'yes', label: '是' }, { value: 'no', label: '不是' }]}
            onChange={(v) => onChange({ ...cond, equals: v === 'yes' ? undefined : false })} />
        </span>
      )}
    </div>
  );
}
