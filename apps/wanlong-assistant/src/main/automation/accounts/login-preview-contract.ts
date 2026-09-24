/**
 * Messages between the main process and `login-preview-worker`. Kept apart from `login-preview.ts` so the worker
 * bundle never shares a chunk with the main-side encoder, which resolves the worker file next to its own module.
 */
export interface LoginPreviewRequest {
  id: number;
  width: number;
  height: number;
  /** RGBA pixels of the screencap (transferred). */
  data: Uint8Array;
  maxWidth: number;
  quality: number;
}

export type LoginPreviewResponse =
  | { id: number; ok: true; jpeg: Uint8Array; width: number; height: number }
  | { id: number; ok: false };
