/** After this long without a new frame the indicator says how long the picture has been unchanged. */
export const STATIC_DETAIL_AFTER_MS = 3000;

export interface FrameRateLabel {
  text: string;
  /** True when no frame arrived in the last second (the emulator only streams when the picture changes). */
  idle: boolean;
}

/**
 * Toolbar indicator for the live stream. The emulator pushes frames only when the screen changes, so a
 * static screen yields 0 fps; say so instead of showing a misleading "0 fps".
 */
export function frameRateLabel(fps: number, msSinceLastFrame: number): FrameRateLabel {
  if (fps > 0) return { text: `${fps} fps`, idle: false };
  if (!(msSinceLastFrame >= STATIC_DETAIL_AFTER_MS)) return { text: '画面静止', idle: true };
  const sec = Math.floor(msSinceLastFrame / 1000);
  if (sec < 60) return { text: `画面静止 · ${sec} 秒无变化`, idle: true };
  const min = Math.floor(sec / 60);
  if (min < 60) return { text: `画面静止 · ${min} 分钟无变化`, idle: true };
  return { text: `画面静止 · ${Math.floor(min / 60)} 小时无变化`, idle: true };
}
