import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => import('../../../packages/emulator-shell/test/helpers/electron-mock'));

import { INVOKE_METHODS } from '@avdm/emulator-shell/shared/ipc';
import { authorizeWanlongInvoke } from '../src/main/ipc-handlers';
import { WANLONG_INVOKE_METHODS } from '../src/shared/ipc';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = `${pathToFileURL(join(here, '..', '..', '..', 'packages', 'emulator-shell', 'src', 'renderer', 'index.html')).href}#/`;

describe('product IPC boundary', () => {
  it('keeps game commands out of the emulator API', () => {
    const generic = new Set(INVOKE_METHODS);
    const assistant = new Set(WANLONG_INVOKE_METHODS);
    expect(assistant.size).toBe(WANLONG_INVOKE_METHODS.length);
    expect(WANLONG_INVOKE_METHODS.every((method) => !generic.has(method as never))).toBe(true);
    expect(generic.has('shell')).toBe(true);
    expect(assistant.has('runAutomation')).toBe(true);
    expect(assistant.has('consultAdvisor')).toBe(true);
  });

  it('accepts assistant commands only from the owned main window', () => {
    expect(() => authorizeWanlongInvoke(appUrl, 'main')).not.toThrow();
    expect(() => authorizeWanlongInvoke(appUrl, 'live')).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke(appUrl, undefined)).toThrow('主窗口');
    expect(() => authorizeWanlongInvoke('https://example.com', 'main')).toThrow('未知页面');
    expect(() => authorizeWanlongInvoke(undefined, 'main')).toThrow('未知页面');
  });
});
