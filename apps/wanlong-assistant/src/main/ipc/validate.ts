import { asIndex } from '@avdm/emulator-shell/main/util';
import { gamePlugin } from '../automation/games';

/** Renderer arguments are untrusted; handler-level messages end in 「无效」. */
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}无效`);
  return value.trim();
}

/** A registered game id. */
export function game(value: unknown): string {
  const id = text(value, '游戏 ID');
  gamePlugin(id);
  return id;
}

export function optionalIndex(value: unknown): number | null {
  return value === null ? null : asIndex(value);
}

/** A plain object patch (not an array or null). */
export function patchObject<T extends object>(value: T, label: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}无效`);
  return value;
}

export function flag(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}无效`);
  return value;
}

export { asIndex };
