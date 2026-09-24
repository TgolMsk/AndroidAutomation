/**
 * The login home proof (original `login/verify.ts`): any city / world-map template at its own threshold, missing
 * templates skipped, none at all → a guiding error. Synthetic frames and templates only.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawFrame } from '@avdm/automation';
import { decideHome, WANLONG_HOME_TEMPLATES } from '../src/main/automation/accounts/drivers';
import { matchHomeTemplates } from '../src/main/automation/accounts/home-match';
import {
  HOME_TEMPLATE_SET_MISSING, HOME_TEMPLATE_SET_REQUIRED, HOME_TEMPLATES_MISSING, HomeVerifier,
} from '../src/main/automation/accounts/home-verify';

const PKG = 'com.lilithgames.samo.android.cn';
const W = 160;
const H = 90;

/** Random 4×4-pixel blocks: textured enough for matching and stable under the shrink-2 resampling. */
function noise(seed: number): RawFrame {
  const data = new Uint8Array(W * H * 4);
  const blocks: number[] = [];
  let value = seed;
  for (let i = 0; i < (W / 4) * Math.ceil(H / 4); i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    blocks.push(value);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const block = blocks[Math.floor(y / 4) * (W / 4) + Math.floor(x / 4)]!;
      const i = (y * W + x) * 4;
      data[i] = block & 0xff;
      data[i + 1] = (block >>> 8) & 0xff;
      data[i + 2] = (block >>> 16) & 0xff;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data, capturedAt: 1 };
}

let dir: string;

async function templateSet(templates: Array<{ id: string; from: RawFrame; x: number; y: number }>): Promise<string> {
  const entries = [];
  for (const item of templates) {
    const png = await sharp(Buffer.from(item.from.data), { raw: { width: W, height: H, channels: 4 } })
      .extract({ left: item.x, top: item.y, width: 34, height: 26 }).png().toBuffer();
    await writeFile(path.join(dir, `${item.id}.png`), png);
    entries.push({
      id: item.id, name: item.id, file: `${item.id}.png`, authoredWidth: W, authoredHeight: H,
      bounds: { x: item.x, y: item.y, w: 34, h: 26 }, defaultRoi: { x: item.x - 10, y: item.y - 10, w: 54, h: 46 }, threshold: 0.9,
    });
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'home-test', name: '登录检查测试', packageName: PKG, refWidth: W, refHeight: H, templates: entries,
  }));
  return dir;
}

beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'avdm-home-verify-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('login home proof', () => {
  it('uses both city and world-map templates, never the magnifier alone', () => {
    expect(WANLONG_HOME_TEMPLATES).toEqual(expect.arrayContaining([
      'tpl_nav_map_toggle', 'tpl_nav_map_toggle_b', 'tpl_nav_city_toggle', 'tpl_nav_city_toggle_b', 'tpl_world_search_icon',
    ]));
    expect(decideHome([{ templateId: 'a', found: false, score: 0.99 }]).ok).toBe(false);
    expect(decideHome([{ templateId: 'a', found: true, score: 0.91 }, { templateId: 'b', found: true, score: 0.97 }]))
      .toEqual({ ok: true, templateId: 'b', score: 0.97 });
  });

  it('passes on any present home template at its own threshold and skips missing ones', async () => {
    const city = noise(1);
    const other = noise(99);
    await templateSet([
      { id: 'tpl_nav_map_toggle', from: city, x: 64, y: 32 },
      { id: 'tpl_world_search_icon', from: other, x: 20, y: 20 },
    ]);
    const onCity = await matchHomeTemplates({ gameId: 'wanlong', templateDir: dir, templateIds: [...WANLONG_HOME_TEMPLATES], foregroundPackage: PKG, frame: city });
    expect(onCity.missing).toEqual(['tpl_nav_map_toggle_b', 'tpl_nav_city_toggle', 'tpl_nav_city_toggle_b']);
    expect(decideHome(onCity.matches)).toMatchObject({ ok: true, templateId: 'tpl_nav_map_toggle' });
    const elsewhere = await matchHomeTemplates({ gameId: 'wanlong', templateDir: dir, templateIds: [...WANLONG_HOME_TEMPLATES], foregroundPackage: PKG, frame: noise(7) });
    expect(decideHome(elsewhere.matches)).toMatchObject({ ok: false, reason: expect.stringContaining('尚未识别到游戏主界面') });
  }, 60_000);

  it('asks for templates when the set has none of the home templates, and for a set when there is none', async () => {
    await templateSet([{ id: 'tpl_panel_title_troop', from: noise(3), x: 10, y: 10 }]);
    await expect(matchHomeTemplates({ gameId: 'wanlong', templateDir: dir, templateIds: [...WANLONG_HOME_TEMPLATES], foregroundPackage: PKG, frame: noise(3) }))
      .rejects.toThrow(HOME_TEMPLATES_MISSING);
    const capture = vi.fn(async () => ({ frame: noise(3), foregroundPackage: PKG }));
    const verifier = new HomeVerifier({ capture, templateDir: async () => '', runWorker: async (input) => ({ ok: true, ...(await matchHomeTemplates(input)) }) });
    await expect(verifier.verify('wanlong', 1)).rejects.toThrow(HOME_TEMPLATE_SET_MISSING);
    // The wizard holds the instance lease, so the way out starts with ending it.
    expect(HOME_TEMPLATE_SET_MISSING).toContain('稍后继续');
    // Before the wizard takes the instance, the same gap is reported as something to fix first.
    expect(await verifier.precheck('wanlong', 1)).toBe(HOME_TEMPLATE_SET_REQUIRED);
    expect(capture).not.toHaveBeenCalled();
    const withSet = new HomeVerifier({ capture, templateDir: async () => dir, runWorker: async (input) => {
      try { return { ok: true, ...(await matchHomeTemplates(input)) }; }
      catch (error) { return { ok: false, error: (error as Error).message }; }
    } });
    expect(await withSet.precheck('wanlong', 1)).toBeNull();
    await expect(withSet.verify('wanlong', 1)).rejects.toThrow('缺少城内／世界地图模板');
    await expect(withSet.verify('unknown-game', 1)).rejects.toThrow();
  }, 60_000);
});
