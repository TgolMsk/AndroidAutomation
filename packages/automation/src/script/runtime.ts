/**
 * Script executor (needs vision): exported from the package root, never from the renderer-safe
 * `@avdm/automation/script` entry.
 */
export { ScriptContext, StepScope, sanitizeLabel, MIN_CAPTURE_INTERVAL_MS, CAPTURE_JITTER_MS } from './context.js';
export type { ScriptContextInit, ScriptDevicePort, ScriptShotPort, ScriptVisionPort } from './context.js';
export {
  ScriptEngine, expectedTemplateIds, statusText,
  DEFAULT_MAX_GOTO, DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_RESTARTS, DEFAULT_RETRY_DELAY_MS, MAX_BLOCK_STEPS, MIN_LOOP_INTERVAL_MS, RESTART_SETTLE_MS,
} from './engine.js';
export type { ScriptEngineOptions } from './engine.js';
export { evalCondition } from './conditions.js';
export type { CondResult } from './conditions.js';
export { execStep, DEFAULT_POLL_MS, DEFAULT_SWIPE_MS } from './actions.js';
export { RunLogger, LOG_FLUSH_INTERVAL_MS, LOG_MAX_BUFFER } from './logger.js';
export type { LogInput, RunLoggerOptions } from './logger.js';
export { ScriptError, ExecutionGuardError, isExecutionGuardError } from './errors.js';
export type { ScriptErrorCode } from './errors.js';
export { encodeTraceShot, warmUpVision, SHOT_WIDTH, SHOT_QUALITY } from './shots.js';
