import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, TemplateLibrary, type RawFrame } from '@avdm/automation';
import { errorCode } from '@avdm/emulator-shell/main/util';
import { GATHER_CRITICAL_TEMPLATES, wanlongPlugin } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import { runTemplateJob } from '../src/main/automation/template-jobs';
import { rawFrameToPng, TemplateChangeFeed } from '../src/main/automation/template-tools';
import { templateDraft, templatesHandlers } from '../src/main/ipc/templates';
import type { ManagerHost } from '../src/main/manager-host';
import type { TemplatesChange } from '../src/shared/ipc';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

function frame(width: number, height: number, seed = 1): RawFrame {
  const data = new Uint8Array(width * height * 4);
  let value = seed;
  for (let i = 0; i < data.length; i += 4) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    data[i] = value & 0xff; data[i + 1] = (value >>> 8) & 0xff; data[i + 2] = (value >>> 16) & 0xff; data[i + 3] = 255;
  }
  return { width, height, data, capturedAt: 42 };
}

/** Blurred noise: per-pixel noise defeats cubic-vs-point sampling at shrink 2 (a known limit, see vision.ts). */
async function smoothFrame(width: number, height: number, seed: number): Promise<RawFrame> {
  const noise = frame(width, height, seed);
  const data = await sharp(Buffer.from(noise.data), { raw: { width, height, channels: 4 } }).blur(2).normalise().raw().toBuffer();
  return { width, height, data: new Uint8Array(data), capturedAt: 42 };
}

describe('template capture and change feed', () => {
  it('encodes a raw frame as a PNG with exactly its pixels and rejects a malformed frame', async () => {
    const raw = frame(64, 48);
    const png = await rawFrameToPng(raw);
    expect((await sharp(png).metadata()).format).toBe('png');
    expect(new Uint8Array(await sharp(png).ensureAlpha().raw().toBuffer())).toEqual(raw.data);
    await expect(rawFrameToPng({ ...raw, data: raw.data.subarray(4) })).rejects.toMatchObject({ code: 'CAPTURE_BAD_FRAME' });
  });

  it('isolates a failing listener and supports unsubscribe', () => {
    const feed = new TemplateChangeFeed();
    const seen: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    feed.on(() => { throw new Error('坏监听'); });
    const off = feed.on((change) => seen.push(change.directory));
    feed.emit({ gameId: 'wanlong', directory: '/a', reason: 'save', templateIds: ['x'], at: 1 });
    off();
    feed.emit({ gameId: 'wanlong', directory: '/b', reason: 'save', templateIds: ['x'], at: 2 });
    expect(seen).toEqual(['/a']);
    expect(error).toHaveBeenCalledTimes(2); // the throwing listener is still subscribed; it never blocks the others
    error.mockRestore();
  });
});

describe('AutomationHost template library', () => {
  let home: string;
  let host: AutomationHost;
  const raw = frame(256, 144, 9);
  const getState = vi.fn(async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }));
  const manager = {
    getState,
    device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw: async () => raw }),
  };
  const runner = { runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false) };

  beforeEach(async () => {
    broadcast.mockReset();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-template-host-'));
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never);
  });

  afterEach(async () => {
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('captures a lossless frame, saves with a fixed id, requires explicit overwrite and notifies changes', async () => {
    const changes: TemplatesChange[] = [];
    host.onTemplatesChanged((change) => changes.push(change));
    const set = await host.createTemplateSet('wanlong', 1, '测试模板集');
    const capture = await host.captureTemplate('wanlong', 1);
    expect(capture).toMatchObject({ width: 256, height: 144, capturedAt: 42, foregroundPackage: wanlongPlugin.packageName });
    expect(new Uint8Array(await sharp(capture.png).ensureAlpha().raw().toBuffer())).toEqual(raw.data);

    const draft = { id: 'tpl_btn_close_popup', name: '关闭按钮', image: capture.png, authoredWidth: 256, authoredHeight: 144,
      crop: { x: 10, y: 10, w: 40, h: 30 }, note: '活动弹窗右上角', tags: ['popup'] };
    const saved = await host.saveTemplate('wanlong', 1, draft);
    expect(saved.definition).toMatchObject({ id: 'tpl_btn_close_popup', file: 'tpl_btn_close_popup.png', note: '活动弹窗右上角', tags: ['popup'] });
    expect(changes).toEqual([expect.objectContaining({ gameId: 'wanlong', directory: set.directory, reason: 'save', templateIds: ['tpl_btn_close_popup'] })]);
    await expect(host.saveTemplate('wanlong', 1, draft)).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS' });
    await host.saveTemplate('wanlong', 1, { ...draft, overwrite: true });
    await expect(host.saveTemplate('wanlong', 1, { ...draft, id: 'tpl_flat', image: await sharp({ create: { width: 256, height: 144, channels: 3, background: '#777' } }).png().toBuffer() }))
      .rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE' });
    expect(changes).toHaveLength(2);

    const coverage = await host.templateCoverage('wanlong', 1, false);
    expect(coverage).toMatchObject({ directory: set.directory, templateCount: 1, compiled: false, ready: false });
    expect(coverage!.critical.map((item) => item.id)).toEqual([...GATHER_CRITICAL_TEMPLATES]);
    expect(coverage!.optional.map((item) => item.id)).not.toContain('tpl_btn_close_popup');

    await host.deleteTemplate('wanlong', 1, 'tpl_btn_close_popup');
    expect(changes.at(-1)).toMatchObject({ reason: 'delete', templateIds: ['tpl_btn_close_popup'] });
    await expect(host.testTemplate('wanlong', 1, 'tpl_btn_close_popup')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('imports legacy sets of this game only, never touching existing ids, and reports the merge', async () => {
    const changes: TemplatesChange[] = [];
    host.onTemplatesChanged((change) => changes.push(change));
    const legacy = path.join(home, 'old-panel', 'templates');
    const png = await sharp(Buffer.from(frame(32, 32).data), { raw: { width: 32, height: 32, channels: 4 } }).png().toBuffer();
    for (const [setId, packageName] of [['tset_mtugr5sx0iwc', wanlongPlugin.packageName], ['tset_other', 'org.other.game']] as const) {
      await mkdir(path.join(legacy, setId), { recursive: true });
      await writeFile(path.join(legacy, setId, 'tpl_a.png'), png);
      await writeFile(path.join(legacy, setId, 'manifest.json'), JSON.stringify({
        id: setId, name: '万龙觉醒', packageName, refWidth: 2560, refHeight: 1440, updatedAt: 1,
        templates: [{ id: 'tpl_a', name: 'A', file: 'tpl_a.png', authoredWidth: 2560, authoredHeight: 1440,
          bounds: { x: 0, y: 0, w: 32, h: 32 }, std: 40.1, createdAt: 1, updatedAt: 1 }],
      }));
    }
    const imported = await host.importTemplateSets('wanlong', legacy);
    expect(imported.result.copiedSets).toEqual({ tset_mtugr5sx0iwc: 2 });
    expect(imported.result.skipped.tset_other).toContain('org.other.game');
    expect(imported.sets.map((item) => item.id)).toEqual(['tset_mtugr5sx0iwc']);
    expect(imported.sets[0]!.templates[0]).toMatchObject({ std: 40.1 });
    expect(changes).toEqual([expect.objectContaining({ reason: 'import', directory: path.join(home, 'automation', 'templates', 'wanlong', 'tset_mtugr5sx0iwc') })]);
    const again = await host.importTemplateSets('wanlong', legacy);
    expect(again.result.copiedSets).toEqual({});
    expect(again.result.addedTemplates).toEqual({});
  });
});

describe('template worker jobs', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(path.join(tmpdir(), 'avdm-template-jobs-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('matches on the same frame with ROI / threshold overrides and reports compile failures with codes', async () => {
    const library = new TemplateLibrary(home);
    const set = await library.createSet('wanlong', '作业', wanlongPlugin.packageName, 256, 144);
    const raw = await smoothFrame(256, 144, 5);
    const png = await rawFrameToPng(raw);
    await library.save(set.directory, { id: 'tpl_a', name: 'A', image: png, authoredWidth: 256, authoredHeight: 144, crop: { x: 40, y: 30, w: 40, h: 30 } });
    const loaded = await library.load(set.directory);
    const image = await library.image(set.directory, 'tpl_a');
    const hit = await runTemplateJob({ kind: 'test', frame: raw, set: loaded, definition: loaded.templates[0]!, image });
    expect(hit).toMatchObject({ ok: true, kind: 'test', match: { found: true, x: 40, y: 30 } });
    const missed = await runTemplateJob({ kind: 'test', frame: raw, set: loaded, definition: loaded.templates[0]!, image,
      roi: { x: 150, y: 80, w: 100, h: 60 }, threshold: 0.99 });
    expect(missed).toMatchObject({ ok: true, match: { found: false, threshold: 0.99 } });

    // Break one image by hand: the full check reports it instead of failing.
    await writeFile(path.join(set.directory, 'tpl_a.png'), await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } }).png().toBuffer());
    const check = await runTemplateJob({ kind: 'compile', directory: set.directory });
    expect(check).toMatchObject({ ok: true, kind: 'compile', compiled: 0, failed: [{ id: 'tpl_a', code: 'TEMPLATE_LOW_VARIANCE' }] });
    const broken = await runTemplateJob({ kind: 'compile', directory: path.join(home, 'nope') });
    expect(broken).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('template IPC validation', () => {
  const automation = {
    saveTemplate: vi.fn(async (_g: string, _i: number, draft: unknown) => draft),
    previewTemplateAlpha: vi.fn(async () => ({})),
    testTemplate: vi.fn(async () => ({})),
    importTemplateSets: vi.fn(async () => ({})),
    templateCoverage: vi.fn(async () => null),
  };
  const ctx = { automation, sender: {} } as never;

  it('keeps vision error codes readable by the IPC envelope', () => {
    expect(errorCode(new AppError('TEMPLATE_LOW_VARIANCE', '模板「x」方差过低 std=3.0 < 12'))).toBe('TEMPLATE_LOW_VARIANCE');
  });

  it('keeps only known draft fields and checks their types', () => {
    const image = new Uint8Array(10);
    const draft = templateDraft({ name: '按钮', image, authoredWidth: 10, authoredHeight: 10, crop: { x: 0, y: 0, w: 8, h: 8 },
      id: 'tpl_x', note: 'n', tags: ['digit', 'dig_x'], diffFrames: [image], diffTolerance: 24, overwrite: true, evil: 'dropped' });
    expect(draft).toEqual({ name: '按钮', image, authoredWidth: 10, authoredHeight: 10, crop: { x: 0, y: 0, w: 8, h: 8 },
      id: 'tpl_x', note: 'n', tags: ['digit', 'dig_x'], diffFrames: [image], diffTolerance: 24, overwrite: true });
    expect(() => templateDraft({ name: 'x', image, authoredWidth: 1, authoredHeight: 1, diffFrames: [image, image, image, image] })).toThrow('去底差分帧无效');
    expect(() => templateDraft({ name: 'x', image: [1, 2], authoredWidth: 1, authoredHeight: 1 })).toThrow('模板图片无效');
    expect(() => templateDraft({ name: 'x', image, authoredWidth: 1, authoredHeight: 1, overwrite: 'yes' })).toThrow('覆盖确认无效');
    expect(() => templateDraft({ name: 'x', image, authoredWidth: 1, authoredHeight: 1, crop: { x: 0, y: 0, w: 0, h: 5 } })).toThrow('裁剪区域无效');
  });

  it('validates alpha previews, test options, coverage and import arguments', async () => {
    const png = new Uint8Array(10);
    await expect(templatesHandlers.previewAutomationTemplateAlpha(ctx, 'wanlong', 1, [png], { x: 0, y: 0, w: 8, h: 8 }, 24))
      .rejects.toThrow('需要主帧加 1~3 帧差分帧');
    await expect(templatesHandlers.previewAutomationTemplateAlpha(ctx, 'wanlong', 1, [png, png, png, png, png], { x: 0, y: 0, w: 8, h: 8 }, 24))
      .rejects.toThrow('需要主帧加 1~3 帧差分帧');
    await templatesHandlers.previewAutomationTemplateAlpha(ctx, 'wanlong', 1, [png, png], { x: 0, y: 0, w: 8, h: 8 }, 30, 320);
    expect(automation.previewTemplateAlpha).toHaveBeenCalledWith('wanlong', 1, [png, png], { x: 0, y: 0, w: 8, h: 8 }, 30, 320);
    await templatesHandlers.testAutomationTemplate(ctx, 'wanlong', 1, 'tpl_x', { roi: { x: 1, y: 2, w: 30, h: 40 }, threshold: 0.8 });
    expect(automation.testTemplate).toHaveBeenCalledWith('wanlong', 1, 'tpl_x', { roi: { x: 1, y: 2, w: 30, h: 40 }, threshold: 0.8 });
    await expect(templatesHandlers.testAutomationTemplate(ctx, 'wanlong', 1, 'tpl_x', { threshold: 3 })).rejects.toThrow('验证阈值无效');
    await expect(templatesHandlers.automationTemplateCoverage(ctx, 'wanlong', 1, 'yes' as never)).rejects.toThrow('检查方式无效');
    await expect(templatesHandlers.importAutomationTemplateSets(ctx, 'wanlong', 'relative/dir')).rejects.toThrow('导入目录无效');
    await templatesHandlers.importAutomationTemplateSets(ctx, 'wanlong', '/tmp/old');
    expect(automation.importTemplateSets).toHaveBeenCalledWith('wanlong', '/tmp/old');
  });
});
