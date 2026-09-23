import { statSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const broadcast = vi.fn();
vi.mock('../src/main/events', () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));

import { watchBuild } from '../src/main/build-watch';

// watchBuild() watches its own module file; in tests that is src/main/build-watch.ts.
const moduleFile = fileURLToPath(new URL('../src/main/build-watch.ts', import.meta.url));

describe('watchBuild', () => {
  const original = statSync(moduleFile);
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    utimesSync(moduleFile, original.atime, original.mtime);
    broadcast.mockReset();
    delete process.env['ELECTRON_RENDERER_URL'];
  });

  it('broadcasts app-outdated once after the bundle is rewritten', async () => {
    stop = watchBuild(20);
    await new Promise((r) => setTimeout(r, 60));
    expect(broadcast).not.toHaveBeenCalled();
    const later = new Date(original.mtimeMs + 60_000);
    utimesSync(moduleFile, later, later);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1), { timeout: 1000 });
    expect(broadcast.mock.calls[0]?.[0]).toBe('app-outdated');
    await new Promise((r) => setTimeout(r, 80));
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('is disabled under the dev server (HMR)', async () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173';
    stop = watchBuild(20);
    const later = new Date(original.mtimeMs + 60_000);
    utimesSync(moduleFile, later, later);
    await new Promise((r) => setTimeout(r, 80));
    expect(broadcast).not.toHaveBeenCalled();
  });
});
