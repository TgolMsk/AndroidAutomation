/**
 * What a failed device operation may say once it leaves the runner. Everything the runner forwards becomes the
 * step error, which the engine writes into warn / error lines (events.ndjson, the `run-logs` push, the run
 * snapshot, PlanRun.message in plans.json) and hands to the AI advisor as the consult `reason`.
 *
 * core's adb errors carry the whole command line (`<adb> -s emulator-5554 shell input text <text> 失败: …`, and
 * Node's `Command failed: <same line>`), so without this a failed text step would persist the typed text (or its
 * base64 on the ADBKeyboard path) and every failed op would persist the device serial. Rules:
 *  · text / longPress: a fixed Chinese message with the length and a classified reason, never any command output
 *    (the original only ever logged 「输入文本（N 字）」);
 *  · every other op: the adb command prefix and `Command failed:` lines are cut, serials are replaced;
 *  · messages the runner wrote itself (RunnerMessageError, ExecutionGuardError) pass through unchanged.
 */
import { isExecutionGuardError } from '@avdm/automation';

/** A message composed by the runner from safe parts (package names, indices, fixed text). */
export class RunnerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerMessageError';
  }
}

const MAX_DETAIL = 300;
/** Runner / service messages (template lists, validation summaries) may be long; only runaway output is cut. */
const MAX_MESSAGE = 2000;
const SERIAL = /\b(?:emulator-\d+|(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+)\b/gi;

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a device call failed, as a fixed phrase (no command output). */
export function deviceFailureReason(error: unknown): string {
  const text = rawMessage(error).toLowerCase();
  if (/device offline|device '.*' not found|device not found|no devices|unauthorized|connection reset|closed/.test(text)) return '模拟器连接已断开';
  if (/timed? ?out|etimedout|killed|sigterm|超时/.test(text)) return '设备响应超时';
  return '设备命令执行失败';
}

/** Cut adb command lines, `Command failed:` lines, serials and the given secrets out of a message. */
export function scrubDeviceMessage(message: string, secrets: readonly string[] = [], maxLength = MAX_DETAIL): string {
  let text = message;
  for (const secret of secrets) if (secret) text = text.split(secret).join('…');
  // core: `${adb} ${args.join(' ')} 失败: ${detail}` — keep only the detail when the prefix is an adb call.
  const prefixed = /^([\s\S]*?)\s失败[:：]\s*([\s\S]*)$/.exec(text);
  if (prefixed && /(?:^|[\s/\\])adb(?:\.exe)?\s|\s-s\s/.test(prefixed[1]!)) text = `adb 命令失败：${prefixed[2]}`;
  text = text.replace(/Command failed:[^\n]*/g, '');
  text = text.replace(SERIAL, '模拟器');
  text = text.replace(/\s*\n\s*/g, '；').replace(/\s{2,}/g, ' ').replace(/([：；])[；\s]+/g, '$1').replace(/^[；\s]+|[；\s]+$/g, '').replace(/：$/, '');
  if (!text) return '设备命令执行失败';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** The message forwarded to the worker for a failed device request. */
export function forwardedDeviceError(op: string, error: unknown, args: readonly unknown[] = []): string {
  if (error instanceof RunnerMessageError || isExecutionGuardError(error)) return scrubDeviceMessage(rawMessage(error));
  if (op === 'text') {
    const value = typeof args[0] === 'string' ? args[0] : '';
    // planInputText rejections are fixed texts (no content); anything else is the device's answer to a command
    // line that contains the text.
    const code = (error as { code?: unknown })?.code;
    const reason = code === 'INVALID_ARGUMENT' ? scrubDeviceMessage(rawMessage(error), [value]) : deviceFailureReason(error);
    return `输入文本失败（${value.length} 字）：${reason}`;
  }
  if (op === 'longPress') return `长按失败：${deviceFailureReason(error)}`;
  return scrubDeviceMessage(rawMessage(error));
}

/** Any other runner / service message (start gate, identity checks, plan run results) with serials and commands removed. */
export function safeErrorMessage(error: unknown): string {
  return scrubDeviceMessage(rawMessage(error), [], MAX_MESSAGE);
}
