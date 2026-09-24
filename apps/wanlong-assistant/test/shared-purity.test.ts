import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sharedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared');

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Runtime (non-type) module specifiers imported or re-exported by a file. */
function runtimeImports(text: string): string[] {
  const specifiers: string[] = [];
  const statement = /^\s*(import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  for (const match of text.matchAll(statement)) {
    const clause = match[2]!;
    // `import { type A, type B } from 'x'` is type-only as well.
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    if (named && named[1]!.split(',').map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith('type '))) continue;
    specifiers.push(match[3]!);
  }
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]!);
  return specifiers;
}

describe('src/shared is side-effect free (original iron rule 1)', () => {
  it('never imports Electron, Node built-ins, sharp or OpenCV at runtime', async () => {
    const forbidden = /^(electron|node:|fs$|path$|os$|child_process$|sharp$|@techstark\/opencv-js$|@avdm\/core$)/;
    const offenders: string[] = [];
    for (const file of await sourceFiles(sharedRoot)) {
      for (const specifier of runtimeImports(await readFile(file, 'utf8'))) {
        if (forbidden.test(specifier)) offenders.push(`${path.relative(sharedRoot, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('recognises type-only imports', () => {
    expect(runtimeImports("import type { A } from 'electron';\nimport { type B } from 'node:fs';")).toEqual([]);
    expect(runtimeImports("import { readFile } from 'node:fs/promises';\nexport { x } from './y';")).toEqual(['node:fs/promises', './y']);
  });
});
