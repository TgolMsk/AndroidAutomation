import type { GamePlugin, ProbeReport, RawFrame, ReadOnlyDevicePort, VisionPort } from './contracts.js';
import { loadTemplateSet, readTemplatePng } from './templates.js';
import { defaultVision } from './vision.js';

export interface ProbeOptions {
  device: ReadOnlyDevicePort;
  /** Directory containing a manifest.json and PNGs, chosen explicitly by the caller. */
  templateDir: string;
  plugin: GamePlugin;
  /** Defaults to plugin.probeAnchors. */
  templateIds?: readonly string[];
  threshold?: number;
  shrink?: number;
  signal?: AbortSignal;
  vision?: VisionPort;
  /** Consume the one captured frame, e.g. to show a preview, without taking a second screenshot. */
  onFrame?: (frame: RawFrame) => void | Promise<void>;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('识别探针已取消');
}

/** Capture once and test selected anchors. The device type only permits reads. */
export async function probeGame(options: ProbeOptions): Promise<ProbeReport> {
  const started = performance.now();
  const { device, plugin, signal } = options;
  const vision = options.vision ?? defaultVision;
  const ids = [...new Set(options.templateIds ?? plugin.probeAnchors)];
  if (ids.length === 0 || ids.length > 64) throw new Error('探针需选择 1 到 64 张模板');
  checkAbort(signal);
  const set = await loadTemplateSet(options.templateDir);
  if (set.packageName && set.packageName !== plugin.packageName) {
    throw new Error(`模板集属于 ${set.packageName}，与插件 ${plugin.packageName} 不匹配`);
  }
  const definitions = ids.map((id) => {
    const item = set.templates.find((template) => template.id === id);
    if (!item) throw new Error(`模板集 ${set.id} 缺少锚点 ${id}`);
    return item;
  });
  const shrink = options.shrink ?? 2;
  const prepared = [];
  for (const item of definitions) {
    checkAbort(signal);
    const png = await readTemplatePng(set, item.id);
    prepared.push(await vision.prepareTemplate(png, item, set, shrink));
  }
  const foregroundPackage = await device.foregroundPackage();
  checkAbort(signal);
  const captureStart = performance.now();
  const raw = await device.capture(signal);
  const captureEnd = performance.now();
  checkAbort(signal);
  await options.onFrame?.(raw);
  const frame = await vision.prepareFrame(raw, { refWidth: set.refWidth, refHeight: set.refHeight, shrink });
  const matchStart = performance.now();
  const matches = [];
  for (const template of prepared) {
    checkAbort(signal);
    matches.push(await vision.match(frame, template, { threshold: options.threshold }));
  }
  const ended = performance.now();
  return {
    gameId: plugin.id,
    packageName: plugin.packageName,
    foregroundPackage,
    foregroundMatches: foregroundPackage === plugin.packageName,
    templateSet: { id: set.id, name: set.name, refWidth: set.refWidth, refHeight: set.refHeight },
    frame: { width: raw.width, height: raw.height, capturedAt: raw.capturedAt },
    matches,
    timingMs: {
      capture: Math.round((captureEnd - captureStart) * 100) / 100,
      prepare: Math.round((matchStart - captureEnd + captureStart - started) * 100) / 100,
      match: Math.round((ended - matchStart) * 100) / 100,
      total: Math.round((ended - started) * 100) / 100,
    },
  };
}
