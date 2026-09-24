import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * The template library shipped with the app (original src/main/store/builtinTemplates.ts): the sets under
 * `resources/templates/<setId>/` are copied into the user's managed library on every start, only-add
 * (TemplateLibrary.importSets → mergeTemplateSets: missing sets are copied whole, existing sets only gain the ids they
 * lack, user-edited or AI-learnt templates are never touched). An instance that has not picked a template set uses the
 * managed copy of the shipped set for its game (original: the set matching the game package), so a fresh install can
 * gather without importing anything first.
 */

export interface BuiltinTemplateSet {
  id: string;
  name: string;
  packageName: string;
}

const MANIFEST = 'manifest.json';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Packaged: electron-builder extraResources → `<Resources>/templates`. Dev and `electron .`: the app's resources dir. */
export function builtinTemplatesDir(isPackaged: boolean, resourcesPath: string, appPath: string): string {
  return isPackaged ? path.join(resourcesPath, 'templates') : path.join(appPath, 'resources', 'templates');
}

/** The shipped sets (manifest headers only, read synchronously at startup). A missing or unreadable dir means none. */
export function listBuiltinTemplateSets(dir: string): BuiltinTemplateSet[] {
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch { return []; }
  const sets: BuiltinTemplateSet[] = [];
  for (const entry of entries.sort()) {
    if (!SAFE_SEGMENT.test(entry)) continue;
    try {
      const raw = JSON.parse(readFileSync(path.join(dir, entry, MANIFEST), 'utf8')) as Record<string, unknown>;
      if (raw['id'] !== entry || typeof raw['packageName'] !== 'string' || typeof raw['name'] !== 'string') continue;
      sets.push({ id: entry, name: raw['name'], packageName: raw['packageName'] });
    } catch { /* Not a template set, or a damaged one: seeding reports it; the default simply skips it. */ }
  }
  return sets;
}

/**
 * Default template directory for a game: the managed copy of the first shipped set for the game's package, once
 * seeding has created it (canonical spelling, like every stored template dir). Null when there is none yet.
 */
export function builtinDefaultResolver(
  gameRoot: (gameId: string) => string,
  sets: readonly BuiltinTemplateSet[],
  packageOf: (gameId: string) => string,
): (gameId: string) => string | null {
  return (gameId) => {
    let packageName: string;
    try { packageName = packageOf(gameId); }
    catch { return null; }
    const set = sets.find((item) => item.packageName === packageName);
    if (!set) return null;
    const dir = path.join(gameRoot(gameId), set.id);
    if (!existsSync(path.join(dir, MANIFEST))) return null;
    try { return realpathSync(dir); }
    catch { return null; }
  };
}
