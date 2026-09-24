/**
 * The vision worker's compile-once cache (DECISIONS A.7): a script run's set (AI queries during a script) sits beside
 * the instance's own set instead of evicting it; a manifest change or `clear` (template library changed) recompiles.
 */
import { describe, expect, it } from 'vitest';
import { CompiledSetCache } from '../src/main/scheduler/compiled-cache';

describe('CompiledSetCache', () => {
  it('keeps a few sets side by side, least recently used out first; one compile per directory and stamp', async () => {
    const cache = new CompiledSetCache<string>(2);
    const compiles: string[] = [];
    const get = (dir: string, stamp = 's1') => cache.get(dir, stamp, async () => { compiles.push(`${dir}@${stamp}`); return `${dir}@${stamp}`; });

    await get('/gather');
    // A script consult in between does not cost the gather set its compile.
    await get('/script');
    await get('/gather');
    expect(compiles).toEqual(['/gather@s1', '/script@s1']);
    // A third set evicts the least recently used one (the script set, since gather was used last).
    await get('/other');
    await get('/gather');
    await get('/script');
    expect(compiles).toEqual(['/gather@s1', '/script@s1', '/other@s1', '/script@s1']);
    expect(cache.size).toBe(2);

    // A changed manifest recompiles; concurrent askers share one compile.
    const [a, b] = await Promise.all([get('/gather', 's2'), get('/gather', 's2')]);
    expect(a).toBe('/gather@s2');
    expect(b).toBe('/gather@s2');
    expect(compiles.filter((item) => item === '/gather@s2')).toHaveLength(1);
  });

  it('clear drops every set, and a compile that started before it never becomes the cache', async () => {
    const cache = new CompiledSetCache<number>();
    let compiles = 0;
    let release!: () => void;
    const slow = cache.get('/set', 's', () => new Promise<number>((resolve) => { compiles++; release = () => resolve(compiles); }));
    cache.clear();
    release();
    await expect(slow).resolves.toBe(1);
    expect(cache.size).toBe(0);
    await cache.get('/set', 's', async () => ++compiles);
    await cache.get('/set', 's', async () => ++compiles);
    expect(compiles).toBe(2);
    cache.clear();
    await cache.get('/set', 's', async () => ++compiles);
    expect(compiles).toBe(3);
  });
});
