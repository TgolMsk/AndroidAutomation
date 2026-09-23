import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutomationSettingsStore } from '../src/main/automation/store';

describe('AutomationSettingsStore', () => {
  let work: string;
  let store: AutomationSettingsStore;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'avdm-automation-store-'));
    store = new AutomationSettingsStore(path.join(work, 'home'));
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  function settingsFile(gameId: string, index: number): string {
    return path.join(work, 'home', 'automation', gameId, `${index}.json`);
  }

  it('starts empty and isolates settings by game and instance', async () => {
    expect(await store.get('wanlong', 1)).toEqual({ templateDir: '', config: {} });
    await store.save('wanlong', 1, { config: { enabled: true, resources: ['wood'] } });
    expect(await store.get('wanlong', 1)).toEqual({ templateDir: '', config: { enabled: true, resources: ['wood'] } });
    expect(await store.get('wanlong', 2)).toEqual({ templateDir: '', config: {} });
    expect(await store.get('another-game', 1)).toEqual({ templateDir: '', config: {} });
  });

  it('stores a canonical local template directory with private permissions and no staged leftovers', async () => {
    const templates = path.join(work, 'templates');
    const alias = path.join(work, 'templates-alias');
    await mkdir(templates);
    await symlink(templates, alias);
    const saved = await store.save('wanlong', 0, { templateDir: alias, config: { enabled: false } });
    expect(saved.templateDir).toBe(await realpath(templates));

    const file = settingsFile('wanlong', 0);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      templateDir: await realpath(templates),
      config: { enabled: false },
    });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(path.dirname(file))).sort()).toEqual(['0.json']);
  });

  it('rejects invalid keys, paths, and configuration without touching the saved value', async () => {
    const file = settingsFile('wanlong', 3);
    await store.save('wanlong', 3, { config: { safe: true } });
    const before = await readFile(file, 'utf8');

    await expect(store.save('../escape', 3, {})).rejects.toThrow('游戏包 ID');
    await expect(store.get('wanlong', -1)).rejects.toThrow('实例编号');
    await expect(store.save('wanlong', 64, {})).rejects.toThrow('实例编号');
    await expect(store.save('wanlong', 3, { templateDir: 'relative/templates' })).rejects.toThrow('绝对路径');
    await expect(store.save('wanlong', 3, { templateDir: path.join(work, 'missing') })).rejects.toThrow();
    await expect(store.save('wanlong', 3, { config: [] as unknown as Record<string, unknown> })).rejects.toThrow('自动化参数');

    const regularFile = path.join(work, 'not-a-directory');
    await writeFile(regularFile, 'data');
    await expect(store.save('wanlong', 3, { templateDir: regularFile })).rejects.toThrow('不是目录');
    await expect(store.save('wanlong', 3, { config: { tooLarge: 'x'.repeat(70_000) } })).rejects.toThrow('64 KB');

    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await store.get('wanlong', 3)).toEqual({ templateDir: '', config: { safe: true } });
    expect((await readdir(path.dirname(file))).sort()).toEqual(['3.json']);
  });

  it('rejects corrupt and incompatible on-disk settings', async () => {
    const file = settingsFile('wanlong', 4);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ broken json');
    await expect(store.get('wanlong', 4)).rejects.toThrow('无法读取');
    await writeFile(file, JSON.stringify({ version: 9, templateDir: '', config: {} }));
    await expect(store.get('wanlong', 4)).rejects.toThrow('格式不兼容');
    await writeFile(file, JSON.stringify({ version: 1, templateDir: '', config: [] }));
    await expect(store.get('wanlong', 4)).rejects.toThrow('格式不兼容');
  });

  it('serializes concurrent patches so different fields cannot overwrite each other', async () => {
    const one = path.join(work, 'templates-one');
    const two = path.join(work, 'templates-two');
    await Promise.all([mkdir(one), mkdir(two)]);

    for (let round = 0; round < 5; round++) {
      const directory = round % 2 === 0 ? one : two;
      await Promise.all([
        store.save('wanlong', 5, { templateDir: directory }),
        store.save('wanlong', 5, { config: { round, enabled: round % 2 === 0 } }),
      ]);
      expect(await store.get('wanlong', 5)).toEqual({
        templateDir: await realpath(directory),
        config: { round, enabled: round % 2 === 0 },
      });
    }
    expect((await readdir(path.dirname(settingsFile('wanlong', 5)))).sort()).toEqual(['5.json']);
  });
});
