/**
 * Static script checks (wanlong-panel `store/scripts.ts` validateScript + its zod schema, merged with the
 * Assistant's safety limits). Nothing here touches a disk or a device.
 *
 * Three severities, as in the original:
 *  - fatal errors (`fatal: true`): the document cannot be a script at all — wrong shapes, duplicate step ids,
 *    duplicate labels anywhere, goto/onFail targets outside the visible scope, bad resolution — plus the
 *    Assistant's safety errors (another app's package, nesting depth, size). Such a script is never saved.
 *  - other errors: saved as a draft (ROI out of bounds, missing template, …) but refused at execution.
 *  - warnings: shown to the author only.
 */
import { placeholderKeys } from './interpolate.js';
import {
  ANDROID_KEYS, LOG_LEVELS, STEP_KINDS,
  type Condition, type Rect, type ScriptDef, type ScriptIssue, type ScriptMeta, type ScriptStep,
} from './types.js';

export interface ValidateOptions {
  /** The only package a script may start, stop or check (the game plugin's). Omit for a generic engine. */
  expectedPackage?: string;
  /** Template ids of the set the script will run against; omit to skip the existence check. */
  availableTemplateIds?: readonly string[];
  /** Reference canvas of that template set; a different script canvas is a warning. */
  templateRef?: { width: number; height: number };
  /** The target device can type non-ASCII text (ADBKeyboard installed and enabled). */
  unicodeInput?: boolean;
}

export const SCRIPT_LIMITS = Object.freeze({
  maxSteps: 300,
  maxDepth: 8,
  maxText: 2048,
  maxParams: 50,
  maxConditionItems: 30,
  maxAnyTemplates: 50,
  maxWaitMs: 30 * 60_000,
  maxSleepMs: 60 * 60_000,
  minTimeoutMs: 100,
  maxTimeoutMs: 600_000,
  maxDelayMs: 60_000,
  maxRetry: 100,
  warnRetry: 10,
  maxLongPressMs: 60_000,
  warnLongPressMs: 10_000,
  maxSwipeMs: 10_000,
  maxGotoTimes: 100_000,
  maxIterations: 100_000,
  minLoopIntervalMs: 1000,
  maxLoopIntervalMs: 24 * 3_600_000,
});

/** Script and step ids are file names and log keys. */
export const SCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown, max = 120): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const isPoint = (value: unknown): value is { x: number; y: number } => isObject(value) && isNumber(value.x) && isNumber(value.y);
const isRect = (value: unknown): value is Rect => isObject(value) && isNumber(value.x) && isNumber(value.y) && isNumber(value.w) && isNumber(value.h);
const isInteger = (value: unknown): value is number => Number.isInteger(value);

export function validateScript(raw: unknown, options: ValidateOptions = {}): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const fatal = (message: string, stepId: string | null = null): void => { issues.push({ level: 'error', stepId, message, fatal: true }); };
  const error = (message: string, stepId: string | null = null): void => { issues.push({ level: 'error', stepId, message }); };
  const warn = (message: string, stepId: string | null = null): void => { issues.push({ level: 'warn', stepId, message }); };

  if (!isObject(raw)) return [{ level: 'error', stepId: null, message: '脚本必须是 JSON 对象。', fatal: true }];
  const expected = options.expectedPackage;

  // ── Script header ──
  if (!isText(raw.id, 96) || !SCRIPT_ID.test(raw.id)) fatal('脚本 id 只能包含字母、数字、点、下划线和短横线（最长 96 个字符）。');
  if (!isText(raw.name)) fatal('脚本名称不能为空（最长 120 个字符）。');
  if (!isText(raw.version, 32)) fatal('脚本版本号不能为空（例如 1.0.0）。');
  if (raw.description !== undefined && typeof raw.description !== 'string') fatal('脚本说明必须是文本。');
  else if (typeof raw.description === 'string' && raw.description.length > 4000) error('脚本说明不能超过 4000 个字符。');
  if (!isNumber(raw.refWidth) || !isNumber(raw.refHeight) || raw.refWidth <= 0 || raw.refHeight <= 0 ||
    raw.refWidth > 16_384 || raw.refHeight > 16_384) fatal('参考分辨率必须为正数（宽、高不超过 16384）。');
  if (raw.packageName !== undefined) {
    if (typeof raw.packageName !== 'string' || !PACKAGE.test(raw.packageName)) fatal('脚本包名格式无效。');
    else if (expected && raw.packageName !== expected) fatal(`脚本只能操作当前游戏（${expected}），不能改成 ${raw.packageName}。`);
  }
  if (raw.templateSetId !== undefined && (!isText(raw.templateSetId, 128) || !TEMPLATE_ID.test(raw.templateSetId))) fatal('模板集 id 格式无效。');
  if (raw.updatedAt !== undefined && !isNumber(raw.updatedAt)) fatal('updatedAt 必须是时间戳。');
  if (raw.loop !== undefined && typeof raw.loop !== 'boolean') fatal('循环模式开关必须是 true 或 false。');
  if (raw.loopIntervalMs !== undefined && (!isNumber(raw.loopIntervalMs) || raw.loopIntervalMs < 0)) fatal('每轮间隔必须是非负数（毫秒）。');
  if (!Array.isArray(raw.steps)) fatal('steps 必须是步骤数组。');

  const refW = isNumber(raw.refWidth) && raw.refWidth > 0 ? raw.refWidth : 0;
  const refH = isNumber(raw.refHeight) && raw.refHeight > 0 ? raw.refHeight : 0;
  const templateRef = options.templateRef;
  if (refW && refH && templateRef && (templateRef.width !== refW || templateRef.height !== refH)) {
    warn(`脚本坐标空间是 ${refW}x${refH}，与当前模板集的参考分辨率 ${templateRef.width}x${templateRef.height} 不一致；` +
      '执行器会自动等比换算，但模板是按模板集参考分辨率归一化的，建议统一以免出现偏移。');
  }

  // ── Params ──
  const declared = new Set<string>();
  if (raw.params !== undefined) {
    if (!Array.isArray(raw.params) || raw.params.length > SCRIPT_LIMITS.maxParams) fatal(`参数定义必须是数组且不超过 ${SCRIPT_LIMITS.maxParams} 项。`);
    else for (const param of raw.params as unknown[]) {
      if (!isObject(param) || typeof param.key !== 'string' || !PARAM_KEY.test(param.key) || !isText(param.label) ||
        !['string', 'number', 'boolean', 'enum'].includes(String(param.type))) {
        fatal('参数定义无效：需要 key（字母、数字、_ . -）、label 和 type（string / number / boolean / enum）。');
        continue;
      }
      if (declared.has(param.key)) { fatal(`参数 key 重复：「${param.key}」。`); continue; }
      declared.add(param.key);
      if (param.note !== undefined && (typeof param.note !== 'string' || param.note.length > 1000)) fatal(`参数「${param.key}」的说明必须是文本。`);
      const choices = param.options;
      if (param.type === 'enum') {
        if (choices !== undefined && (!Array.isArray(choices) || !choices.every((c) => isObject(c) && typeof c.value === 'string' && typeof c.label === 'string'))) {
          fatal(`枚举参数「${param.key}」的选项必须是 { value, label } 列表。`);
        } else if (!Array.isArray(choices) || !choices.length) {
          error(`枚举参数「${param.key}」需要至少一个选项。`);
        } else if (param.default !== undefined && !choices.some((c) => (c as Obj).value === param.default)) {
          error(`枚举参数「${param.key}」的默认值不在候选项里。`);
        }
      } else if (choices !== undefined) warn(`参数「${param.key}」不是枚举类型，options 会被忽略。`);
      if (param.default !== undefined) {
        const want = param.type === 'enum' ? 'string' : param.type;
        if (!['string', 'number', 'boolean'].includes(typeof param.default) || (typeof param.default === 'number' && !Number.isFinite(param.default))) {
          fatal(`参数「${param.key}」的默认值只能是文本、数字或布尔值。`);
        } else if (typeof param.default !== want) {
          error(`参数「${param.key}」的默认值类型应为 ${want}。`);
        } else if (typeof param.default === 'string' && param.default.length > SCRIPT_LIMITS.maxText) {
          error(`参数「${param.key}」的默认值过长。`);
        }
      }
    }
  }

  const steps = Array.isArray(raw.steps) ? raw.steps as unknown[] : [];
  if (Array.isArray(raw.steps) && steps.length === 0) warn('脚本没有任何步骤，跑起来会立刻结束。');

  // ── Pass 1: step ids and labels anywhere in the tree ──
  const seenIds = new Set<string>();
  const allLabels = new Set<string>();
  const duplicatedLabels = new Set<string>();
  let total = 0;
  let tooMany = false;
  let tooDeep = false;
  const collect = (list: unknown, depth: number): void => {
    if (!Array.isArray(list)) return;
    if (depth > SCRIPT_LIMITS.maxDepth) { tooDeep = true; return; }
    for (const item of list as unknown[]) {
      if (++total > SCRIPT_LIMITS.maxSteps) tooMany = true;
      if (!isObject(item)) continue;
      if (typeof item.id === 'string') {
        if (seenIds.has(item.id)) fatal(`步骤 id 重复：「${item.id}」。日志归档与 goto 依赖 id 唯一。`, item.id);
        seenIds.add(item.id);
      }
      if (item.kind === 'label' && typeof item.label === 'string') {
        if (allLabels.has(item.label)) duplicatedLabels.add(item.label);
        allLabels.add(item.label);
      }
      if (item.kind === 'if') { collect(item.then, depth + 1); collect(item.else, depth + 1); }
      else if (item.kind === 'loop') collect(item.steps, depth + 1);
    }
  };
  collect(steps, 0);
  if (tooMany) fatal(`步骤总数（含分支与循环体）不能超过 ${SCRIPT_LIMITS.maxSteps} 个。`);
  if (tooDeep) fatal(`if / loop 嵌套不能超过 ${SCRIPT_LIMITS.maxDepth} 层。`);
  for (const label of duplicatedLabels) fatal(`label 重复定义：「${label}」，goto 无法确定跳到哪一个。`);

  const templateIds = options.availableTemplateIds ? new Set(options.availableTemplateIds) : null;
  const scriptPackage = typeof raw.packageName === 'string' ? raw.packageName : undefined;
  let usesTemplate = false;

  const checkRect = (stepId: string, what: string, value: unknown): void => {
    if (value === undefined) return;
    if (!isRect(value)) { fatal(`${what} 必须是 { x, y, w, h }。`, stepId); return; }
    if (value.w <= 0 || value.h <= 0) { error(`${what} 的宽高必须为正数。`, stepId); return; }
    if (refW && refH && (value.x < 0 || value.y < 0 || value.x + value.w > refW || value.y + value.h > refH)) {
      error(`${what} 超出参考分辨率范围（${value.x},${value.y} ${value.w}x${value.h} 不在 ${refW}x${refH} 内）。`, stepId);
    }
  };
  const checkPoint = (stepId: string, what: string, value: unknown): void => {
    if (!isPoint(value)) { fatal(`${what}坐标必须是 { x, y }。`, stepId); return; }
    if (refW && refH && (value.x < 0 || value.y < 0 || value.x > refW || value.y > refH)) {
      warn(`${what}坐标 (${value.x}, ${value.y}) 落在 ${refW}x${refH} 画面之外，点击会无效。`, stepId);
    }
  };
  const checkTemplate = (stepId: string, id: unknown): void => {
    usesTemplate = true;
    if (id === '') { fatal('还没选模板（模板 id 为空）：选一张模板，或删掉这一块再保存。', stepId); return; }
    if (typeof id !== 'string' || !TEMPLATE_ID.test(id)) { fatal('模板 id 格式无效。', stepId); return; }
    if (templateIds && !templateIds.has(id)) error(`引用了模板集里不存在的模板：「${id}」。`, stepId);
  };
  const checkThreshold = (stepId: string, value: unknown): void => {
    if (value === undefined) return;
    if (!isNumber(value)) fatal('匹配阈值必须是数字。', stepId);
    else if (value < 0 || value > 1) error('匹配阈值必须在 0 到 1 之间。', stepId);
  };
  const checkPoll = (stepId: string, value: unknown): void => {
    if (value === undefined) return;
    if (!isNumber(value)) fatal('pollMs 必须是数字。', stepId);
    else if (value <= 0) error('pollMs 必须为正数。', stepId);
  };
  const checkWait = (stepId: string, value: unknown, required: boolean): number | undefined => {
    if (value === undefined) { if (required) fatal('waitMs 必须是毫秒数。', stepId); return undefined; }
    if (!isNumber(value) || value < 0) { fatal('waitMs 必须是非负毫秒数。', stepId); return undefined; }
    if (value > SCRIPT_LIMITS.maxWaitMs) error(`等待时长不能超过 ${SCRIPT_LIMITS.maxWaitMs / 60_000} 分钟。`, stepId);
    return value;
  };
  const checkCondition = (stepId: string, cond: unknown, what: string, depth = 0): void => {
    if (!isObject(cond)) { fatal(`${what}格式无效。`, stepId); return; }
    if (depth > SCRIPT_LIMITS.maxDepth) { fatal(`${what}嵌套超过 ${SCRIPT_LIMITS.maxDepth} 层。`, stepId); return; }
    switch (cond.kind) {
      case 'always': case 'never': return;
      case 'template':
        checkTemplate(stepId, cond.templateId);
        checkRect(stepId, `${what}的 ROI`, cond.roi);
        checkThreshold(stepId, cond.threshold);
        if (cond.present !== undefined && typeof cond.present !== 'boolean') fatal('present 必须是 true 或 false。', stepId);
        return;
      case 'anyTemplate':
        if (!Array.isArray(cond.templateIds) || !cond.templateIds.length || cond.templateIds.length > SCRIPT_LIMITS.maxAnyTemplates) {
          fatal(`任一模板条件需要 1–${SCRIPT_LIMITS.maxAnyTemplates} 个模板 id。`, stepId);
        } else for (const id of cond.templateIds as unknown[]) checkTemplate(stepId, id);
        checkRect(stepId, `${what}的 ROI`, cond.roi);
        checkThreshold(stepId, cond.threshold);
        return;
      case 'foreground':
        if (typeof cond.packageName !== 'string' || !PACKAGE.test(cond.packageName)) fatal('前台条件的包名格式无效。', stepId);
        else if (expected && cond.packageName !== expected) fatal(`前台条件只能检查当前游戏（${expected}）。`, stepId);
        if (cond.equals !== undefined && typeof cond.equals !== 'boolean') fatal('equals 必须是 true 或 false。', stepId);
        return;
      case 'and': case 'or': {
        const items = cond.kind === 'and' ? cond.all : cond.any;
        if (!Array.isArray(items) || !items.length || items.length > SCRIPT_LIMITS.maxConditionItems) {
          fatal(`组合条件需要 1–${SCRIPT_LIMITS.maxConditionItems} 个子条件。`, stepId);
          return;
        }
        for (const item of items as unknown[]) checkCondition(stepId, item, what, depth + 1);
        return;
      }
      case 'not': checkCondition(stepId, cond.of, what, depth + 1); return;
      default: fatal(`${what}的类型不受支持：${String(cond.kind)}。`, stepId);
    }
  };
  const checkPackage = (stepId: string, value: unknown): void => {
    if (value === undefined) {
      if (!scriptPackage && !expected) error('既没给步骤 packageName，脚本也没设 packageName，无法确定要操作哪个应用。', stepId);
      return;
    }
    if (typeof value !== 'string' || !PACKAGE.test(value)) fatal('步骤包名格式无效。', stepId);
    else if (expected && value !== expected) fatal(`脚本不能启动或停止其他应用（只允许 ${expected}）。`, stepId);
  };
  const delay = (stepId: string, value: unknown, label: string): void => {
    if (value === undefined) return;
    if (!isNumber(value) || value < 0) fatal(`${label}必须是非负毫秒数。`, stepId);
    else if (value > SCRIPT_LIMITS.maxDelayMs) error(`${label}不能超过 ${SCRIPT_LIMITS.maxDelayMs / 1000} 秒。`, stepId);
  };
  const checkText = (stepId: string, text: string): void => {
    for (const key of placeholderKeys(text)) {
      if (!declared.has(key)) warn(`文本引用了未声明的参数「{{${key}}}」；没有传入时会原样保留。`, stepId);
    }
  };

  // ── Pass 2: every step, with goto scopes ──
  const visit = (list: unknown, scopes: ReadonlyArray<ReadonlySet<string>>, depth: number): void => {
    if (!Array.isArray(list) || depth > SCRIPT_LIMITS.maxDepth) return;
    const local = new Set<string>();
    for (const item of list as unknown[]) if (isObject(item) && item.kind === 'label' && typeof item.label === 'string') local.add(item.label);
    const scope = [...scopes, local];
    const visible = (label: string): boolean => scope.some((set) => set.has(label));

    for (const item of list as unknown[]) {
      if (!isObject(item)) { fatal('步骤必须是对象。'); continue; }
      if (typeof item.id !== 'string' || !SCRIPT_ID.test(item.id)) { fatal('步骤 id 只能包含字母、数字、点、下划线和短横线。'); continue; }
      const id = item.id;
      if (!STEP_KINDS.includes(item.kind as ScriptStep['kind'])) { fatal(`步骤类型不受支持：${String(item.kind)}。`, id); continue; }
      if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 120)) fatal('步骤名称必须是文本（最长 120 个字符）。', id);
      if (item.when !== undefined) checkCondition(id, item.when, 'when 条件');
      if (item.timeoutMs !== undefined) {
        if (!isNumber(item.timeoutMs)) fatal('timeoutMs 必须是毫秒数。', id);
        else if (item.timeoutMs < SCRIPT_LIMITS.minTimeoutMs || item.timeoutMs > SCRIPT_LIMITS.maxTimeoutMs) {
          error(`步骤超时应为 ${SCRIPT_LIMITS.minTimeoutMs}–${SCRIPT_LIMITS.maxTimeoutMs} 毫秒。`, id);
        }
      }
      if (item.retry !== undefined) {
        if (!isInteger(item.retry) || (item.retry as number) < 0) fatal('retry 必须是非负整数。', id);
        else if ((item.retry as number) > SCRIPT_LIMITS.maxRetry) error(`retry 不能超过 ${SCRIPT_LIMITS.maxRetry}。`, id);
        else if ((item.retry as number) > SCRIPT_LIMITS.warnRetry) warn(`retry=${String(item.retry)} 偏大，失败时会长时间卡住这一步。`, id);
      }
      delay(id, item.retryDelayMs, '重试间隔');
      delay(id, item.afterDelayMs, '步骤后等待');
      if (item.capture !== undefined && typeof item.capture !== 'boolean') fatal('capture 必须是 true 或 false。', id);
      if (item.onFail !== undefined) {
        const policy = item.onFail;
        if (!isObject(policy) || !['abort', 'continue', 'goto', 'restartApp'].includes(String(policy.kind))) fatal('失败处置（onFail）无效。', id);
        else if (policy.kind === 'goto') {
          if (typeof policy.label !== 'string' || !policy.label.trim()) fatal('onFail=goto 需要目标 label。', id);
          else if (!visible(policy.label)) {
            fatal(`onFail 要跳到 label「${policy.label}」，但它不在当前作用域里（只能跳到同级或外层的 label）。`, id);
          }
        } else if (policy.kind === 'restartApp' && !scriptPackage && !expected) {
          error('onFail=restartApp 需要脚本头部设置 packageName，否则不知道该重启哪个应用。', id);
        }
      }

      switch (item.kind) {
        case 'tap': checkPoint(id, '点击', item.at); break;
        case 'tapTemplate': {
          checkTemplate(id, item.templateId);
          checkRect(id, 'ROI', item.roi);
          checkThreshold(id, item.threshold);
          if (item.offset !== undefined && !isPoint(item.offset)) fatal('偏移必须是 { x, y }。', id);
          const wait = checkWait(id, item.waitMs, false);
          if ((wait ?? 0) > 0) checkPoll(id, item.pollMs);
          else if (item.pollMs !== undefined && !isNumber(item.pollMs)) fatal('pollMs 必须是数字。', id);
          break;
        }
        case 'waitFor': {
          checkCondition(id, item.cond, '等待条件');
          const wait = checkWait(id, item.waitMs, true);
          if (wait === 0) warn('waitMs=0，等于只看一帧就判定。', id);
          checkPoll(id, item.pollMs);
          break;
        }
        case 'swipe':
          checkPoint(id, '滑动起点', item.from);
          checkPoint(id, '滑动终点', item.to);
          if (item.durationMs !== undefined) {
            if (!isNumber(item.durationMs)) fatal('滑动时长必须是毫秒数。', id);
            else if (item.durationMs <= 0 || item.durationMs > SCRIPT_LIMITS.maxSwipeMs) error(`滑动时长应为 1–${SCRIPT_LIMITS.maxSwipeMs} 毫秒。`, id);
          }
          break;
        case 'longPress':
          checkPoint(id, '长按', item.at);
          if (!isNumber(item.durationMs)) fatal('长按时长必须是毫秒数。', id);
          else if (item.durationMs <= 0 || item.durationMs > SCRIPT_LIMITS.maxLongPressMs) error(`长按时长应为 1–${SCRIPT_LIMITS.maxLongPressMs} 毫秒。`, id);
          else if (item.durationMs > SCRIPT_LIMITS.warnLongPressMs) warn('长按超过 10 秒，确认不是笔误？', id);
          break;
        case 'text':
          if (typeof item.text !== 'string') { fatal('text 必须是文本。', id); break; }
          if (item.text.length > SCRIPT_LIMITS.maxText) error(`输入文本不能超过 ${SCRIPT_LIMITS.maxText} 个字符。`, id);
          if (item.text.length === 0) warn('要输入的文本为空。', id);
          if (!options.unicodeInput && NON_ASCII.test(item.text)) {
            warn('文本含非 ASCII 字符（如中文），必须先在该实例上安装并启用 ADBKeyboard 输入法（执行监控页「安装输入法」），否则执行到这一步会失败。', id);
          }
          checkText(id, item.text);
          break;
        case 'key': if (!ANDROID_KEYS.includes(item.key as never)) fatal(`按键不受支持：${String(item.key)}。`, id); break;
        case 'sleep':
          if (!isNumber(item.ms) || item.ms < 0) fatal('sleep 需要非负毫秒数 ms。', id);
          else if (item.ms > SCRIPT_LIMITS.maxSleepMs) error(`单次等待不能超过 ${SCRIPT_LIMITS.maxSleepMs / 60_000} 分钟。`, id);
          break;
        case 'launchApp':
          checkPackage(id, item.packageName);
          if (item.cold !== undefined && typeof item.cold !== 'boolean') fatal('cold 必须是 true 或 false。', id);
          break;
        case 'stopApp': checkPackage(id, item.packageName); break;
        case 'screenshot':
          if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 80)) fatal('截图标签必须是文本（最长 80 个字符）。', id);
          break;
        case 'log':
          if (!LOG_LEVELS.includes(item.level as never)) fatal('日志级别只能是 debug / info / warn / error。', id);
          if (typeof item.message !== 'string') fatal('日志内容必须是文本。', id);
          else {
            if (item.message.length > SCRIPT_LIMITS.maxText) error(`日志内容不能超过 ${SCRIPT_LIMITS.maxText} 个字符。`, id);
            checkText(id, item.message);
          }
          break;
        case 'label': if (!isText(item.label, 96)) fatal('label 不能为空（最长 96 个字符）。', id); break;
        case 'goto':
          if (!isText(item.label, 96)) { fatal('goto 需要目标 label。', id); break; }
          if (!visible(item.label)) {
            fatal(allLabels.has(item.label)
              ? `goto 目标 label「${item.label}」在别的分支/循环体内，跳不过去（只能跳到同级或外层）。`
              : `goto 目标 label「${item.label}」不存在。`, id);
          }
          if (item.maxTimes !== undefined) {
            if (!isNumber(item.maxTimes)) fatal('maxTimes 必须是数字。', id);
            else if (item.maxTimes <= 0 || !Number.isInteger(item.maxTimes)) error('maxTimes 必须为正整数。', id);
            else if (item.maxTimes > SCRIPT_LIMITS.maxGotoTimes) error(`maxTimes 不能超过 ${SCRIPT_LIMITS.maxGotoTimes}。`, id);
          }
          break;
        case 'if':
          checkCondition(id, item.cond, 'if 条件');
          if (!Array.isArray(item.then)) { fatal('if 的 then 必须是步骤数组。', id); break; }
          if (item.else !== undefined && !Array.isArray(item.else)) { fatal('if 的 else 必须是步骤数组。', id); break; }
          if (item.then.length === 0 && ((item.else as unknown[] | undefined)?.length ?? 0) === 0) warn('if 的两个分支都是空的。', id);
          visit(item.then, scope, depth + 1);
          if (item.else) visit(item.else, scope, depth + 1);
          break;
        case 'loop': {
          if (!Array.isArray(item.steps)) { fatal('循环体 steps 必须是步骤数组。', id); break; }
          if (item.repeat !== undefined && (!isInteger(item.repeat) || (item.repeat as number) < 0)) fatal('repeat 必须是非负整数。', id);
          if (item.maxIterations !== undefined) {
            if (!isInteger(item.maxIterations) || (item.maxIterations as number) <= 0) fatal('maxIterations 必须是正整数。', id);
            else if ((item.maxIterations as number) > SCRIPT_LIMITS.maxIterations) error(`maxIterations 不能超过 ${SCRIPT_LIMITS.maxIterations}。`, id);
          }
          const cap = isInteger(item.maxIterations) ? item.maxIterations as number : 1000;
          if (item.repeat === undefined && item.while === undefined) {
            warn(`循环既没设 repeat 也没设 while，会一直跑到硬上限 ${cap} 次后判定失败。`, id);
          } else if (isInteger(item.repeat) && (item.repeat as number) > cap) {
            warn(`repeat=${String(item.repeat)} 超过硬上限 ${cap}，循环会在第 ${cap} 次时判定失败。`, id);
          }
          if (item.while !== undefined) checkCondition(id, item.while, 'loop 的 while 条件');
          if (item.steps.length === 0) warn('循环体是空的。', id);
          visit(item.steps, scope, depth + 1);
          break;
        }
      }
    }
  };
  visit(steps, [], 0);

  if (usesTemplate && raw.templateSetId === undefined) {
    warn('脚本用到了模板匹配，但没有绑定 templateSetId：运行时使用实例当前配置的模板集，换了模板集可能找不到模板。');
  }
  if (raw.loop === true) {
    const gap = isNumber(raw.loopIntervalMs) ? raw.loopIntervalMs : 0;
    if (gap < SCRIPT_LIMITS.minLoopIntervalMs) error('循环模式下每轮间隔不能小于 1 秒（loopIntervalMs ≥ 1000，建议不低于 3000）。');
    else if (gap > SCRIPT_LIMITS.maxLoopIntervalMs) error('循环模式下每轮间隔不能超过 24 小时。');
    else if (gap < 3000) warn('循环模式下每轮间隔小于 3 秒，会让 adb 一直满负荷；建议不低于 3000ms。');
  }
  return issues;
}

/** Issues that make a document unusable as a script (save and load refuse it). */
export function fatalIssues(issues: readonly ScriptIssue[]): ScriptIssue[] {
  return issues.filter((issue) => issue.level === 'error' && issue.fatal === true);
}

/** Issues that refuse execution (every error, fatal or not). */
export function blockingIssues(issues: readonly ScriptIssue[]): ScriptIssue[] {
  return issues.filter((issue) => issue.level === 'error');
}

/** The original's Chinese bullet list. */
export function formatIssues(issues: readonly ScriptIssue[]): string {
  return issues.map((issue) => `· [${issue.level === 'error' ? '错误' : '警告'}]${issue.stepId ? ` ${issue.stepId}:` : ''} ${issue.message}`).join('\n');
}

/** Depth-first visit of every step, including if / loop bodies. */
export function walkSteps(steps: readonly ScriptStep[], fn: (step: ScriptStep) => void): void {
  for (const step of steps) {
    fn(step);
    if (step.kind === 'if') { walkSteps(step.then, fn); if (step.else) walkSteps(step.else, fn); }
    else if (step.kind === 'loop') walkSteps(step.steps, fn);
  }
}

/** Every step, counting if / loop bodies (the original countSteps). */
export function countSteps(steps: readonly ScriptStep[]): number {
  let count = 0;
  walkSteps(steps, () => { count++; });
  return count;
}

export function conditionUsesTemplate(cond: Condition): boolean {
  switch (cond.kind) {
    case 'template': case 'anyTemplate': return true;
    case 'and': return cond.all.some(conditionUsesTemplate);
    case 'or': return cond.any.some(conditionUsesTemplate);
    case 'not': return conditionUsesTemplate(cond.of);
    default: return false;
  }
}

function conditionTemplateIds(cond: Condition, out: Set<string>): void {
  switch (cond.kind) {
    case 'template': out.add(cond.templateId); break;
    case 'anyTemplate': for (const id of cond.templateIds) out.add(id); break;
    case 'and': for (const item of cond.all) conditionTemplateIds(item, out); break;
    case 'or': for (const item of cond.any) conditionTemplateIds(item, out); break;
    case 'not': conditionTemplateIds(cond.of, out); break;
    default: break;
  }
}

/** Every template id a script can match, so the executor prepares exactly these once. */
export function referencedTemplateIds(script: Pick<ScriptDef, 'steps'>): string[] {
  const out = new Set<string>();
  walkSteps(script.steps, (step) => {
    if (step.when) conditionTemplateIds(step.when, out);
    if (step.kind === 'tapTemplate') out.add(step.templateId);
    else if (step.kind === 'waitFor') conditionTemplateIds(step.cond, out);
    else if (step.kind === 'if') conditionTemplateIds(step.cond, out);
    else if (step.kind === 'loop' && step.while) conditionTemplateIds(step.while, out);
  });
  return [...out];
}

/**
 * Whether the script may begin with the game off-screen (a cold-start prologue): the first step that actually
 * runs is a `launchApp`, or an `if` "the game is not in the foreground" whose then-branch starts that way (the
 * keep-alive pattern). Input stays guarded by the host (foreground re-check before every input).
 * `packageName` is the game package the foreground condition must name (default: the script's own).
 */
export function startsWithLaunch(script: Pick<ScriptDef, 'steps'> & { packageName?: string }, packageName?: string): boolean {
  return blockStartsWithLaunch(script.steps, packageName ?? script.packageName);
}

function blockStartsWithLaunch(steps: readonly ScriptStep[], packageName: string | undefined): boolean {
  const first = steps.find((step) => step.kind !== 'label' && step.kind !== 'log');
  if (!first || first.when !== undefined) return false;
  if (first.kind === 'launchApp') return true;
  return first.kind === 'if' && !!packageName && gameMissing(first.cond, packageName) && blockStartsWithLaunch(first.then, packageName);
}

/** `not foreground(pkg)` or `foreground(pkg, equals: false)`. */
function gameMissing(cond: Condition, packageName: string): boolean {
  if (cond.kind === 'not') return cond.of.kind === 'foreground' && cond.of.packageName === packageName && (cond.of.equals ?? true);
  return cond.kind === 'foreground' && cond.packageName === packageName && cond.equals === false;
}

/** Light metadata for lists. */
export function scriptMeta(script: ScriptDef, builtin = false): ScriptMeta {
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    version: script.version,
    packageName: script.packageName,
    templateSetId: script.templateSetId,
    stepCount: countSteps(script.steps),
    updatedAt: script.updatedAt,
    builtin,
    loop: script.loop === true,
  };
}
