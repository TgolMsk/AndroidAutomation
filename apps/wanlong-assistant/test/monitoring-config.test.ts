import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InsightsService } from '../src/main/automation/insights';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXY1234567890';
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function service(): Promise<{ service: InsightsService; file: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'avdm-remote-bot-'));
  homes.push(home);
  return {
    service: new InsightsService(home, {
      codec: {
        encrypt: async (plain) => Buffer.from(plain).toString('base64'),
        decrypt: async (ciphertext) => Buffer.from(ciphertext, 'base64').toString(),
      },
    }),
    file: path.join(home, 'automation', 'insights', 'notifications.json'),
  };
}

describe('read-only Telegram inbox configuration', () => {
  it('defaults off, keeps the credential encrypted, and requires a user ID before enabling', async () => {
    const { service: insights, file } = await service();
    expect(await insights.remoteBotConfig()).toMatchObject({ enabled: false, running: false, botTokenSet: false, authorizedUserId: '' });
    await insights.saveConfig('wanlong', 1, { telegram: { botToken: token, chatId: '-1001234567890' } });
    await expect(insights.saveRemoteBotConfig({ enabled: true })).rejects.toThrow('授权用户 ID');
    const config = await insights.saveRemoteBotConfig({ enabled: true, authorizedUserId: '987654321' });
    expect(config).toMatchObject({ enabled: true, running: false, botTokenSet: true, authorizedUserId: '987654321' });
    expect(JSON.stringify(config)).not.toContain(token);
    const runtime = await insights.readOnlyBotConfig();
    expect(runtime).toEqual({ enabled: true, botToken: token, chatId: '-1001234567890', userId: '987654321' });
    const stored = await readFile(file, 'utf8');
    expect(stored).not.toContain(token);
    expect(stored).toContain('remoteReadOnlyEnabled');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await insights.dispose();
  });

  it('reads old notification config with remote access off and clearing the token disables it', async () => {
    const { service: insights, file } = await service();
    await insights.saveConfig('wanlong', 1, { telegram: { botToken: token, chatId: '987654321' } });
    const old = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete old['remoteReadOnlyEnabled'];
    delete old['authorizedUserId'];
    await writeFile(file, JSON.stringify(old));
    expect(await insights.remoteBotConfig()).toMatchObject({ enabled: false, authorizedUserId: '' });
    await insights.saveRemoteBotConfig({ enabled: true, authorizedUserId: '987654321' });
    await insights.saveConfig('wanlong', 1, { telegram: { botToken: '' } });
    expect(await insights.remoteBotConfig()).toMatchObject({ enabled: false, botTokenSet: false });
    expect(await insights.readOnlyBotConfig()).toMatchObject({ enabled: false, botToken: '' });
    await insights.dispose();
  });
});
