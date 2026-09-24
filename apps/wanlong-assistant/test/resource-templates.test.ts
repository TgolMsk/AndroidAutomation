/**
 * 「资源统计模板」: the app side of wanlong-panel's `seedResourceTemplates` (`npm run check:resources -- --seed`), fed by
 * the user's own screenshots instead of repository shots.
 *   · AutomationHost.seedResourceTemplates: crops by the spec through TemplateLibrary.save, keeps existing ids unless
 *     `overwrite`, follows the template-save rules (idle instance, change event), skips what has no material;
 *   · the folder reader (old panel file names or role names, no symlinks, a Chinese hint when nothing matches);
 *   · the IPC handler (current screen as one frame role, source validation);
 *   · the template page checklist (present / missing / 待补裁, what blocks a read) and the result summary.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { RES_TPL, RESOURCE_TEMPLATE_CATALOG, resourceGlyphId, wanlongPlugin } from '@avdm/automation/wanlong';
import { AutomationHost } from '../src/main/automation/host';
import { resourcesHandlers } from '../src/main/ipc/resources';
import type { ManagerHost } from '../src/main/manager-host';
import { readResourceSeedFolder } from '../src/main/resources/seed-frames';
import type { ResourcesService } from '../src/main/resources/service';
import type { TemplatesChange } from '../src/shared/ipc';
import { resourceTemplateChecklist, seedSummary } from '../src/renderer/views/templates/resource-templates';

vi.mock('../src/main/events', () => ({ broadcast: vi.fn() }));

const homes: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  homes.push(dir);
  return dir;
}
afterAll(async () => { await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A 16:9 frame with texture everywhere (XOR pattern): every spec crop passes the variance guard. */
function texturedFrame(width = 1280, height = 720): RawFrame {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = ((x ^ y) * 37) & 0xff;
      data[i] = v; data[i + 1] = 255 - v; data[i + 2] = (v * 3) & 0xff; data[i + 3] = 255;
    }
  }
  return { width, height, data, capturedAt: 7 };
}

async function png(frame: RawFrame): Promise<Buffer> {
  return sharp(Buffer.from(frame.data), { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer();
}

const STATS_IDS = RESOURCE_TEMPLATE_CATALOG.filter((spec) => spec.frame === 'stats').map((spec) => spec.id);
const PENDING_IDS = RESOURCE_TEMPLATE_CATALOG.filter((spec) => spec.frame === null).map((spec) => spec.id);

describe('AutomationHost.seedResourceTemplates', { timeout: 60_000 }, () => {
  let home: string;
  let host: AutomationHost;
  const raw = texturedFrame();
  const manager = {
    getState: async () => ({ status: 'running', record: { createdAt: '2026-09-23T00:00:00Z' } }),
    device: async () => ({ foregroundPackage: async () => wanlongPlugin.packageName, screencapRaw: async () => raw }),
  };
  const runner = { runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false) };

  beforeEach(async () => {
    home = await tempDir('avdm-res-tpl-');
    runner.isRunning.mockReturnValue(false);
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never, undefined, {}, { scheduler: { ownerLease: false } });
  });
  afterEach(async () => { await host.dispose(); });

  it('crops every spec entry of the given frames, keeps existing ids unless asked, and reports the rest', async () => {
    await expect(host.seedResourceTemplates('wanlong', 1, { stats: await png(raw) })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
    const set = await host.createTemplateSet('wanlong', 1, '资源统计');
    const changes: TemplatesChange[] = [];
    host.onTemplatesChanged((change) => changes.push(change));

    const first = await host.seedResourceTemplates('wanlong', 1, { stats: await png(raw) });
    expect(first.failed).toEqual([]);
    expect([...first.saved].sort()).toEqual([...STATS_IDS].sort());
    expect(first.saved).toEqual(expect.arrayContaining([RES_TPL.titleResStats, RES_TPL.unitYi, resourceGlyphId('0'), resourceGlyphId('.')]));
    const skipped = new Map(first.skipped.map((item) => [item.id, item.reason]));
    expect(skipped.get(RES_TPL.btnResStats)).toContain('道具→资源页');
    for (const id of PENDING_IDS) expect(skipped.get(id)).toContain('没有素材');
    expect(first).toMatchObject({ frames: ['stats'], pausedSchedule: false, directory: set.directory });
    expect(changes).toEqual([expect.objectContaining({ gameId: 'wanlong', directory: set.directory, reason: 'save', templateIds: first.saved })]);

    const stored = await host.templateSet('wanlong', 1);
    const glyph = stored!.templates.find((item) => item.id === resourceGlyphId('9'))!;
    expect(glyph).toMatchObject({ name: '资源统计数字-9', tags: ['digit', 'dig_resstat'] });
    expect(stored!.templates.find((item) => item.id === RES_TPL.unitYi)!.tags).toEqual(['resstat_unit']);

    // Again without overwrite: nothing to write, nothing changes, every stats id is reported as kept.
    const again = await host.seedResourceTemplates('wanlong', 1, { stats: await png(raw) });
    expect(again.saved).toEqual([]);
    expect(again.skipped.filter((item) => item.reason.startsWith('模板集里已有')).map((item) => item.id).sort()).toEqual([...STATS_IDS].sort());
    expect(changes).toHaveLength(1);

    // Explicit overwrite re-crops; another frame role adds its own entries.
    const redo = await host.seedResourceTemplates('wanlong', 1, { stats: await png(raw), items: await png(texturedFrame(1920, 1080)) }, { overwrite: true });
    expect(redo.failed).toEqual([]);
    expect(redo.saved).toEqual(expect.arrayContaining([...STATS_IDS, RES_TPL.btnResStats, RES_TPL.titleItemsRes]));
    expect(changes).toHaveLength(2);

    // A running automation keeps its templates: the write is refused before anything is touched.
    runner.isRunning.mockReturnValue(true);
    await expect(host.seedResourceTemplates('wanlong', 1, { worldMap: await png(raw) })).rejects.toThrow('正在运行自动化');
    expect(changes).toHaveLength(2);
  });

  it('rejects frames that are not whole 16:9 screenshots per template, and other games', async () => {
    await host.createTemplateSet('wanlong', 1, '资源统计');
    const square = await png(texturedFrame(400, 400));
    const result = await host.seedResourceTemplates('wanlong', 1, { stats: square });
    expect(result.saved).toEqual([]);
    expect(result.skipped.find((item) => item.id === RES_TPL.titleResStats)?.reason).toContain('不是 16:9');
    await expect(host.seedResourceTemplates('wanlong', 1, {})).rejects.toThrow('没有提供任何截图');
    await expect(host.seedResourceTemplates('other', 1, { stats: square })).rejects.toThrow('没有资源统计模板');
  });

  it('seeds from the current screen through the IPC handler and validates the source', async () => {
    await host.createTemplateSet('wanlong', 1, '资源统计');
    const ctx = { resources: { gameId: 'wanlong' } as ResourcesService, automation: host, sender: {} as never };
    const result = await resourcesHandlers.resourcesSeedTemplates(ctx, 'wanlong', 1, { kind: 'screen', frame: 'stats' });
    expect(result?.saved).toEqual(expect.arrayContaining([RES_TPL.titleResStats, RES_TPL.unitYi]));
    await expect(resourcesHandlers.resourcesSeedTemplates(ctx, 'wanlong', 1, { kind: 'screen', frame: 'nope' } as never)).rejects.toThrow('截图来源无效');
    await expect(resourcesHandlers.resourcesSeedTemplates(ctx, 'other', 1, { kind: 'folder' })).rejects.toThrow('未知游戏包');
  });
});

describe('readResourceSeedFolder', () => {
  it('matches the old panel names or the role names, never follows symlinks, and explains an empty folder', async () => {
    const dir = await tempDir('avdm-res-shots-');
    const outside = await tempDir('avdm-res-outside-');
    await writeFile(path.join(dir, 'RES_04_STATS.png'), 'stats');
    await writeFile(path.join(outside, 'secret.png'), 'secret');
    await symlink(path.join(outside, 'secret.png'), path.join(dir, 'res_02_items.png'));
    await writeFile(path.join(dir, 'items.png'), 'items');
    await writeFile(path.join(dir, 'worldMap.png'), 'map');
    const folder = await readResourceSeedFolder(dir);
    expect(folder.files).toEqual({ stats: 'RES_04_STATS.png', items: 'items.png', worldMap: 'worldMap.png' });
    expect(Buffer.from(folder.frames.items!).toString()).toBe('items');

    const empty = await tempDir('avdm-res-empty-');
    await expect(readResourceSeedFolder(empty)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('res_02_items.png') });
  });
});

describe('资源统计模板 checklist', () => {
  it('shows what blocks a read and flags entries without material as 待补裁', () => {
    const empty = resourceTemplateChecklist([]);
    expect(empty.blocking).toEqual([RES_TPL.btnResStats, RES_TPL.titleResStats, RES_TPL.unitYi, 'dig_resstat_*（数字字形）']);
    expect(empty.pending.sort()).toEqual([...PENDING_IDS].sort());
    expect(empty.pending).toEqual(expect.arrayContaining(['dig_resstat_5', 'dig_resstat_8', 'dig_resstat_comma', RES_TPL.unitWan]));
    expect(empty.counts.glyph).toEqual({ present: 0, total: 12 });
    const row = empty.rows.find((item) => item.id === resourceGlyphId('9'))!;
    expect(row).toMatchObject({ state: 'missing', kind: 'glyph', bounds: '1269,437 · 21×30' });
    expect(row.pick).toMatchObject({ id: 'dig_resstat_9', name: '资源统计数字-9', group: 'glyph', tags: ['digit', 'dig_resstat'], note: expect.stringContaining('浅底黑字') });

    const ready = resourceTemplateChecklist([RES_TPL.btnResStats, RES_TPL.titleResStats, RES_TPL.unitYi, resourceGlyphId('1')]);
    expect(ready.blocking).toEqual([]);
    expect(ready.rows.find((item) => item.id === RES_TPL.btnResStats)!.state).toBe('present');
  });

  it('summarises a seed result in Chinese', () => {
    const summary = seedSummary({
      setId: 's', directory: '/s', frames: ['stats'], files: { stats: 'res_04_stats.png' },
      saved: ['tpl_title_res_stats'], failed: [{ id: 'dig_resstat_dot', reason: '方差过低' }],
      skipped: [{ id: 'tpl_resstat_unit_yi', reason: '模板集里已有，没有覆盖' }, { id: 'dig_resstat_5', reason: '现有截图里没有素材' }],
      pausedSchedule: true,
    });
    expect(summary.tone).toBe('warn');
    expect(summary.title).toBe('资源统计模板已入库 1 张，1 张失败');
    expect(summary.lines).toEqual([
      '用到的截图：资源统计弹窗（4 行 × 2 列的表）（res_04_stats.png）',
      '已入库 1 张：tpl_title_res_stats',
      '没存进去 dig_resstat_dot：方差过低',
      '已有、没动 1 张：tpl_resstat_unit_yi',
      '跳过 1 张（没给对应截图，或规格里还没有素材）：dig_resstat_5',
      '模板变了，该实例的自动续跑已关闭；重新校准画面后再开启。',
    ]);
  });
});
