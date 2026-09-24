/** All coordinates exposed by the automation API use the template set's reference canvas. */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** A tightly packed RGBA8888 frame. Capture adapters must strip screencap row padding. */
export interface RawFrame {
  width: number;
  height: number;
  data: Uint8Array;
  capturedAt: number;
  format?: number;
}

/** The probe only receives read capabilities, so it cannot inject device input. */
export interface ReadOnlyDevicePort {
  capture(signal?: AbortSignal): Promise<RawFrame>;
  foregroundPackage(): Promise<string | null>;
}

export type AndroidKey = 'BACK' | 'HOME' | 'ENTER' | 'MENU' | 'APP_SWITCH' | 'DEL' | 'ESCAPE' | 'VOLUME_UP' | 'VOLUME_DOWN';

/** Game tasks use this per-instance port. The host resolves its current ADB serial. */
export interface DevicePort extends ReadOnlyDevicePort {
  tap(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  key(key: AndroidKey): Promise<void>;
  /** Wanlong must launch through monkey (AdbDevice.startApp without an activity), never `am start -n`. */
  launchApp(packageName: string, cold?: boolean): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  /** Optional: several taps in one device shell (device pixels), with a pause between them. */
  tapMany?(points: [number, number][], gapMs?: number): Promise<void>;
  /** Optional read-only process check (`pidof`); used only for launch diagnostics and health probes. */
  isAppRunning?(packageName: string): Promise<boolean>;
}

export interface TemplateDefinition {
  id: string;
  name: string;
  file: string;
  authoredWidth: number;
  authoredHeight: number;
  bounds: Rect;
  defaultRoi?: Rect;
  threshold?: number;
  tags?: string[];
  /** Grayscale std measured when saved (one decimal); the template page warns below 18. */
  std?: number;
  /** Opaque fraction 0..1 of a transparent-background template; absent for a plain template. */
  maskCoverage?: number;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TemplateSet {
  id: string;
  name: string;
  packageName?: string;
  refWidth: number;
  refHeight: number;
  templates: TemplateDefinition[];
  /** Absolute path explicitly selected by the caller; never inferred from a repository. */
  directory: string;
  updatedAt?: number;
}

export interface PreparedFrame {
  gray: Uint8Array;
  width: number;
  height: number;
  /** Compatibility names used by the migrated Wanlong state machine. */
  w: number;
  h: number;
  shrink: number;
  refWidth: number;
  refHeight: number;
  deviceWidth: number;
  deviceHeight: number;
  capturedAt: number;
}

export interface PreparedTemplate {
  id: string;
  name: string;
  gray: Uint8Array;
  width: number;
  height: number;
  w: number;
  h: number;
  refWidth: number;
  refHeight: number;
  refW: number;
  refH: number;
  shrink: number;
  threshold: number;
  defaultRoi?: Rect;
  mask?: Uint8Array;
  /** Opaque fraction of `mask` (three decimals); only for transparent-background templates. */
  maskCoverage?: number;
  std: number;
}

export interface MatchResult {
  templateId: string;
  found: boolean;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
  threshold: number;
  elapsedMs: number;
  reason?: string;
}

/** Options for one match. `roi` is in reference coordinates; without it the template's defaultRoi, else the full frame. */
export interface MatchOptions {
  roi?: Rect;
  threshold?: number;
}

/** One template of a batch match on a single prepared frame. */
export interface DetectSpec {
  templateId: string;
  roi?: Rect;
  threshold?: number;
}

export interface DetectResponse {
  capturedAt: number;
  deviceWidth: number;
  deviceHeight: number;
  /** Same order as the requested specs. */
  results: MatchResult[];
  timing: { captureMs: number; prepareMs: number; matchMs: number };
}

export interface VisionPort {
  prepareFrame(raw: RawFrame, options: { refWidth: number; refHeight: number; shrink?: number }): Promise<PreparedFrame>;
  prepareTemplate(image: Uint8Array, definition: TemplateDefinition, set: TemplateSet, shrink?: number): Promise<PreparedTemplate>;
  match(frame: PreparedFrame, template: PreparedTemplate, options?: { roi?: Rect; threshold?: number }): Promise<MatchResult>;
}

/** A game ships code and template IDs; template images stay in a user-selected directory. */
export interface GamePlugin {
  id: string;
  name: string;
  packageName: string;
  /** Reference canvas shared by templates and game coordinates. */
  referenceSize?: { width: number; height: number };
  probeAnchors: readonly string[];
}

export interface ProbeReport {
  gameId: string;
  packageName: string;
  foregroundPackage: string | null;
  foregroundMatches: boolean;
  templateSet: { id: string; name: string; refWidth: number; refHeight: number };
  frame: { width: number; height: number; capturedAt: number };
  matches: MatchResult[];
  timingMs: { capture: number; prepare: number; match: number; total: number };
}
