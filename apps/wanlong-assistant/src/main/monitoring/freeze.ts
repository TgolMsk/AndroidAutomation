import type { RawFrame } from '@avdm/automation';

export const DIGEST_COLS = 96;
export const DIGEST_ROWS = 54;
const MAX_CHANGED_CELLS = 2;
const CELL_DIFF_TOLERANCE = 8;

export interface FreezeThresholds {
  staticMinutes: number;
  minStaticFrames: number;
  minCaptureFailures: number;
}

export const DEFAULT_FREEZE_THRESHOLDS: Readonly<FreezeThresholds> = {
  staticMinutes: 5,
  minStaticFrames: 4,
  minCaptureFailures: 3,
};

export interface FrameDigest {
  width: number;
  height: number;
  cells: Uint8Array;
}

export interface FreezeEvidence {
  staticForMs: number;
  staticFrames: number;
  captureFailures: number;
  captureFailingForMs: number;
  lastFrameAt: number | null;
}

export type FreezeVerdict = {
  kind: 'static' | 'capture';
  message: string;
  evidence: FreezeEvidence;
};

interface Track {
  digest: FrameDigest | null;
  staticSince: number | null;
  staticFrames: number;
  lastFrameAt: number | null;
  captureFailures: number;
  failingSince: number | null;
  reportedStatic: boolean;
  reportedCapture: boolean;
}

function scope(gameId: string, index: number): string { return `${gameId}:${index}`; }

function fresh(): Track {
  return {
    digest: null, staticSince: null, staticFrames: 0, lastFrameAt: null,
    captureFailures: 0, failingSince: null, reportedStatic: false, reportedCapture: false,
  };
}

export function frameDigest(frame: RawFrame): FrameDigest {
  const { width, height, data } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      data.byteLength !== width * height * 4) throw new Error('画面像素格式无效');
  const cells = new Uint8Array(DIGEST_COLS * DIGEST_ROWS);
  for (let y = 0; y < DIGEST_ROWS; y++) {
    const py = Math.min(height - 1, Math.floor(((y + 0.5) * height) / DIGEST_ROWS));
    for (let x = 0; x < DIGEST_COLS; x++) {
      const px = Math.min(width - 1, Math.floor(((x + 0.5) * width) / DIGEST_COLS));
      const offset = (py * width + px) * 4;
      cells[y * DIGEST_COLS + x] = (77 * data[offset]! + 150 * data[offset + 1]! + 29 * data[offset + 2]!) >> 8;
    }
  }
  return { width, height, cells };
}

export function changedCells(a: FrameDigest, b: FrameDigest): number {
  if (a.width !== b.width || a.height !== b.height) return a.cells.length;
  let changed = 0;
  for (let i = 0; i < a.cells.length; i++) {
    if (Math.abs(a.cells[i]! - b.cells[i]!) > CELL_DIFF_TOLERANCE) changed++;
  }
  return changed;
}

/** Read-only pixel and capture failure detector. A verdict never restarts an emulator. */
export class FreezeGuard {
  private readonly tracks = new Map<string, Track>();
  readonly thresholds: Readonly<FreezeThresholds>;

  constructor(thresholds: Partial<FreezeThresholds> = {}) {
    this.thresholds = { ...DEFAULT_FREEZE_THRESHOLDS, ...thresholds };
    for (const [name, value] of Object.entries(this.thresholds)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) throw new Error(`${name} 阈值无效`);
    }
  }

  reset(gameId: string, index: number): void { this.tracks.delete(scope(gameId, index)); }

  private track(gameId: string, index: number): Track {
    const key = scope(gameId, index);
    let t = this.tracks.get(key);
    if (!t) { t = fresh(); this.tracks.set(key, t); }
    return t;
  }

  observe(gameId: string, index: number, frame: RawFrame, at: number): FreezeVerdict | null {
    const t = this.track(gameId, index);
    const digest = frameDigest(frame);
    t.captureFailures = 0;
    t.failingSince = null;
    t.reportedCapture = false;
    t.lastFrameAt = at;
    if (!t.digest || changedCells(t.digest, digest) > MAX_CHANGED_CELLS) {
      t.digest = digest;
      t.staticSince = at;
      t.staticFrames = 1;
      t.reportedStatic = false;
      return null;
    }
    t.digest = digest;
    t.staticFrames += 1;
    const duration = at - (t.staticSince ?? at);
    if (t.reportedStatic || t.staticFrames < this.thresholds.minStaticFrames ||
        duration < this.thresholds.staticMinutes * 60_000) return null;
    t.reportedStatic = true;
    const evidence = this.evidence(gameId, index, at);
    return { kind: 'static', message: `游戏前台画面连续 ${t.staticFrames} 次几乎完全相同，跨度 ${Math.floor(duration / 60_000)} 分钟；疑似卡死，请检查。`, evidence };
  }

  /** Call only for a confirmed screencap/ADB failure while emulator process is running. */
  captureFailed(gameId: string, index: number, at: number): FreezeVerdict | null {
    const t = this.track(gameId, index);
    t.captureFailures += 1;
    t.failingSince ??= at;
    const duration = at - t.failingSince;
    if (t.reportedCapture || t.captureFailures < this.thresholds.minCaptureFailures ||
        duration < this.thresholds.staticMinutes * 60_000) return null;
    t.reportedCapture = true;
    return { kind: 'capture', message: `模拟器进程仍在，但连续 ${t.captureFailures} 次无法截图，跨度 ${Math.floor(duration / 60_000)} 分钟；请检查 ADB 和实例状态。`,
      evidence: this.evidence(gameId, index, at) };
  }

  evidence(gameId: string, index: number, at: number): FreezeEvidence {
    const t = this.tracks.get(scope(gameId, index));
    return {
      staticForMs: t?.staticSince === null || !t ? 0 : Math.max(0, at - t.staticSince),
      staticFrames: t?.staticFrames ?? 0,
      captureFailures: t?.captureFailures ?? 0,
      captureFailingForMs: t?.failingSince === null || !t ? 0 : Math.max(0, at - t.failingSince),
      lastFrameAt: t?.lastFrameAt ?? null,
    };
  }
}
