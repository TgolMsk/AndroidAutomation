import sharp from 'sharp';
import { AppError, type RawFrame, type SerializedError, type TemplateSet } from '@avdm/automation';
import { gatherTemplateCoverage } from '@avdm/automation/wanlong';
import type { TemplateCompileFailure, TemplateCoverage, TemplatesChange } from '../../shared/ipc';

export type TemplatesChangeListener = (change: TemplatesChange) => void;

/**
 * Template-content change notifications (save / delete / import). Compiled-template caches (a long-lived vision
 * worker, the scheduler's sampler, resource units, AI harvest) subscribe and drop what they compiled from
 * `change.directory`. A failing listener never breaks the edit that triggered it.
 */
export class TemplateChangeFeed {
  private readonly listeners = new Set<TemplatesChangeListener>();

  on(listener: TemplatesChangeListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  emit(change: TemplatesChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(change); }
      catch (error) { console.error('[wanlong] 模板变更通知处理失败', error); }
    }
  }
}

/** Rebuild a coded error from a worker's serialized failure, so the IPC envelope keeps its code. */
export function workerError(error: SerializedError): AppError {
  return new AppError(error.code, error.message);
}

/**
 * What the instance's template set still lacks for this game. Only Wanlong defines gather template lists; other
 * games report no missing ids (the compile failures still apply).
 */
export function buildTemplateCoverage(gameId: string, set: TemplateSet, failed: TemplateCompileFailure[], compiled: boolean): TemplateCoverage {
  const base = gameId === 'wanlong'
    ? gatherTemplateCoverage(set.templates, failed)
    : { critical: [], optional: [], glyphs: [], ready: true };
  return { ...base, directory: set.directory, templateCount: set.templates.length, compiled, failed };
}

/**
 * A raw RGBA frame as a lossless PNG with exactly its pixels (template crops are cut from it, never from a JPEG).
 * A short or oversized buffer is rejected as CAPTURE_BAD_FRAME instead of letting sharp misread it.
 */
export async function rawFrameToPng(frame: RawFrame): Promise<Buffer> {
  const { width, height, data } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.byteLength !== width * height * 4) {
    throw new AppError('CAPTURE_BAD_FRAME', `截图数据长度 ${data.byteLength} 字节与 ${width}x${height}x4 不符，请重新截图`);
  }
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } }).png().toBuffer();
}
