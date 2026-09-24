import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeTemplateSets, type SeedLog } from '../src/template-seed.js';

/** Port of scripts/templates-seed-offline-check.ts: every scenario runs in a temp dir, in order. */

interface Def {
  id: string;
  name: string;
  file: string;
  authoredWidth: number;
  authoredHeight: number;
  bounds: { x: number; y: number; w: number; h: number };
  threshold?: number;
  createdAt: number;
  updatedAt: number;
}

interface SetShape {
  id: string;
  name: string;
  packageName?: string;
  refWidth: number;
  refHeight: number;
  templates: Def[];
  updatedAt: number;
}

function def(id: string, extra: Partial<Def> = {}): Def {
  return {
    id, name: `模板 ${id}`, file: `${id}.png`, authoredWidth: 2560, authoredHeight: 1440,
    bounds: { x: 10, y: 10, w: 40, h: 40 }, threshold: 0.9, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function set(id: string, templates: Def[]): SetShape {
  return { id, name: `集 ${id}`, packageName: 'com.example.game', refWidth: 2560, refHeight: 1440, templates, updatedAt: 1 };
}

async function writeSet(dir: string, s: SetShape, pngBytes: (id: string) => string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const t of s.templates) await writeFile(join(dir, t.file), pngBytes(t.id));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(s, null, 2));
}

async function readSet(dir: string): Promise<SetShape> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as SetShape;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

let root: string;
let builtin: string;
let user: string;
const SET = 'tset_builtin1';
const warns: string[] = [];
const log: SeedLog = (level, message) => { if (level === 'warn') warns.push(message); };
const merge = () => mergeTemplateSets({ sourceDir: builtin, targetRoot: user, log });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wanlong-tplseed-check-'));
  builtin = join(root, 'resources', 'templates');
  user = join(root, 'data', 'templates');
  await writeSet(join(builtin, SET), set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c')]), (id) => `PNG:${id}`);
  await mkdir(join(builtin, 'junk-dir'), { recursive: true }); // no manifest: not a template set
  await writeFile(join(builtin, '.gitkeep'), '');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('only-add template set merge (templates-seed offline check)', () => {
  let merged: SetShape;

  it('① copies a whole set into an empty library and ignores folders without a manifest', async () => {
    const r = await merge();
    expect(r).toEqual({ found: 1, copiedSets: { [SET]: 4 }, addedTemplates: {}, skipped: {} });
    expect(await readFile(join(user, SET, 'tpl_b.png'), 'utf8')).toBe('PNG:tpl_b');
    expect((await readSet(join(user, SET))).templates).toHaveLength(3);
    expect(await exists(join(user, 'junk-dir'))).toBe(false);
    if (process.platform !== 'win32') expect((await stat(join(user, SET, 'tpl_b.png'))).mode & 0o777).toBe(0o600);
  });

  it('② is idempotent', async () => {
    expect(await merge()).toEqual({ found: 1, copiedSets: {}, addedTemplates: {}, skipped: {} });
  });

  it('③ adds only missing ids and keeps every user edit and user template', async () => {
    const mine = await readSet(join(user, SET));
    mine.templates = mine.templates.filter((t) => t.id !== 'tpl_b');
    mine.templates.find((t) => t.id === 'tpl_a')!.threshold = 0.77;
    await writeFile(join(user, SET, 'tpl_a.png'), 'USER-EDITED');
    mine.templates.push(def('tpl_u'));
    await writeFile(join(user, SET, 'tpl_u.png'), 'PNG:tpl_u');
    mine.updatedAt = 5;
    await writeFile(join(user, SET, 'manifest.json'), JSON.stringify(mine, null, 2));
    await rm(join(user, SET, 'tpl_b.png'));
    await writeSet(join(builtin, SET), set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c'), def('tpl_d')]), (id) => `PNG:${id}`);

    const r = await merge();
    expect(r.addedTemplates).toEqual({ [SET]: ['tpl_b', 'tpl_d'] });
    expect(r.copiedSets).toEqual({});
    merged = await readSet(join(user, SET));
    expect(merged.templates.map((t) => t.id)).toEqual(['tpl_a', 'tpl_c', 'tpl_u', 'tpl_b', 'tpl_d']);
    expect(merged.templates.find((t) => t.id === 'tpl_a')!.threshold).toBe(0.77);
    expect(await readFile(join(user, SET, 'tpl_a.png'), 'utf8')).toBe('USER-EDITED');
    expect(await readFile(join(user, SET, 'tpl_b.png'), 'utf8')).toBe('PNG:tpl_b');
    expect(await readFile(join(user, SET, 'tpl_d.png'), 'utf8')).toBe('PNG:tpl_d');
    expect(merged.updatedAt).toBeGreaterThan(5);
    expect(merged.packageName).toBe('com.example.game');
  });

  it('④ skips a set whose user manifest is corrupt without touching a byte', async () => {
    await writeFile(join(user, SET, 'manifest.json'), '{broken');
    await writeSet(join(builtin, SET), set(SET, [def('tpl_a'), def('tpl_b'), def('tpl_c'), def('tpl_d'), def('tpl_e')]), (id) => `PNG:${id}`);
    const r = await merge();
    expect(r.skipped[SET]).toBeTruthy();
    expect(await readFile(join(user, SET, 'manifest.json'), 'utf8')).toBe('{broken');
    expect(await exists(join(user, SET, 'tpl_e.png'))).toBe(false);
    expect(warns.some((w) => w.includes(SET))).toBe(true);
    await writeFile(join(user, SET, 'manifest.json'), JSON.stringify(merged, null, 2));
  });

  it('⑤ returns an empty result when the source folder does not exist', async () => {
    expect(await mergeTemplateSets({ sourceDir: join(root, 'nope'), targetRoot: user, log }))
      .toEqual({ found: 0, copiedSets: {}, addedTemplates: {}, skipped: {} });
  });

  it('⑤b reports found: 0 for a folder that holds no set (e.g. the old data dir instead of its templates/)', async () => {
    expect(await mergeTemplateSets({ sourceDir: join(root, 'data'), targetRoot: join(root, 'elsewhere'), log }))
      .toEqual({ found: 0, copiedSets: {}, addedTemplates: {}, skipped: {} });
    expect(await exists(join(root, 'elsewhere'))).toBe(false);
  });

  it('⑥ skips an invalid source manifest and leaves nothing behind', async () => {
    const BAD = 'tset_bad';
    await mkdir(join(builtin, BAD), { recursive: true });
    await writeFile(join(builtin, BAD, 'manifest.json'), JSON.stringify({ id: BAD, name: '' }));
    const r = await merge();
    expect(r.skipped[BAD]).toContain('不合法');
    expect(await exists(join(user, BAD))).toBe(false);
  });

  it('⑦ skips unsafe file names and missing images, warns, and never writes outside the library', async () => {
    const EDGE = 'tset_edge';
    await writeSet(join(builtin, EDGE), set(EDGE, [def('tpl_ok')]), (id) => `PNG:${id}`);
    const edge = await readSet(join(builtin, EDGE));
    edge.templates.push(def('tpl_evil', { file: '../evil.png' }), def('tpl_missing'));
    await writeFile(join(builtin, EDGE, 'manifest.json'), JSON.stringify(edge, null, 2));
    const r = await merge();
    expect(r.copiedSets[EDGE]).toBe(2); // tpl_ok.png + manifest
    expect((await readSet(join(user, EDGE))).templates.map((t) => t.id)).toEqual(['tpl_ok']);
    expect(await exists(join(user, 'evil.png'))).toBe(false);
    expect(await exists(join(root, 'data', 'evil.png'))).toBe(false);
    expect(warns.some((w) => w.includes('tpl_evil'))).toBe(true);
    expect(warns.some((w) => w.includes('tpl_missing'))).toBe(true);
  });

  it('also accepts one set folder, refuses symlinked images and filters by package', async () => {
    const single = join(root, 'single', 'tset_single');
    await writeSet(single, set('tset_single', [def('tpl_x'), def('tpl_link')]), (id) => `PNG:${id}`);
    await rm(join(single, 'tpl_link.png'));
    await symlink(join(single, 'tpl_x.png'), join(single, 'tpl_link.png'));
    const r = await mergeTemplateSets({ sourceDir: single, targetRoot: user, log });
    expect(r.copiedSets).toEqual({ tset_single: 2 });
    expect((await readSet(join(user, 'tset_single'))).templates.map((t) => t.id)).toEqual(['tpl_x']);
    expect(warns.some((w) => w.includes('tpl_link'))).toBe(true);

    const foreign = join(root, 'foreign', 'tset_foreign');
    await writeSet(foreign, { ...set('tset_foreign', [def('tpl_y')]), packageName: 'org.other' }, (id) => `PNG:${id}`);
    const filtered = await mergeTemplateSets({ sourceDir: foreign, targetRoot: user, log, packageName: 'com.example.game' });
    expect(filtered.skipped['tset_foreign']).toContain('org.other');
    expect(await exists(join(user, 'tset_foreign'))).toBe(false);
  });

  it('a dry run reports exactly what the real merge does, without writing or locking', async () => {
    const src = join(root, 'dry');
    await writeSet(join(src, SET), set(SET, [def('tpl_a'), def('tpl_new1')]), (id) => `PNG:${id}`);
    await writeSet(join(src, 'tset_dry_new'), set('tset_dry_new', [def('tpl_n')]), (id) => `PNG:${id}`);
    const before = await readFile(join(user, SET, 'manifest.json'), 'utf8');
    const planned = await mergeTemplateSets({
      sourceDir: src, targetRoot: user, dryRun: true, lock: () => { throw new Error('dry run must not lock'); },
    });
    expect(planned).toEqual({ found: 2, copiedSets: { tset_dry_new: 2 }, addedTemplates: { [SET]: ['tpl_new1'] }, skipped: {} });
    expect(await readFile(join(user, SET, 'manifest.json'), 'utf8')).toBe(before);
    expect(await exists(join(user, 'tset_dry_new'))).toBe(false);
    expect(await exists(join(user, SET, 'tpl_new1.png'))).toBe(false);
    expect(await mergeTemplateSets({ sourceDir: src, targetRoot: user, log })).toEqual(planned);
  });
});
