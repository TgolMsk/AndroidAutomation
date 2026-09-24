/**
 * Vision constants: the single source for the engine, the template library, tplkit and the renderer.
 *
 * Published as `@avdm/automation/constants` for the renderer, so this module must stay free of runtime
 * imports (no sharp, OpenCV or Node built-ins; `test/pure-entries.test.ts` enforces it).
 */

/** Default downscale factor for UI templates (glyph sets use 1). */
export const DEFAULT_SHRINK = 2;

/** Default TM_CCOEFF_NORMED threshold when a template has none. */
export const DEFAULT_MATCH_THRESHOLD = 0.85;

/**
 * ★ Variance guard: a template whose grayscale std is below this is rejected. Flat or gradient crops make
 * TM_CCOEFF_NORMED return ~1.0 on ANY frame (two plain white templates scored 1.0000 @ (0,0) everywhere).
 * Real game icons measure 40–43.
 */
export const MIN_TEMPLATE_STD = 12;

/** The template page warns (σ badge) below MIN_TEMPLATE_STD × 1.5. */
export const LOW_TEMPLATE_STD_WARNING = MIN_TEMPLATE_STD * 1.5;

/** Transparent-background masks need at least this many opaque pixels after shrinking … */
export const MIN_MASK_PIXELS = 64;
/** … and at least this opaque fraction. A fully transparent mask is rejected too. */
export const MIN_MASK_COVERAGE = 0.1;

/** Multi-frame background removal: a pixel is "unchanged" when every RGB channel differs by at most this. */
export const DEFAULT_ALPHA_DIFF_TOLERANCE = 24;
/** The template page clamps the tolerance to this range. */
export const ALPHA_TOLERANCE_RANGE = { min: 4, max: 96 } as const;
/** The template page takes 1–3 extra frames besides the main frame. */
export const MAX_DIFF_FRAMES = 3;
/** The template page requires at least this crop edge in frame pixels. */
export const MIN_TEMPLATE_CROP = 8;

/** A fixed template id typed in the template page (the library itself also allows dots, up to 96 chars). */
export const TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
