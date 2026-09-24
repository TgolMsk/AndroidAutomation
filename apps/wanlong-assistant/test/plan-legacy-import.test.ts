import { describe, expect, it } from 'vitest';
import type { ScriptDef, ScriptMeta } from '../src/main/plans/types';
import {
  EMPTY_LEGACY_IMPORT, importLegacyScripts, importedScriptId, legacyPlanForAccount, withImportedScripts, withLegacyPlanFile,
  type LegacyScriptPort,
} from '../src/renderer/views/automation/plan-legacy-import';

const GAME = 'wanlong';
const PKG = 'com.lilithgames.samo.android.cn';
const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const SCRIPT: ScriptDef = { id: 'daily', name: '日常', version: '1.0.0', packageName: PKG,
  refWidth: 2560, refHeight: 1440, steps: [{ id: 'tap-1', kind: 'tap', at: { x: 50, y: 50 } }], updatedAt: 0 };
const LEGACY_PLANS = {
  version: 1,
  config: { enabled: true, retry: 2 },
  plans: [{ accountId: 'legacy-account', enabled: true, updatedAt: 0, tasks: [
    { id: 'task-1', scriptId: 'daily', enabled: true, trigger: { kind: 'daily', at: ['08:00'] }, priority: 50, maxRunMinutes: 30 },
  ] }],
};

/** A script library that already holds a different script with the legacy id `daily`. */
function library(ids: string[]): LegacyScriptPort & { saved: ScriptDef[]; ids: string[] } {
  const saved: ScriptDef[] = [];
  return {
    saved, ids,
    async scriptValidate() { return []; },
    async scriptSave(_gameId, raw) {
      const script = raw as ScriptDef;
      saved.push(script);
      ids.push(script.id);
      return { id: script.id, name: script.name, version: script.version, stepCount: script.steps.length, updatedAt: 1 } satisfies ScriptMeta;
    },
  };
}

const file = (name: string, value: unknown) => ({ name, text: async () => JSON.stringify(value) });

describe('legacy script and plan import', () => {
  it('saves a colliding script under a new id and points the later plan import at it', async () => {
    const scripts = library(['daily']);
    // 脚本 page: 「导入旧脚本 JSON」 — the id is taken, so the script is saved as `daily-import-<suffix>`.
    const { mapping, message } = await importLegacyScripts(scripts, GAME, PKG, [file('daily.json', SCRIPT)], scripts.ids, () => 'abc123');
    expect(mapping).toEqual({ daily: 'daily-import-abc123' });
    expect(scripts.saved.map((item) => item.id)).toEqual(['daily-import-abc123']);
    expect(message).toContain('已导入 1 个脚本');

    // Shared session state, then the 任务计划 page: load plans.json and import it onto the current account.
    let session = withImportedScripts(EMPTY_LEGACY_IMPORT, mapping, message);
    session = withLegacyPlanFile(session, LEGACY_PLANS);
    expect(session.planAccountId).toBe('legacy-account');
    const imported = legacyPlanForAccount(session, ACCOUNT, scripts.ids);
    expect(imported.plan.tasks.map((task) => task.scriptId)).toEqual(['daily-import-abc123']);
    expect(imported.plan).toMatchObject({ accountId: ACCOUNT, enabled: false });
    expect(imported.config).toEqual({ enabled: false, retry: 2 });
  });

  it('without the shared mapping the task would silently target the pre-existing script', () => {
    const session = withLegacyPlanFile(EMPTY_LEGACY_IMPORT, LEGACY_PLANS);
    expect(legacyPlanForAccount(session, ACCOUNT, ['daily', 'daily-import-abc123']).plan.tasks[0]?.scriptId).toBe('daily');
    expect(() => legacyPlanForAccount(session, ACCOUNT, [])).toThrow('请先导入这些脚本：daily');
  });

  it('keeps a free id, merges successive imports and rejects files that are not legacy plans', async () => {
    expect(importedScriptId('daily', new Set(), 'x')).toBe('daily');
    expect(importedScriptId('daily', new Set(['daily']), 'x')).toBe('daily-import-x');
    const scripts = library([]);
    const first = await importLegacyScripts(scripts, GAME, PKG, [file('a.json', SCRIPT)], scripts.ids, () => '1');
    const second = await importLegacyScripts(scripts, GAME, PKG, [file('b.json', { ...SCRIPT, id: 'weekly' })], scripts.ids, () => '2');
    const session = withImportedScripts(withImportedScripts(EMPTY_LEGACY_IMPORT, first.mapping, first.message), second.mapping, second.message);
    expect(session.scriptMap).toEqual({ daily: 'daily', weekly: 'weekly' });
    expect(() => withLegacyPlanFile(session, { plans: 'nope' })).toThrow('plans 数组');
    await expect(importLegacyScripts(scripts, GAME, PKG, [file('c.json', { ...SCRIPT, packageName: 'other.pkg' })], scripts.ids))
      .rejects.toThrow('other.pkg');
  });
});
