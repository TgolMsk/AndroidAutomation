import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { loadTemplateSet, probeGame, readTemplatePng, prepareTemplate } from '../src/index.js';
import type { GamePlugin, RawFrame, ReadOnlyDevicePort } from '../src/index.js';

function makeFrame(seed: number): RawFrame {
  const width = 80;
  const height = 60;
  const data = new Uint8Array(width * height * 4);
  let value = seed;
  for (let i = 0; i < data.length; i += 4) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    data[i] = value & 0xff;
    data[i + 1] = (value >>> 8) & 0xff;
    data[i + 2] = (value >>> 16) & 0xff;
    data[i + 3] = 255;
  }
  return { width, height, data, capturedAt: 12345 };
}

async function fixture(frame = makeFrame(1)): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'avdm-automation-test-'));
  const image = await sharp(Buffer.from(frame.data), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  }).extract({ left: 23, top: 17, width: 17, height: 13 }).png().toBuffer();
  await writeFile(join(directory, 'anchor.png'), image);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    id: 'test-game', name: 'Test game', packageName: 'org.example.game',
    refWidth: frame.width, refHeight: frame.height,
    templates: [{
      id: 'anchor', name: 'Anchor', file: 'anchor.png',
      authoredWidth: frame.width, authoredHeight: frame.height,
      bounds: { x: 23, y: 17, w: 17, h: 13 },
      defaultRoi: { x: 16, y: 10, w: 34, h: 29 }, threshold: 0.9,
    }],
  }));
  return directory;
}

const plugin: GamePlugin = {
  id: 'test-game', name: 'Test game', packageName: 'org.example.game', probeAnchors: ['anchor'],
};

describe('template probe', () => {
  it('matches a real PNG against one captured RGBA frame without device input', async () => {
    const frame = makeFrame(1);
    const directory = await fixture(frame);
    let captures = 0;
    let previews = 0;
    const device: ReadOnlyDevicePort = {
      async capture() { captures++; return frame; },
      async foregroundPackage() { return 'org.example.game'; },
    };
    const report = await probeGame({
      device, plugin, templateDir: directory, shrink: 1,
      onFrame() { previews++; },
    });
    expect(captures).toBe(1);
    expect(previews).toBe(1);
    expect(report.foregroundMatches).toBe(true);
    expect(report.matches).toHaveLength(1);
    expect(report.matches[0]).toMatchObject({ templateId: 'anchor', found: true, x: 23, y: 17 });
    expect(report.matches[0]!.score).toBeGreaterThan(0.95);
  });

  it('rejects low-variance templates and filenames that leave the selected directory', async () => {
    const directory = await fixture();
    const set = await loadTemplateSet(directory);
    const constantPng = await sharp({
      create: { width: 17, height: 13, channels: 4, background: '#eeeeee' },
    }).png().toBuffer();
    await expect(prepareTemplate(constantPng, set.templates[0]!, set, 1)).rejects.toMatchObject({ code: 'TEMPLATE_LOW_VARIANCE', message: expect.stringContaining('方差过低') });
    const outside = join(await mkdtemp(join(tmpdir(), 'avdm-automation-outside-')), 'outside.png');
    await writeFile(outside, await readTemplatePng(set, 'anchor'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      id: 'escape', name: 'Escape', refWidth: 80, refHeight: 60,
      templates: [{ ...set.templates[0], file: '../outside.png' }],
    }));
    await expect(loadTemplateSet(directory)).rejects.toThrow('不安全');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      id: 'safe', name: 'Safe', refWidth: 80, refHeight: 60,
      templates: [{ ...set.templates[0], file: 'linked.png' }],
    }));
    await symlink(outside, join(directory, 'linked.png'));
    await expect(readTemplatePng(await loadTemplateSet(directory), 'anchor')).rejects.toThrow('常规 PNG');
  });
});
