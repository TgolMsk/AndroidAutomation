import { useState, type KeyboardEvent } from 'react';
import { PLAN_RANGE, clampToRange, type PlanTask, type TaskTrigger } from '../../../shared/plan';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { addDailyTimes, NOTE_MAX, parseDailyInput, taskDraftProblem, TRIGGER_KINDS, triggerOfKind } from './plans-model';

export interface TaskDraft {
  accountId: string;
  task: PlanTask;
  /** Editing an existing task: the account cannot change. */
  editing: boolean;
}

interface Option { value: string; label: string }

/** 「添加任务 / 编辑任务」 (original TaskModal): account, script, Beijing-time trigger, priority, limit, note. */
export function TaskDialog({ draft, accountOptions, scriptOptions, busy, onChange, onClose, onSave }: {
  draft: TaskDraft;
  accountOptions: Option[];
  scriptOptions: Option[];
  busy: boolean;
  onChange(next: TaskDraft): void;
  onClose(): void;
  onSave(): void;
}) {
  const task = draft.task;
  const problem = taskDraftProblem(task);
  const setTask = (patch: Partial<PlanTask>): void => onChange({ ...draft, task: { ...task, ...patch } });
  const setTrigger = (trigger: TaskTrigger): void => setTask({ trigger });
  const missingScript = task.scriptId && !scriptOptions.some((option) => option.value === task.scriptId);
  return (
    <Modal title={draft.editing ? '编辑任务' : '添加任务'} onClose={onClose} busy={busy} width={600}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn primary" onClick={onSave} disabled={busy || problem !== null} title={problem ?? undefined}>
          {busy && <Spinner size={12} />}保存
        </button>
      </>}>
      <div className="plans-form">
        <label className="plans-field">
          <span className="plans-field-label">账号</span>
          <select value={draft.accountId} disabled={draft.editing || busy} onChange={(e) => onChange({ ...draft, accountId: e.target.value })}>
            {accountOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="plans-hint">任务跑在这个账号绑定的实例上。</span>
        </label>
        <label className="plans-field">
          <span className="plans-field-label">脚本</span>
          <select value={task.scriptId} disabled={busy} onChange={(e) => setTask({ scriptId: e.target.value })}>
            {missingScript && <option value={task.scriptId}>脚本已删除（{task.scriptId}）</option>}
            {scriptOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="plans-hint">在「脚本」页建好的脚本。模板来自模板库，脚本里引用哪些模板由脚本自己决定。</span>
        </label>
        <div className="plans-field">
          <span className="plans-field-label">运行时间</span>
          <div className="plans-segmented" role="radiogroup" aria-label="触发方式">
            {TRIGGER_KINDS.map((item) => (
              <button key={item.kind} type="button" role="radio" aria-checked={task.trigger.kind === item.kind}
                className={task.trigger.kind === item.kind ? 'is-active' : ''} disabled={busy}
                onClick={() => { if (task.trigger.kind !== item.kind) setTrigger(triggerOfKind(item.kind)); }}>{item.label}</button>
            ))}
          </div>
          {task.trigger.kind === 'daily' && <DailyTimes times={task.trigger.at} disabled={busy} onChange={(at) => setTrigger({ kind: 'daily', at })} />}
          {task.trigger.kind === 'interval' && <IntervalEditor trigger={task.trigger} disabled={busy} onChange={setTrigger} />}
          {task.trigger.kind === 'manual' && <span className="plans-hint">只在这一页点「立即运行」时才跑。适合还在调试的脚本。</span>}
          <span className="plans-hint">HH:MM 一律是北京时间。</span>
        </div>
        <div className="plans-field-row">
          <label className="plans-field">
            <span className="plans-field-label">优先级</span>
            <input type="number" min={PLAN_RANGE.priority[0]} max={PLAN_RANGE.priority[1]} step={1} value={task.priority} disabled={busy}
              onChange={(e) => setTask({ priority: clampToRange(Number(e.target.value || 50), PLAN_RANGE.priority) })} />
            <span className="plans-hint">同一个实例上同时到点时，数字大的先跑。</span>
          </label>
          <label className="plans-field">
            <span className="plans-field-label">单次时间上限（分钟）</span>
            <input type="number" min={PLAN_RANGE.maxRunMinutes[0]} max={PLAN_RANGE.maxRunMinutes[1]} step={1} value={task.maxRunMinutes} disabled={busy}
              onChange={(e) => setTask({ maxRunMinutes: clampToRange(Number(e.target.value || 0), PLAN_RANGE.maxRunMinutes) })} />
            <span className="plans-hint">超过就停掉这次执行，防止一个卡住的脚本一直霸占实例。填 0 表示不限。</span>
          </label>
        </div>
        <label className="plans-field">
          <span className="plans-field-label">备注</span>
          <input type="text" value={task.note ?? ''} maxLength={NOTE_MAX} disabled={busy} placeholder="只给自己看"
            onChange={(e) => setTask({ note: e.target.value || undefined })} />
        </label>
        {problem && <p className="plans-inline-error" role="alert">{problem}</p>}
      </div>
    </Modal>
  );
}

/** Daily times as chips; typing 08:00 and Enter (or 「,」「，」 space) adds one (original tags select). */
function DailyTimes({ times, disabled, onChange }: { times: string[]; disabled: boolean; onChange(times: string[]): void }) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const commit = (value: string): void => {
    const parsed = parseDailyInput(value);
    setInvalid(parsed.invalid);
    if (parsed.times.length) onChange(addDailyTimes(times, parsed.times));
    setText('');
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',' || event.key === '，' || event.key === ' ') {
      event.preventDefault();
      if (text.trim()) commit(text);
    } else if (event.key === 'Backspace' && !text && times.length) {
      onChange(times.slice(0, -1));
    }
  };
  return (
    <div className="plans-daily">
      <div className="plans-chips">
        {times.map((time) => (
          <span key={time} className="plans-chip">{time}
            <button type="button" aria-label={`删除 ${time}`} disabled={disabled} onClick={() => onChange(times.filter((item) => item !== time))}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
        <input type="text" value={text} disabled={disabled} placeholder={times.length ? '再加一个时刻' : '输入 08:00 回车，可以加多个时刻'}
          aria-label="添加时刻（北京时间 HH:MM）" onChange={(e) => {
            const value = e.target.value;
            if (/[,，\s]$/.test(value)) commit(value); else setText(value);
          }} onKeyDown={onKey} onBlur={() => { if (text.trim()) commit(text); }} />
      </div>
      {invalid.length > 0 && <span className="plans-inline-error">「{invalid.join('、')}」不是 HH:MM 格式，已忽略。</span>}
    </div>
  );
}

/**
 * 「按间隔重复」: every N minutes, optionally only inside a Beijing time window (a start later than the end wraps
 * midnight, e.g. 22:00 至 06:00).
 */
function IntervalEditor({ trigger, disabled, onChange }: {
  trigger: Extract<TaskTrigger, { kind: 'interval' }>;
  disabled: boolean;
  onChange(trigger: TaskTrigger): void;
}) {
  const span = trigger.window;
  return (
    <div className="plans-interval">
      <label className="plans-inline">每
        <input type="number" min={PLAN_RANGE.everyMinutes[0]} max={PLAN_RANGE.everyMinutes[1]} step={1} value={trigger.everyMinutes} disabled={disabled}
          aria-label="间隔分钟数"
          onChange={(e) => onChange({ ...trigger, everyMinutes: clampToRange(Number(e.target.value || 60), PLAN_RANGE.everyMinutes) })} />
        分钟
      </label>
      <label className="plans-inline" title="只在这个北京时间段内跑。起点晚于终点表示跨零点，例如 22:00 至 06:00。">
        <input type="checkbox" checked={Boolean(span)} disabled={disabled}
          onChange={(e) => {
            if (e.target.checked) onChange({ ...trigger, window: { from: '09:00', to: '23:00' } });
            else onChange({ kind: 'interval', everyMinutes: trigger.everyMinutes });
          }} />
        限时段
      </label>
      {span ? (
        <span className="plans-inline">
          <input type="text" className="plans-clock" value={span.from} placeholder="09:00" aria-label="时段起点" disabled={disabled}
            onChange={(e) => onChange({ ...trigger, window: { ...span, from: e.target.value } })} />
          至
          <input type="text" className="plans-clock" value={span.to} placeholder="23:00" aria-label="时段终点" disabled={disabled}
            onChange={(e) => onChange({ ...trigger, window: { ...span, to: e.target.value } })} />
        </span>
      ) : <span className="plans-hint">全天</span>}
    </div>
  );
}
