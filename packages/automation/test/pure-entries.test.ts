import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as pure from '../src/wanlong/pure.js';
import * as wanlong from '../src/wanlong/index.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FORBIDDEN = /^(sharp|@techstark\/opencv-js|node:|electron$|fs$|path$|os$|child_process$|worker_threads$)/;

/** Every module reachable from an entry through runtime (non-type) imports. */
function runtimeImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [path.join(src, entry)];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    const specifiers = [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)]
      .map((match) => match[1]!);
    seen.set(file, specifiers);
    for (const spec of specifiers) {
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

describe('renderer-safe entry points', () => {
  it.each(['wanlong/pure.ts', 'script/index.ts', 'constants.ts'])('%s pulls in no sharp, OpenCV or Node built-ins', (entry) => {
    const graph = runtimeImports(entry);
    const bad = [...graph].flatMap(([file, specs]) => specs.filter((spec) => FORBIDDEN.test(spec))
      .map((spec) => `${path.relative(src, file)} → ${spec}`));
    expect(bad).toEqual([]);
  });

  it('exposes the single gather default config the renderer must use', () => {
    expect(pure.DEFAULT_GATHER_CONFIG).toBe(wanlong.DEFAULT_GATHER_CONFIG);
    expect(pure.DEFAULT_GATHER_CONFIG.resources.find((item) => item.type === 'mana')).toMatchObject({ enabled: false, queues: 0 });
    expect(pure.normalizeGatherConfig({}).resources.map((item) => item.type)).toEqual(['wood', 'gold', 'iron', 'mana']);
    expect(pure.REF_WIDTH).toBe(2560);
    expect(pure.RESOURCE_LABEL.iron.resource).toBe('铁矿石');
  });
});
