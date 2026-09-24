import { useEffect, useId, useState } from 'react';
import type { TemplateDefinition } from '@avdm/automation';
import {
  ANDROID_KEY_TEXT, ANDROID_KEYS, FAIL_POLICY_TEXT, SCRIPT_LIMITS, failPolicyFor,
  type AndroidKey, type FailPolicy, type LogLevel, type ScriptDef, type ScriptStep,
} from '@avdm/automation/script';
import { CaptureButton, CondEditor, Field, NumberInput, PointInput, TemplatePicker } from './fields';
import { blockShapeProblem } from './script-editor';

const LOG_LEVEL_TEXT: Readonly<Record<LogLevel, string>> = { debug: '调试', info: '信息', warn: '警告', error: '错误' };

export interface StepFieldsProps {
  step: ScriptStep;
  script: Pick<ScriptDef, 'refWidth' | 'refHeight'>;
  templates: readonly TemplateDefinition[];
  /** The game's package: the only app a script may start, stop or check. */
  gamePackage: string;
  /** Label names in the script (goto suggestions). */
  labels: readonly string[];
  onPatch: (next: ScriptStep) => void;
  /** 「现截一张新的」: capture and insert a NEW block after this one. */
  onCapture?: () => void;
  captureBlocked?: string | null;
}

/**
 * The form of one block (original `StepFields`): the leaf and flow blocks, then 「更多设置」 with the name, the when
 * condition and the failure handling. Ranges follow the script validator (`SCRIPT_LIMITS`), so the form never
 * offers what saving would refuse.
 *
 * ★ Coordinates live in the script's REFERENCE canvas (refWidth × refHeight), never device pixels: the hint says
 *   so on every coordinate field (an AVD often runs at a smaller size than the 2560×1440 canvas).
 */
export function StepFields({ step, script, templates, gamePackage, labels, onPatch, onCapture, captureBlocked }: StepFieldsProps) {
  const coordHint = `参考分辨率 ${script.refWidth}×${script.refHeight}`;
  const listId = useId();
  const cond = (props: { cond?: Parameters<typeof CondEditor>[0]['cond']; onChange: Parameters<typeof CondEditor>[0]['onChange']; allowEmpty?: boolean; label: string }) => (
    <CondEditor {...props} templates={templates} gamePackage={gamePackage} onCapture={onCapture} captureBlocked={captureBlocked} />
  );

  return (
    <div className="blk-form">
      <div className="blk-fields">
        {step.kind === 'tapTemplate' && <>
          <Field label="点哪张模板" wide>
            <span className="blk-row">
              <TemplatePicker label="点哪张模板" value={step.templateId} templates={templates} onChange={(templateId) => onPatch({ ...step, templateId })} />
              <CaptureButton onCapture={onCapture} blocked={captureBlocked} />
            </span>
          </Field>
          <Field label="找不到时最多等" hint="0 = 只看当前这一帧">
            <NumberInput label="找不到时最多等" suffix="ms" min={0} max={SCRIPT_LIMITS.maxWaitMs} step={500} value={step.waitMs ?? 0} empty={0}
              onChange={(waitMs) => onPatch({ ...step, waitMs: waitMs ?? 0 })} />
          </Field>
          <Field label="点击偏移" hint="相对模板中心，一般留 0">
            <PointInput label="点击偏移" width={92} value={step.offset ?? { x: 0, y: 0 }}
              onChange={(offset) => onPatch({ ...step, offset: offset.x || offset.y ? offset : undefined })} />
          </Field>
          <Field label="匹配阈值" hint="留空用模板自己的；调低更容易命中也更容易认错">
            <NumberInput label="匹配阈值" min={0.5} max={0.99} step={0.01} width={110} value={step.threshold} onChange={(threshold) => onPatch({ ...step, threshold })} />
          </Field>
        </>}

        {step.kind === 'waitFor' && <>
          <Field label="等什么" wide>
            {cond({ label: '等什么', cond: step.cond, onChange: (next) => { if (next) onPatch({ ...step, cond: next }); } })}
          </Field>
          <Field label="最多等" hint="超时算这一步失败">
            <NumberInput label="最多等" suffix="ms" min={0} max={SCRIPT_LIMITS.maxWaitMs} step={1000} value={step.waitMs} empty={0}
              onChange={(waitMs) => onPatch({ ...step, waitMs: waitMs ?? 0 })} />
          </Field>
          <Field label="多久看一次" hint="留空 = 按引擎默认节奏（约 3 帧/秒）">
            <NumberInput label="多久看一次" suffix="ms" min={100} max={10_000} step={100} value={step.pollMs} onChange={(pollMs) => onPatch({ ...step, pollMs })} />
          </Field>
        </>}

        {step.kind === 'tap' && (
          <Field label="点哪里" hint={coordHint}>
            <PointInput label="点哪里" value={step.at} onChange={(at) => onPatch({ ...step, at })} />
          </Field>
        )}

        {step.kind === 'swipe' && <>
          <Field label="从" hint={coordHint}><PointInput label="滑动起点" value={step.from} onChange={(from) => onPatch({ ...step, from })} /></Field>
          <Field label="滑到"><PointInput label="滑动终点" value={step.to} onChange={(to) => onPatch({ ...step, to })} /></Field>
          <Field label="用时" hint="滑动期间队列是堵住的，别写太长">
            <NumberInput label="滑动用时" suffix="ms" min={50} max={SCRIPT_LIMITS.maxSwipeMs} value={step.durationMs ?? 300} empty={300}
              onChange={(durationMs) => onPatch({ ...step, durationMs: durationMs ?? 300 })} />
          </Field>
        </>}

        {step.kind === 'longPress' && <>
          <Field label="按哪里" hint={coordHint}><PointInput label="长按位置" value={step.at} onChange={(at) => onPatch({ ...step, at })} /></Field>
          <Field label="按多久">
            <NumberInput label="按多久" suffix="ms" min={100} max={SCRIPT_LIMITS.warnLongPressMs} value={step.durationMs} empty={800}
              onChange={(durationMs) => onPatch({ ...step, durationMs: durationMs ?? 800 })} />
          </Field>
        </>}

        {step.kind === 'text' && (
          <Field label="输入什么" wide hint="中文会走 ADBKeyboard 广播：先在「执行监控」给实例安装并启用输入法，否则这一步会失败。可以用 {{参数}} 引用脚本参数。">
            <input type="text" aria-label="输入什么" value={step.text} maxLength={SCRIPT_LIMITS.maxText} onChange={(event) => onPatch({ ...step, text: event.target.value })} />
          </Field>
        )}

        {step.kind === 'key' && (
          <Field label="按哪个键">
            <select aria-label="按哪个键" value={step.key} onChange={(event) => onPatch({ ...step, key: event.target.value as AndroidKey })}>
              {ANDROID_KEYS.map((key) => <option key={key} value={key}>{ANDROID_KEY_TEXT[key]}</option>)}
            </select>
          </Field>
        )}

        {step.kind === 'sleep' && (
          <Field label="等多久" hint="能用「等它出现」就别死等">
            <NumberInput label="等多久" suffix="ms" min={0} max={SCRIPT_LIMITS.maxSleepMs} step={100} value={step.ms} empty={0} onChange={(ms) => onPatch({ ...step, ms: ms ?? 0 })} />
          </Field>
        )}

        {(step.kind === 'launchApp' || step.kind === 'stopApp') && (
          <Field label="应用" hint={step.packageName && step.packageName !== gamePackage ? '助手只允许启动 / 关闭当前游戏，这个包名保存时会被拒绝' : '助手只操作当前游戏，不能改成别的应用'}>
            <span className="blk-row">
              <span className={`blk-readonly${step.packageName && step.packageName !== gamePackage ? ' is-warning' : ''}`}>{step.packageName ?? gamePackage}</span>
              {step.packageName !== undefined && (
                <button type="button" className="btn xs" onClick={() => onPatch({ ...step, packageName: undefined })}>改用脚本的应用</button>
              )}
            </span>
          </Field>
        )}
        {step.kind === 'launchApp' && (
          <Field label="冷启动" hint="先强制停止再打开，保证是全新进程">
            <label className="check small"><input type="checkbox" checked={step.cold ?? false} onChange={(event) => onPatch({ ...step, cold: event.target.checked })} />冷启动</label>
          </Field>
        )}

        {step.kind === 'screenshot' && (
          <Field label="截图标签" hint="会写进文件名，方便回头找">
            <input type="text" aria-label="截图标签" maxLength={80} value={step.label ?? ''} onChange={(event) => onPatch({ ...step, label: event.target.value || undefined })} />
          </Field>
        )}

        {step.kind === 'log' && <>
          <Field label="级别">
            <select aria-label="日志级别" value={step.level} onChange={(event) => onPatch({ ...step, level: event.target.value as LogLevel })}>
              {(Object.keys(LOG_LEVEL_TEXT) as LogLevel[]).map((level) => <option key={level} value={level}>{LOG_LEVEL_TEXT[level]}</option>)}
            </select>
          </Field>
          <Field label="写什么" wide>
            <input type="text" aria-label="日志内容" maxLength={SCRIPT_LIMITS.maxText} value={step.message} onChange={(event) => onPatch({ ...step, message: event.target.value })} />
          </Field>
        </>}

        {step.kind === 'if' && (
          <Field label="条件" wide>{cond({ label: '条件', cond: step.cond, onChange: (next) => { if (next) onPatch({ ...step, cond: next }); } })}</Field>
        )}

        {step.kind === 'loop' && <>
          <Field label="重复几次" hint="留空 = 只看下面的条件">
            <NumberInput label="重复几次" min={1} max={10_000} value={step.repeat} onChange={(repeat) => onPatch({ ...step, repeat })} />
          </Field>
          <Field label="只要满足就继续" hint="留空 = 只按次数" wide>
            {cond({ label: '只要满足就继续', allowEmpty: true, cond: step.while, onChange: (next) => onPatch({ ...step, while: next ?? undefined }) })}
          </Field>
          <Field label="硬上限" hint="防死循环，默认 1000">
            <NumberInput label="硬上限" min={1} max={SCRIPT_LIMITS.maxIterations} placeholder="1000" value={step.maxIterations} onChange={(maxIterations) => onPatch({ ...step, maxIterations })} />
          </Field>
        </>}

        {step.kind === 'label' && (
          <Field label="落点名" hint="给「跳转」用，整个脚本里不能重名">
            <input type="text" aria-label="落点名" maxLength={96} value={step.label} onChange={(event) => onPatch({ ...step, label: event.target.value })} />
          </Field>
        )}

        {step.kind === 'goto' && <>
          <Field label="跳到哪个落点" hint="只能跳到同级或外层的落点">
            <input type="text" aria-label="跳到哪个落点" list={listId} maxLength={96} value={step.label} onChange={(event) => onPatch({ ...step, label: event.target.value })} />
          </Field>
          <Field label="最多跳几次" hint="防死循环">
            <NumberInput label="最多跳几次" min={1} max={10_000} value={step.maxTimes} onChange={(maxTimes) => onPatch({ ...step, maxTimes })} />
          </Field>
        </>}
        <datalist id={listId}>{labels.map((label) => <option key={label} value={label} />)}</datalist>
      </div>

      <MoreSettings step={step} templates={templates} gamePackage={gamePackage} listId={listId} onPatch={onPatch} onCapture={onCapture} captureBlocked={captureBlocked} />
    </div>
  );
}

function MoreSettings({ step, templates, gamePackage, listId, onPatch, onCapture, captureBlocked }: {
  step: ScriptStep;
  templates: readonly TemplateDefinition[];
  gamePackage: string;
  listId: string;
  onPatch: (next: ScriptStep) => void;
  onCapture?: () => void;
  captureBlocked?: string | null;
}) {
  const patch = (changes: Partial<ScriptStep>): void => onPatch({ ...step, ...changes } as ScriptStep);
  const onFail = step.onFail?.kind ?? 'abort';
  return (
    <details className="blk-more">
      <summary>更多设置（起名、前置条件、失败处理）</summary>
      <div className="blk-fields">
        <Field label="这一块叫什么" hint="会显示在日志里，不填就用块类型">
          <input type="text" aria-label="这一块叫什么" maxLength={120} placeholder="例如：点开联盟" value={step.name ?? ''}
            onChange={(event) => patch({ name: event.target.value || undefined })} />
        </Field>
        <Field label="前置条件" hint="不成立就跳过这一块，不算失败" wide>
          <CondEditor label="前置条件" allowEmpty cond={step.when} templates={templates} gamePackage={gamePackage} onCapture={onCapture} captureBlocked={captureBlocked}
            onChange={(when) => patch({ when: when ?? undefined })} />
        </Field>
        <Field label="失败重试">
          <span className="blk-pair">
            <NumberInput label="失败重试次数" suffix="次" width={96} min={0} max={20} value={step.retry ?? 0} empty={0} onChange={(retry) => patch({ retry: retry ?? 0 })} />
            <NumberInput label="重试间隔" suffix="ms 后" width={132} min={0} max={SCRIPT_LIMITS.maxDelayMs} step={100} value={step.retryDelayMs}
              onChange={(retryDelayMs) => patch({ retryDelayMs })} />
          </span>
        </Field>
        <Field label="重试完还是失败" hint="开着 AI 顾问的「自动处理」时，AI 会先看一眼画面再按这里处理（选「跳过」时除外）">
          <select aria-label="重试完还是失败" value={onFail} onChange={(event) => patch({ onFail: failPolicyFor(event.target.value as FailPolicy['kind'], step.onFail) })}>
            {(Object.keys(FAIL_POLICY_TEXT) as FailPolicy['kind'][]).map((kind) => <option key={kind} value={kind}>{FAIL_POLICY_TEXT[kind]}</option>)}
          </select>
        </Field>
        {step.onFail?.kind === 'goto' && (
          <Field label="跳到哪个落点">
            <input type="text" aria-label="失败后跳到哪个落点" list={listId} maxLength={96} value={step.onFail.label}
              onChange={(event) => patch({ onFail: { kind: 'goto', label: event.target.value } })} />
          </Field>
        )}
        <Field label="这一块的超时" hint="留空 = 不单独限时">
          <NumberInput label="这一块的超时" suffix="ms" min={SCRIPT_LIMITS.minTimeoutMs} max={SCRIPT_LIMITS.maxTimeoutMs} step={1000} value={step.timeoutMs}
            onChange={(timeoutMs) => patch({ timeoutMs })} />
        </Field>
        <Field label="做完再等一下" hint="给界面动画留时间">
          <NumberInput label="做完再等一下" suffix="ms" min={0} max={SCRIPT_LIMITS.maxDelayMs} step={100} value={step.afterDelayMs} onChange={(afterDelayMs) => patch({ afterDelayMs })} />
        </Field>
        <Field label="强制留痕" hint="不管全局策略，这一块都存一张截图">
          <label className="check small">
            <input type="checkbox" checked={step.capture === true} onChange={(event) => patch({ capture: event.target.checked ? true : undefined })} />强制留痕
          </label>
        </Field>
      </div>
      <BlockJson step={step} onPatch={onPatch} />
    </details>
  );
}

/** A plain object whose id and kind are the block's own: anything else is not applied. */
function sameBlock(value: unknown, current: ScriptStep): value is ScriptStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const next = value as { id?: unknown; kind?: unknown };
  return next.id === current.id && next.kind === current.kind;
}

/**
 * The Assistant's per-block JSON escape hatch (kept from its old step editor): edit one block's fields — a
 * composite condition, an ROI — without leaving the visual mode. Only valid JSON with the same id and kind is
 * applied, so a half-typed text never reaches the script; an if / loop must keep its child arrays (the tree walkers
 * of the page need them, see `blockShapeProblem`). Everything else is checked by validation as usual.
 */
function BlockJson({ step, onPatch }: { step: ScriptStep; onPatch: (next: ScriptStep) => void }) {
  const [raw, setRaw] = useState(() => JSON.stringify(step, null, 2));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setRaw((current) => {
      try { if (JSON.stringify(JSON.parse(current)) === JSON.stringify(step)) return current; } catch { /* keep typing */ }
      return problem ? current : JSON.stringify(step, null, 2);
    });
  }, [step, problem]);
  return (
    <details className="blk-json">
      <summary>这一块的 JSON（高级）</summary>
      <textarea aria-label={`块 ${step.id} 的 JSON`} spellCheck={false} rows={8} value={raw} className={problem ? 'is-invalid' : ''}
        onChange={(event) => {
          const text = event.target.value;
          setRaw(text);
          try {
            const parsed: unknown = JSON.parse(text);
            if (!sameBlock(parsed, step)) { setProblem('id 和 kind 不能在这里改；要换块类型请删掉重加'); return; }
            const shape = blockShapeProblem(parsed);
            if (shape) { setProblem(`${shape}（改动暂不生效）`); return; }
            setProblem(null);
            onPatch(parsed);
          } catch (error) {
            setProblem(`JSON 还没写完：${error instanceof Error ? error.message : String(error)}（改动暂不生效）`);
          }
        }} />
      {problem && <span className="blk-field-hint is-error">{problem}</span>}
    </details>
  );
}
