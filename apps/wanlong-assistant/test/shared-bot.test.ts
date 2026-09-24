/**
 * The bot contract's pure functions (`src/shared/bot.ts`) and the settings tester's helpers: callback data, menu
 * literals, commands, permissions, renderers under several host time zones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_ACTIONS, BOT_ACTION_SPECS, BOT_CALLBACK_MAX_BYTES, BOT_COMMAND_LIST, BOT_HELP_TEXT, BOT_MENU_BUTTON, BOT_MENU_LAYOUT,
  actionOfCommand, botActionAllowed, botPermissionRefusal, buildCallbackData, buildInstancePicker, buildMenuKeyboard,
  commandOfButtonText, isBotAction, parseCallbackData, renderAccountList, renderShotCaption, shotFilename, type BotAccountRow,
} from '../src/shared/bot';
import { parseAlertCallbackData } from '../src/shared/alerts';
import {
  QUICK_ACTIONS, actionOptionLabel, botStatusText, confirmOf, keepSelection, phoneHint, photoMeta, resultEmpty, resultHeader, runIndex,
} from '../src/renderer/views/bot/bot-tester';

const NOW = Date.UTC(2026, 8, 9, 13, 22, 33); // 2026-09-09 21:22:33 Beijing
const GAME = 'com.lilithgames.samo.android.cn';
const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('actions, specs and commands', () => {
  it('has the nine original actions with a spec each, and the command list in enum order plus help', () => {
    expect([...BOT_ACTIONS]).toEqual(['status', 'resume', 'relaunch', 'pause', 'accounts', 'shot', 'resources', 'stats', 'menu']);
    for (const action of BOT_ACTIONS) {
      const spec = BOT_ACTION_SPECS[action];
      expect(spec.action).toBe(action);
      expect(spec.description.length).toBeGreaterThanOrEqual(3);
      expect(spec.description.length).toBeLessThanOrEqual(256);
    }
    expect(BOT_ACTION_SPECS.resources.callbackPrefix).toBe('res');
    expect(BOT_COMMAND_LIST.map((item) => item.command)).toEqual([...BOT_ACTIONS, 'help']);
    expect(actionOfCommand(' SHOT ')).toBe('shot');
    expect(actionOfCommand('reboot')).toBeNull();
    expect(isBotAction('stats')).toBe(true);
    expect(isBotAction('help')).toBe(false);
  });

  it('classifies permissions: device writes and schedule changes are control, looks are read', () => {
    const control = BOT_ACTIONS.filter((action) => BOT_ACTION_SPECS[action].permission === 'control');
    const read = BOT_ACTIONS.filter((action) => BOT_ACTION_SPECS[action].permission === 'read');
    expect(control).toEqual(['resume', 'relaunch', 'pause', 'resources']);
    expect(read).toEqual(['status', 'accounts', 'shot', 'stats']);
    expect(botActionAllowed('shot', { remoteReadOnlyEnabled: true, remoteControlEnabled: false })).toBe(true);
    expect(botActionAllowed('pause', { remoteReadOnlyEnabled: true, remoteControlEnabled: false })).toBe(false);
    expect(botActionAllowed('shot', { remoteReadOnlyEnabled: false, remoteControlEnabled: true })).toBe(false);
    expect(botActionAllowed('menu', { remoteReadOnlyEnabled: false, remoteControlEnabled: true })).toBe(true);
    expect(botActionAllowed('menu', { remoteReadOnlyEnabled: false, remoteControlEnabled: false })).toBe(false);
    expect(botPermissionRefusal('relaunch')).toContain('「允许手机远程操作」');
    expect(botPermissionRefusal('accounts')).toContain('「允许手机查看状态与截图」');
  });
});

describe('menu keyboard', () => {
  it('★ keeps every button literal character for character, in two rows of three', () => {
    expect(BOT_MENU_BUTTON).toEqual({
      status: '📊 状态', accounts: '👥 账号列表', shot: '📷 截图', resources: '💰 资源', stats: '📈 今日统计', help: '❓ 帮助',
    });
    expect(BOT_MENU_LAYOUT).toEqual([['status', 'accounts', 'shot'], ['resources', 'stats', 'help']]);
    const keyboard = buildMenuKeyboard();
    expect(keyboard.keyboard.map((row) => row.map((key) => key.text))).toEqual([['📊 状态', '👥 账号列表', '📷 截图'], ['💰 资源', '📈 今日统计', '❓ 帮助']]);
    expect(keyboard).toMatchObject({ resize_keyboard: true, is_persistent: true, input_field_placeholder: '点下面的按钮，或发 /help' });
  });

  it('maps the exact literals back to commands (surrounding spaces only)', () => {
    expect(commandOfButtonText('📷 截图')).toBe('shot');
    expect(commandOfButtonText('  💰 资源 ')).toBe('resources');
    expect(commandOfButtonText('❓ 帮助')).toBe('help');
    expect(commandOfButtonText('截图')).toBeNull();
    expect(commandOfButtonText('📷截图')).toBeNull();
  });

  it('the help text lists every command and marks the control ones', () => {
    for (const command of [...BOT_ACTIONS, 'help']) expect(BOT_HELP_TEXT).toContain(`/${command}`);
    expect(BOT_HELP_TEXT).toContain('需开启远程操作');
    expect(BOT_HELP_TEXT.split('\n')[0]).toBe('万龙助手 · 可用命令：');
  });
});

describe('callback data', () => {
  it('round-trips every action with an index and with 「all」', () => {
    for (const action of BOT_ACTIONS) {
      expect(parseCallbackData(buildCallbackData(action, 7))).toEqual({ action, instanceIndex: 7 });
      expect(parseCallbackData(buildCallbackData(action, null))).toEqual({ action, instanceIndex: null });
      expect(new TextEncoder().encode(buildCallbackData(action, 9999)).byteLength).toBeLessThanOrEqual(BOT_CALLBACK_MAX_BYTES);
    }
    expect(buildCallbackData('resources', 2)).toBe('res:2');
    expect(buildCallbackData('status', null)).toBe('status:all');
  });

  it('accepts older buttons without an index, rejects unknown prefixes and bad indexes', () => {
    expect(parseCallbackData('status')).toEqual({ action: 'status', instanceIndex: null });
    expect(parseCallbackData('status:')).toEqual({ action: 'status', instanceIndex: null });
    for (const bad of ['', 'resources:1', 'delete:1', 'shot:x', 'shot:-1', 'shot:12345', 'shot:1:2', `shot:${'1'.repeat(70)}`]) {
      expect(parseCallbackData(bad)).toBeNull();
    }
  });

  it('parses the alert buttons the alerts module attaches', () => {
    for (const data of ['resume:3', 'relaunch:3', 'status:3']) {
      const alert = parseAlertCallbackData(data)!;
      expect(parseCallbackData(data)).toEqual({ action: alert.action, instanceIndex: alert.instanceIndex });
    }
  });

  it('the instance picker has one row per instance', () => {
    expect(buildInstancePicker('shot', [{ index: 0, name: '主号' }, { index: 3, name: null }])).toEqual({
      inline_keyboard: [[{ text: '实例 0 · 主号', callback_data: 'shot:0' }], [{ text: '实例 3', callback_data: 'shot:3' }]],
    });
  });
});

describe('renderers in Beijing time whatever the host zone', () => {
  const row = (patch: Partial<BotAccountRow>): BotAccountRow => ({
    accountName: '主号', enabled: true, instanceIndex: 0, bindingStale: false, loginReady: true, instanceName: 'Pixel-0',
    instanceState: 'running', auto: true, pausedReason: null, lastSampledAt: NOW - 142_000, lastSampleOk: true, queueUsed: 5,
    queueTotal: 5, ...patch,
  });

  it.each(['America/Los_Angeles', 'Asia/Shanghai', 'UTC'])('%s', (tz) => {
    process.env.TZ = tz;
    expect(shotFilename(0, NOW)).toBe('inst0-20260909-212233.jpg');
    const caption = renderShotCaption({ instanceIndex: 0, accountName: '主号', at: NOW, foreground: GAME, gameRunning: true, gamePackage: GAME });
    expect(caption).toBe(`实例 0「主号」截图\n北京时间 2026-09-09 21:22:33\n前台：游戏（${GAME}）｜游戏进程：存活`);
    const list = renderAccountList([
      row({}), row({ accountName: '小号', enabled: false, instanceIndex: null, loginReady: null, instanceName: null, instanceState: null, auto: null }),
      row({ accountName: '三号', instanceIndex: 2, instanceState: 'stopped', pausedReason: '疑似被顶号', lastSampledAt: null, loginReady: false }),
    ], NOW);
    expect(list.split('\n')).toEqual([
      '【账号列表】共 3 个（北京时间 21:22:33）',
      '1. 主号 · 实例 0「Pixel-0」（运行中）',
      '   启用 ✅｜自动调度 开｜队列 5/5｜上次读面板 21:20:11',
      '2. 小号 · 未绑定实例',
      '   启用 ❌',
      '3. 三号 · 实例 2「Pixel-0」（未运行）',
      '   启用 ✅｜登录待验证｜自动调度 开｜队列 5/5｜还没读过面板',
      '   ⛔ 已暂停：疑似被顶号',
    ]);
  });

  it('flags a foreground that is not the game and an empty account list', () => {
    const caption = renderShotCaption({ instanceIndex: 1, accountName: null, at: NOW, foreground: 'com.android.launcher3', gameRunning: false, gamePackage: GAME });
    expect(caption).toContain('★ 不是游戏：com.android.launcher3｜游戏进程：★ 不在');
    expect(renderShotCaption({ instanceIndex: 1, accountName: null, at: NOW, foreground: null, gameRunning: null, gamePackage: GAME })).toContain('前台：未知｜游戏进程：未查');
    expect(renderAccountList([], NOW)).toBe('【账号列表】还没有任何账号。到助手「设备与账号 → 账号管理」页新建并绑定实例后再来看。（北京时间 21:22:33）');
  });
});

describe('settings tester helpers', () => {
  it('uses the menu literals for the four quick buttons', () => {
    expect(QUICK_ACTIONS.map((item) => item.label)).toEqual(['👥 账号列表', '📷 截图', '💰 资源', '📈 今日统计']);
  });

  it('sends the index the action needs and blocks a missing required one', () => {
    expect(runIndex('accounts', 3)).toEqual({ index: null, blocked: null });
    expect(runIndex('status', null)).toEqual({ index: null, blocked: null });
    expect(runIndex('status', 2)).toEqual({ index: 2, blocked: null });
    expect(runIndex('shot', null).blocked).toContain('需要先选一个实例');
  });

  it('confirms device and control actions, not looks', () => {
    expect(confirmOf('shot', 1)).toEqual({ title: '截一张指定账号的画面发过来？', message: '会占用实例 1 的模拟器几秒；采集脚本正在跑时会被拒绝。' });
    expect(confirmOf('pause', 1)?.message).toContain('实例 1');
    expect(confirmOf('accounts', null)).toBeNull();
    expect(confirmOf('status', 0)).toBeNull();
  });

  it('says what the phone still needs, formats headers and results', () => {
    expect(phoneHint('shot', { readEnabled: false, controlEnabled: true })).toContain('允许手机查看状态与截图');
    expect(phoneHint('resume', { readEnabled: true, controlEnabled: false })).toContain('允许手机远程操作');
    expect(phoneHint('menu', { readEnabled: true, controlEnabled: false })).toBeNull();
    expect(actionOptionLabel('relaunch')).toBe('/relaunch · 重启游戏并恢复自动调度（会操作模拟器）');
    process.env.TZ = 'America/Los_Angeles';
    expect(resultHeader('shot', 1, NOW)).toBe('/shot 1 · 北京时间 21:22:33');
    expect(resultHeader('stats', null, NOW)).toBe('/stats · 北京时间 21:22:33');
    expect(resultEmpty({ text: '  ' })).toBe(true);
    expect(resultEmpty({ text: '', photo: { jpeg: new Uint8Array(3), caption: '', filename: 'a.jpg' } })).toBe(false);
    expect(photoMeta({ filename: 'inst0.jpg', jpeg: new Uint8Array(150 * 1024) })).toBe('inst0.jpg · 150 KB');
    expect(keepSelection(2, [{ index: 0, name: null }, { index: 2, name: null }])).toBe(2);
    expect(keepSelection(5, [{ index: 0, name: null }])).toBe(0);
    expect(keepSelection(null, [])).toBeNull();
  });

  it('describes the bot state', () => {
    expect(botStatusText({ running: true, readEnabled: true, controlEnabled: false, problem: null, since: 1 })).toMatchObject({ label: '运行中', tone: 'success' });
    expect(botStatusText({ running: true, readEnabled: true, controlEnabled: true, problem: '409', since: 1 })).toMatchObject({ tone: 'warning', detail: '409' });
    expect(botStatusText({ running: false, readEnabled: false, controlEnabled: false, problem: null, since: null }).detail).toContain('两个手机开关都关着');
  });
});
