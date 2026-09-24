import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { AVDM_EVENT_CHANNELS, INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';
import { authorizeWanlongInvoke } from '../src/main/ipc-handlers';
import {
  ACCOUNTS_METHODS, ADVISOR_METHODS, AUTOMATION_EVENTS, AUTOMATION_METHODS, INSIGHTS_METHODS, PLANS_METHODS,
  TEMPLATES_METHODS, WANLONG_EVENT_NAMES, WANLONG_INVOKE_METHODS,
} from '../src/shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));
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
    const domains = [AUTOMATION_METHODS, TEMPLATES_METHODS, ACCOUNTS_METHODS, PLANS_METHODS, INSIGHTS_METHODS, ADVISOR_METHODS];
    expect(domains.flat()).toEqual([...WANLONG_INVOKE_METHODS]);
    expect(WANLONG_INVOKE_METHODS).toHaveLength(54);
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
    expect([...AUTOMATION_EVENTS]).toEqual(['automation-run', 'automation-schedule']);
  });

  it('accepts assistant commands only from the owned main window', () => {
    expect(() => authorizeWanlongInvoke(appUrl, 'main')).not.toThrow();
    expect(() => authorizeWanlongInvoke(appUrl, 'live')).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke(appUrl, undefined)).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke('https://example.com', 'main')).toThrow('未知页面');
    expect(() => authorizeWanlongInvoke(undefined, 'main')).toThrow('未知页面');
  });
});
