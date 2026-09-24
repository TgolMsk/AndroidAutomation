import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateLibrary } from '@avdm/automation';
import { GAME_UPDATE_TPL, GATHER_CRITICAL_TEMPLATES, wanlongPlugin } from '@avdm/automation/wanlong';
import { builtinDefaultResolver, builtinTemplatesDir, listBuiltinTemplateSets } from '../src/main/automation/builtin-templates';
import { AutomationHost } from '../src/main/automation/host';
import type { ManagerHost } from '../src/main/manager-host';
import type { TemplatesChange } from '../src/shared/ipc';

const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../src/main/events', () => ({ broadcast }));

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = builtinTemplatesDir(false, '/unused', APP);
const SET_ID = 'tset_mtugr5sx0iwc';

describe('shipped template library', () => {
  it('resolves the packaged and development locations', () => {
    expect(builtinTemplatesDir(true, '/Applications/万龙助手.app/Contents/Resources', APP))
      .toBe(path.join('/Applications/万龙助手.app/Contents/Resources', 'templates'));
    expect(SHIPPED).toBe(path.join(APP, 'resources', 'templates'));
  });

  it('ships the 万龙觉醒 set with every critical gather template, the game-update templates and their images', async () => {
    expect(listBuiltinTemplateSets(SHIPPED)).toEqual([{ id: SET_ID, name: '万龙觉醒', packageName: wanlongPlugin.packageName }]);
    const set = await new TemplateLibrary(await mkdtemp(path.join(tmpdir(), 'avdm-builtin-read-'))).load(path.join(SHIPPED, SET_ID));
    const ids = new Set(set.templates.map((item) => item.id));
    for (const id of [...GATHER_CRITICAL_TEMPLATES, ...Object.values(GAME_UPDATE_TPL)]) expect(ids, id).toContain(id);
    await Promise.all(set.templates.map((item) => access(path.join(SHIPPED, SET_ID, item.file))));
  });

  it('lists nothing for a missing folder and skips folders whose manifest does not name them', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'avdm-builtin-list-'));
    try {
      expect(listBuiltinTemplateSets(path.join(work, 'missing'))).toEqual([]);
      await mkdir(path.join(work, 'tset_a'));
      await writeFile(path.join(work, 'tset_a', 'manifest.json'), JSON.stringify({ id: 'tset_other', name: 'x', packageName: 'p' }));
      await mkdir(path.join(work, 'tset_b'));
      await writeFile(path.join(work, 'tset_b', 'manifest.json'), '{ broken');
      expect(listBuiltinTemplateSets(work)).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('seeding the shipped library', () => {
  let home: string;
  let host: AutomationHost;
  const manager = { getState: async () => ({ status: 'running', record: { createdAt: '2026-09-24T00:00:00Z' } }) };
  const runner = { runOnce: vi.fn(), stop: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), isRunning: vi.fn(() => false) };

  beforeEach(async () => {
    broadcast.mockReset();
    home = await mkdtemp(path.join(tmpdir(), 'avdm-builtin-seed-'));
    host = new AutomationHost({ get: async () => manager } as unknown as ManagerHost, home, runner as never);
  });

  afterEach(async () => {
    await host.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('copies the set once, never touches what the user changed, and becomes the default of unconfigured instances', async () => {
    host.setDefaultTemplateDir(builtinDefaultResolver(
      (gameId) => host.managedTemplateRoot(gameId), listBuiltinTemplateSets(SHIPPED), () => wanlongPlugin.packageName,
    ));
    // Before seeding there is no managed copy: no default yet.
    expect((await host.instanceSettings('wanlong', 3)).templateDir).toBe('');
    expect(await host.seedBuiltinTemplates('wanlong', path.join(home, 'no-such-dir'))).toBeNull();

    const changes: TemplatesChange[] = [];
    host.onTemplatesChanged((change) => changes.push(change));
    const first = await host.seedBuiltinTemplates('wanlong', SHIPPED);
    const managed = await realpath(path.join(home, 'automation', 'templates', 'wanlong', SET_ID));
    expect(Object.keys(first!.copiedSets)).toEqual([SET_ID]);
    expect(first!.skipped).toEqual({});
    expect(changes).toEqual([expect.objectContaining({ gameId: 'wanlong', directory: managed, reason: 'import' })]);
    expect((await host.instanceSettings('wanlong', 3)).templateDir).toBe(managed);

    // The user retunes one template and deletes another: a later start restores only the missing one.
    const manifestFile = path.join(managed, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { templates: { id: string; threshold?: number }[] };
    manifest.templates.find((item) => item.id === 'tpl_btn_search')!.threshold = 0.91;
    const removed = manifest.templates.find((item) => item.id === GAME_UPDATE_TPL.checking)!;
    manifest.templates = manifest.templates.filter((item) => item !== removed);
    await writeFile(manifestFile, JSON.stringify(manifest));
    const second = await host.seedBuiltinTemplates('wanlong', SHIPPED);
    expect(second!.copiedSets).toEqual({});
    expect(second!.addedTemplates).toEqual({ [SET_ID]: [GAME_UPDATE_TPL.checking] });
    const after = JSON.parse(await readFile(manifestFile, 'utf8')) as { templates: { id: string; threshold?: number }[] };
    expect(after.templates.find((item) => item.id === 'tpl_btn_search')!.threshold).toBe(0.91);
    const third = await host.seedBuiltinTemplates('wanlong', SHIPPED);
    expect(third!.copiedSets).toEqual({});
    expect(third!.addedTemplates).toEqual({});

    // A set the user picked wins over the default.
    const own = await new TemplateLibrary(home).createSet('wanlong', '自己的模板集', wanlongPlugin.packageName, 2560, 1440);
    await host.saveSettings('wanlong', 4, { templateDir: own.directory });
    expect((await host.instanceSettings('wanlong', 4)).templateDir).toBe(own.directory);
    expect((await host.instanceSettings('wanlong', 5)).templateDir).toBe(managed);
  });
});
