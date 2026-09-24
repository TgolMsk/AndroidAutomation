/**
 * `{{ key }}` parameter interpolation (ported from wanlong-panel `RunContext.interpolate`).
 *
 * Whitespace inside the braces is allowed and keys match `[A-Za-z0-9_.-]`. Unknown keys are left exactly as
 * written, so a typo stays visible in the log or on screen instead of silently becoming an empty string.
 */
import type { ScriptDef, ScriptParamValue } from './types.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function interpolate(text: string, params: Readonly<Record<string, ScriptParamValue>>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => {
    const value = Object.hasOwn(params, key) ? params[key] : undefined;
    return value === undefined ? whole : String(value);
  });
}

/** Parameter keys referenced by a text, in order of first appearance. */
export function placeholderKeys(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) if (!keys.includes(match[1]!)) keys.push(match[1]!);
  return keys;
}

/**
 * Parameter precedence of the original orchestrator: script defaults < account overrides < request.
 * Extra layers (e.g. a plan task's params) go between account and request, in order.
 */
export function mergeParams(
  script: Pick<ScriptDef, 'params'>,
  ...layers: Array<Readonly<Record<string, ScriptParamValue>> | null | undefined>
): Record<string, ScriptParamValue> {
  const out: Record<string, ScriptParamValue> = {};
  for (const param of script.params ?? []) if (param.default !== undefined) out[param.key] = param.default;
  for (const layer of layers) if (layer) Object.assign(out, layer);
  return out;
}
