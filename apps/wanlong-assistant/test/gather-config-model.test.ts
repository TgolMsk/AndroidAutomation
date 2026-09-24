import { describe, expect, it } from 'vitest';
import { DEFAULT_GATHER_CONFIG, RESOURCE_LABEL } from '@avdm/automation/wanlong/pure';
import type { AutomationSettings } from '../src/shared/ipc';
import {
  configOriginOf, describeGatherConfigBadge, draftOf, originText, savedMessage, saveTargetText,
} from '../src/renderer/views/gather/config-model';
import { GATHER_RESOURCE_META, readResourceType } from '../src/renderer/views/gather/resources';

function settings(config: Record<string, unknown>, patch: Partial<AutomationSettings> = {}): AutomationSettings {
  return { templateDir: '/sets/a', config, ...patch };
}

describe('config storage view (account first, instance fallback)', () => {
  it('origin and texts', () => {
    expect(configOriginOf(settings({ version: 2 }, { configAccount: { id: 'a', name: '主号' } }))).toBe('account');
    expect(configOriginOf(settings({ version: 2 }))).toBe('instance');
    expect(configOriginOf(settings({}))).toBe('default');
    expect(originText('account', { configAccount: { id: 'a', name: '主号' } }, 1)).toBe('存于绑定账号「主号」（accounts.json，跟着账号走）');
    expect(originText('instance', {}, 3)).toBe('存于实例 #3 的本机设置（未绑定账号）');
    expect(originText('default', {}, 3)).toBe('尚未保存过，当前是默认配置');
    expect(saveTargetText('主号', 1)).toBe('配置存在账号「主号」里，跟着账号走。');
    expect(saveTargetText(null, 1)).toContain('这个实例还没绑账号');
  });

  it('the draft of a never-saved instance equals the single default; saved values are kept as they are', () => {
    expect(draftOf(settings({}))).toEqual(DEFAULT_GATHER_CONFIG);
    expect(draftOf(settings({ version: 2, schedule: { slackSeconds: 5000 } })).schedule.slackSeconds).toBe(5000);
  });

  it('the save message says where it went and that auto was switched off', () => {
    expect(savedMessage({ configAccount: { id: 'a', name: '主号' } }, 1, false)).toBe('已保存到账号「主号」，随 accounts.json 落盘。');
    expect(savedMessage({}, 2, true)).toContain('自动采集已关闭：核对后请重新开启');
  });
});

describe('describeGatherConfigBadge (single implementation for header, cards and table)', () => {
  const enabled = { version: 2, enabled: true };

  it('priority: validation errors > missing template set > replaced AVD > master switch off > ok', () => {
    const broken = describeGatherConfigBadge({ settings: settings({ version: 2, safety: { maxCapturesPerCycle: 1 } }) }, false, false);
    expect(broken).toMatchObject({ tone: 'danger', errors: 1, text: '采集配置有 1 处错误，修好才能保存。点开展开配置。' });
    expect(describeGatherConfigBadge({ settings: settings(enabled, { templateDir: '' }) }, true, true)).toMatchObject({ tone: 'warning' });
    expect(describeGatherConfigBadge({ settings: settings(enabled, { configReplaced: true }) }, true, false).text).toContain('被删掉的旧实例');
    expect(describeGatherConfigBadge({ settings: settings({ version: 2, enabled: false }) }, true, true)).toMatchObject({
      tone: 'warning', enabled: false, text: '自动调度开着，但采集配置里的总开关是关的，不会派兵。点开打开总开关并保存。',
    });
    expect(describeGatherConfigBadge({ settings: settings(enabled) }, true, true)).toMatchObject({ tone: null, enabled: true, bound: true });
  });

  it('auto off is never a problem (so the header count can reach 0); a broken config still is; an unbound instance is fine', () => {
    expect(describeGatherConfigBadge({ settings: settings({ version: 2, enabled: false }) }, false, false).tone).toBeNull();
    expect(describeGatherConfigBadge({ settings: settings(enabled, { templateDir: '' }) }, false, false).tone).toBeNull();
    expect(describeGatherConfigBadge({ settings: settings(enabled) }, true, false).tone).toBeNull();
    expect(describeGatherConfigBadge({ error: '自动化配置格式不兼容：/x.json' }, false, false)).toMatchObject({ tone: 'danger' });
    expect(describeGatherConfigBadge(undefined, true, false)).toMatchObject({ tone: null, text: '正在读取采集配置…' });
  });
});

describe('resource meta (glyph and token colour only, names from the single source)', () => {
  it('names come from RESOURCE_LABEL; categories and tap x match the original', () => {
    for (const type of ['wood', 'gold', 'iron', 'mana'] as const) {
      expect(GATHER_RESOURCE_META[type]).toMatchObject(RESOURCE_LABEL[type]);
      expect(GATHER_RESOURCE_META[type].colorVar).toMatch(/^var\(--[a-z-]+\)$/);
    }
    expect(Object.values(GATHER_RESOURCE_META).map((meta) => [meta.glyph, meta.categoryTapX]))
      .toEqual([['木', 1276], ['金', 874], ['铁', 1686], ['魔', 2088]]);
    // Form defaults are the automation package's: mana off with 0 queues (the old 1-vs-0 drift).
    expect(DEFAULT_GATHER_CONFIG.resources.find((item) => item.type === 'mana')).toMatchObject({ enabled: false, queues: 0 });
  });

  it('readResourceType is tolerant and never guesses', () => {
    expect(readResourceType({ resourceType: 'gold' })).toBe('gold');
    expect(readResourceType({ resourceType: 'stone' })).toBeNull();
    expect(readResourceType({ resourceType: null })).toBeNull();
    expect(readResourceType(null)).toBeNull();
  });
});
