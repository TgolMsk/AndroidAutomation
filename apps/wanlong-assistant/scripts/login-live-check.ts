/**
 * Read-only live login check (port of wanlong-panel `scripts/login-live-check.ts`). Developer tool, not shipped:
 *
 *   npx tsx apps/wanlong-assistant/scripts/login-live-check.ts <instance index> <template dir>
 *   npx tsx apps/wanlong-assistant/scripts/login-live-check.ts --frame <png> <template dir> [true|false]
 *
 * The first form reads the running AVD's native login UI (step phone / code / game / manual) and runs the login
 * home proof on one fresh screencap; it exits 1 when the home screen is not recognized. The `--frame` form
 * replays a saved PNG against the templates and exits 1 when the result differs from the expectation.
 * ★ It never sends an SMS, types, taps, launches or enables anything, and it stores nothing.
 */
import path from 'node:path';
import sharp from 'sharp';
import { AvdManager, defaultHome } from '@avdm/core';
import type { RawFrame } from '@avdm/automation';
import { decideHome, WANLONG_HOME_TEMPLATES } from '../src/main/automation/accounts/drivers';
import { matchHomeTemplates } from '../src/main/automation/accounts/home-match';
import { loginScreen, readLoginUi } from '../src/main/automation/accounts/native-ui';
import { gamePlugin } from '../src/main/automation/games';

const GAME_ID = 'wanlong';

async function checkFrame(frame: RawFrame, templateDir: string, foregroundPackage: string | null) {
  const { matches, missing } = await matchHomeTemplates({
    gameId: GAME_ID, templateDir, templateIds: [...WANLONG_HOME_TEMPLATES], foregroundPackage, frame,
  });
  return { verdict: decideHome(matches), matches, missing };
}

async function main(): Promise<number> {
  const [first, second, third, fourth] = process.argv.slice(2);
  if (first === '--frame') {
    if (!second || !third) throw new Error('需要参数：--frame PNG路径 模板目录 [true|false]');
    const { data, info } = await sharp(path.resolve(second)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame: RawFrame = { width: info.width, height: info.height, data: new Uint8Array(data), capturedAt: Date.now() };
    const result = await checkFrame(frame, path.resolve(third), gamePlugin(GAME_ID).packageName);
    const expected = fourth !== 'false';
    console.log(JSON.stringify({ mode: 'frame', homeVerified: result.verdict.ok, expected, ...result }, null, 2));
    return result.verdict.ok === expected ? 0 : 1;
  }
  const index = Number(first);
  if (!Number.isInteger(index) || index < 0 || index > 63 || !second) {
    throw new Error('需要参数：实例编号（0–63） 模板目录；或 --frame PNG路径 模板目录 [true|false]');
  }
  const manager = await AvdManager.open({ home: defaultHome() });
  try {
    const state = await manager.getState(index);
    if (state.status !== 'running') throw new Error(`实例 #${index} 未运行，请先启动并进入游戏`);
    const device = await manager.device(index);
    const packageName = gamePlugin(GAME_ID).packageName;
    let screen: string;
    try { screen = loginScreen(await readLoginUi(device, packageName), packageName).step; }
    catch (error) { screen = `unreadable: ${(error as Error).message}`; }
    const foreground = (await device.foregroundPackage()) ?? null;
    const frame = await device.screencapRaw();
    const result = foreground === packageName
      ? await checkFrame(frame, path.resolve(second), foreground)
      : { verdict: { ok: false as const, reason: `游戏未处于前台（当前：${foreground ?? '未知'}）` }, matches: [], missing: [] };
    console.log(JSON.stringify({ index, screen, homeVerified: result.verdict.ok, ...result }, null, 2));
    return result.verdict.ok ? 0 : 1;
  } finally {
    await manager.dispose();
  }
}

main().then((code) => { process.exitCode = code; }, (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
