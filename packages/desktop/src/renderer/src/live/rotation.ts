import type { DisplayRotation } from '../../../shared/ipc';

/** Size of the picture after turning a `width`×`height` panel image by `rotation` quarter turns. */
export function uprightSize(width: number, height: number, rotation: DisplayRotation = 0): { width: number; height: number } {
  return rotation % 2 ? { width: height, height: width } : { width, height };
}

/**
 * Map a point of the upright picture, given as fractions (u, v) ∈ [0, 1] of its width/height, to panel
 * pixels (the coordinate space of gRPC sendTouch). When Android rotates, frames stay panel-native with the
 * UI drawn sideways, and so do touches: rotation 1 (ROTATION_90) turns logical (x, y) of a W×H panel into
 * panel (W − y, x) — verified on a real 720×1280 emulator, where logical (310, 606) hit panel (114, 310).
 */
export function uprightToPanel(
  u: number,
  v: number,
  rotation: DisplayRotation,
  panelWidth: number,
  panelHeight: number,
): { x: number; y: number } {
  const cu = Math.min(Math.max(u, 0), 1);
  const cv = Math.min(Math.max(v, 0), 1);
  let px: number;
  let py: number;
  switch (rotation) {
    case 1:
      px = 1 - cv;
      py = cu;
      break;
    case 2:
      px = 1 - cu;
      py = 1 - cv;
      break;
    case 3:
      px = cv;
      py = 1 - cu;
      break;
    default:
      px = cu;
      py = cv;
  }
  return {
    x: Math.min(Math.max(Math.round(px * panelWidth), 0), Math.max(0, panelWidth - 1)),
    y: Math.min(Math.max(Math.round(py * panelHeight), 0), Math.max(0, panelHeight - 1)),
  };
}

/**
 * Canvas transform (a, b, c, d, e, f for setTransform) that draws a `width`×`height` panel image upright,
 * i.e. turned counter-clockwise by `rotation` quarter turns — the inverse of uprightToPanel.
 */
export function uprightTransform(
  rotation: DisplayRotation,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  switch (rotation) {
    case 1:
      return [0, -1, 1, 0, 0, width];
    case 2:
      return [-1, 0, 0, -1, width, height];
    case 3:
      return [0, 1, -1, 0, height, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}
