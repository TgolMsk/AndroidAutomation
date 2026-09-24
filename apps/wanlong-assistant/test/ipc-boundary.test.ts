import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { AVDM_EVENT_CHANNELS, INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';
import { authorizeWanlongInvoke } from '../src/main/ipc-handlers';
import {
  ACCOUNTS_EVENTS, ACCOUNTS_METHODS, ADVISOR_EVENTS, ADVISOR_METHODS, ALERTS_EVENTS, ALERTS_METHODS, APP_EVENTS, APP_METHODS,
  AUTOMATION_EVENTS, AUTOMATION_METHODS, BOT_EVENTS, BOT_METHODS, INSIGHTS_EVENTS, INSIGHTS_METHODS, INSTANCES_EVENTS,
  INSTANCES_METHODS, PLANS_EVENTS, PLANS_METHODS, RESOURCES_EVENTS, RESOURCES_METHODS, RUNS_EVENTS, RUNS_METHODS,
  SCHEDULER_EVENTS, SCHEDULER_METHODS, STATS_EVENTS, STATS_METHODS, TEMPLATES_EVENTS, TEMPLATES_METHODS, UPDATE_EVENTS,
  UPDATE_METHODS, WANLONG_EVENT_NAMES, WANLONG_INVOKE_METHODS,
} from '../src/shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));

/** Every domain's lists. Domains only ever append names, so nothing below counts or orders them. */
const DOMAIN_METHODS: readonly (readonly string[])[] = [
  AUTOMATION_METHODS, TEMPLATES_METHODS, ACCOUNTS_METHODS, PLANS_METHODS, RUNS_METHODS, INSIGHTS_METHODS, STATS_METHODS,
  ALERTS_METHODS, BOT_METHODS, RESOURCES_METHODS, ADVISOR_METHODS, SCHEDULER_METHODS, INSTANCES_METHODS, APP_METHODS,
  UPDATE_METHODS,
];
const DOMAIN_EVENTS: readonly (readonly string[])[] = [
  AUTOMATION_EVENTS, TEMPLATES_EVENTS, ACCOUNTS_EVENTS, PLANS_EVENTS, RUNS_EVENTS, INSIGHTS_EVENTS, STATS_EVENTS,
  ALERTS_EVENTS, BOT_EVENTS, RESOURCES_EVENTS, ADVISOR_EVENTS, SCHEDULER_EVENTS, INSTANCES_EVENTS, APP_EVENTS,
  UPDATE_EVENTS,
];
const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;

describe('product IPC boundary', () => {
  it('keeps game commands out of the emulator API', () => {
    const generic = new Set<string>(INVOKE_METHODS);
    const assistant = new Set<string>(WANLONG_INVOKE_METHODS);
    expect(assistant.size).toBe(WANLONG_INVOKE_METHODS.length);
    expect(WANLONG_INVOKE_METHODS.every((method) => !generic.has(method))).toBe(true);
    expect(generic.has('shell')).toBe(true);
    expect(assistant.has('runAutomation')).toBe(true);
    expect(assistant.has('consultAdvisor')).toBe(true);
  });

  it('aggregates every domain list exactly once and keeps the existing method names', () => {
    const methods = DOMAIN_METHODS.flat();
    expect(new Set(methods).size).toBe(methods.length);
    expect(new Set<string>(WANLONG_INVOKE_METHODS)).toEqual(new Set(methods));
    expect(WANLONG_INVOKE_METHODS).toHaveLength(methods.length);
    // Names the renderer already calls; a domain may add methods but never rename these.
    for (const name of ['getAutomationSettings', 'automationTemplateSets', 'accountBeginLogin', 'planRunNow', 'scriptSave',
      'insightDays', 'saveRemoteBotConfig', 'saveAdvisorConfig']) {
      expect(WANLONG_INVOKE_METHODS).toContain(name);
    }
  });

  it('never reuses a shell event name for an assistant event', () => {
    const shell = new Set<string>(AVDM_EVENT_CHANNELS);
    expect(shell.has('script-run')).toBe(true);
    expect(shell.has('log')).toBe(true);
    expect(new Set(WANLONG_EVENT_NAMES).size).toBe(WANLONG_EVENT_NAMES.length);
    expect(WANLONG_EVENT_NAMES.filter((name) => shell.has(name))).toEqual([]);
    expect(new Set<string>(WANLONG_EVENT_NAMES)).toEqual(new Set(DOMAIN_EVENTS.flat()));
    expect(WANLONG_EVENT_NAMES).toEqual(expect.arrayContaining(['automation-run', 'automation-schedule']));
  });

  it('accepts assistant commands only from the owned main window', () => {
    expect(() => authorizeWanlongInvoke(appUrl, 'main')).not.toThrow();
    expect(() => authorizeWanlongInvoke(appUrl, 'live')).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke(appUrl, undefined)).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke('https://example.com', 'main')).toThrow('未知页面');
    expect(() => authorizeWanlongInvoke(undefined, 'main')).toThrow('未知页面');
  });
});
