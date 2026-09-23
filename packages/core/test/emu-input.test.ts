import { describe, expect, it } from 'vitest';
import { escapeInputText, planInputText } from '../src/adb.js';
import { isAvdmError } from '../src/errors.js';
import { fitScreenshotBox } from '../src/grpc.js';
import { parseSwapUsedMb } from '../src/host.js';
import { expectedResidentMb } from '../src/manager.js';
import { withUserToolDirs } from '../src/scripts.js';

/** Pure helpers of the device/host layer (no emulator, no adb). */

/**
 * What Android's `input text` (InputShellCommand.sendText) types for one argument after the device shell
 * removed the backslash escapes: every "%s" becomes a space.
 */
function androidTypes(arg: string): string {
  const unescaped = arg.replace(/\\(.)/g, '$1');
  const buff = [...unescaped];
  let escapeFlag = false;
  for (let i = 0; i < buff.length; i++) {
    if (escapeFlag) {
      escapeFlag = false;
      if (buff[i] === 's') {
        buff[i] = ' ';
        buff.splice(--i, 1);
      }
    }
    if (buff[i] === '%') escapeFlag = true;
  }
  return buff.join('');
}

function typed(value: string): string {
  return planInputText(value)
    .map((s) => (s.kind === 'key' ? (s.code === 61 ? '\t' : '\n') : androidTypes(escapeInputText(s.text))))
    .join('');
}

describe('planInputText', () => {
  it('types plain ASCII, spaces and shell metacharacters exactly', () => {
    for (const v of ['hello world', `a&b;c|d $HOME \`id\` (x) <y> *?~#! "q" 'q' \\`, '100%', '50 % off']) {
      expect(typed(v), v).toBe(v);
    }
    expect(planInputText('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('keeps a literal "%s" (input text would turn it into a space) by splitting the command', () => {
    expect(typed('100% done %s')).toBe('100% done %s');
    expect(typed('%s%s')).toBe('%s%s');
    expect(typed('a%%sb')).toBe('a%%sb');
    expect(planInputText('x%sy')).toEqual([
      { kind: 'text', text: 'x%' },
      { kind: 'text', text: 'sy' },
    ]);
  });

  it('sends tab and newlines as key events instead of silently dropping them', () => {
    expect(planInputText('a\tb\nc\r\nd')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'key', code: 61 },
      { kind: 'text', text: 'b' },
      { kind: 'key', code: 66 },
      { kind: 'text', text: 'c' },
      { kind: 'key', code: 66 },
      { kind: 'text', text: 'd' },
    ]);
    expect(planInputText('')).toEqual([]);
  });

  it('rejects non-ASCII (Android input text crashes on it) and other control characters, in Chinese', () => {
    for (const v of ['中文', 'mix 中文 abc', 'é', 'emoji 🙂']) {
      const err = (() => {
        try {
          planInputText(v);
        } catch (e) {
          return e;
        }
      })();
      expect(isAvdmError(err, 'INVALID_ARGUMENT'), v).toBe(true);
      expect((err as Error).message).toContain('非 ASCII');
    }
    expect(() => planInputText('bell\u0007')).toThrow('控制字符');
  });
});

describe('fitScreenshotBox', () => {
  it('completes a one-sided size with the panel aspect (the emulator ignores width without height)', () => {
    expect(fitScreenshotBox({ width: 320 }, { width: 1280, height: 720 })).toEqual({ width: 320, height: 180 });
    expect(fitScreenshotBox({ width: 360 }, { width: 720, height: 1280 })).toEqual({ width: 360, height: 640 });
    expect(fitScreenshotBox({ height: 360 }, { width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
    // rounding up keeps the requested side the binding one of the "fit inside" scale
    expect(fitScreenshotBox({ width: 333 }, { width: 1280, height: 720 })).toEqual({ width: 333, height: 188 });
    expect(fitScreenshotBox({ width: 640, height: 640 }, { width: 1280, height: 720 })).toEqual({ width: 640, height: 640 });
    expect(fitScreenshotBox({}, { width: 1280, height: 720 })).toEqual({});
    expect(fitScreenshotBox({ width: 0 }, { width: 1280, height: 720 })).toEqual({});
    expect(fitScreenshotBox({ width: 300 }, { width: 0, height: 0 })).toEqual({ width: 300, height: 300 });
  });
});

describe('host / admission helpers', () => {
  it('parses vm.swapusage', () => {
    expect(parseSwapUsedMb('total = 5120.00M  used = 3821.50M  free = 1298.50M  (encrypted)')).toBe(3822);
    expect(parseSwapUsedMb('total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)')).toBe(0);
    expect(parseSwapUsedMb('total = 8.00G  used = 1.50G  free = 6.50G')).toBe(1536);
    expect(parseSwapUsedMb('garbage')).toBeUndefined();
  });

  it('charges a Quick Boot resume more than a cold boot', () => {
    expect(expectedResidentMb(3072)).toBe(1843);
    expect(expectedResidentMb(3072, { quickBoot: true })).toBe(2458);
  });
});

describe('script PATH', () => {
  it('appends Homebrew and ~/.local/bin on macOS without reordering the inherited PATH', () => {
    const out = withUserToolDirs('/sdk/platform-tools:/usr/bin:/bin', 'darwin').split(':');
    expect(out.slice(0, 3)).toEqual(['/sdk/platform-tools', '/usr/bin', '/bin']);
    expect(out).toContain('/opt/homebrew/bin');
    expect(out).toContain('/usr/local/bin');
    expect(out.some((d) => d.endsWith('/.local/bin'))).toBe(true);
    expect(withUserToolDirs('/opt/homebrew/bin:/usr/bin', 'darwin').split(':').filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(withUserToolDirs('/usr/bin:/bin', 'linux')).toBe('/usr/bin:/bin');
  });
});
