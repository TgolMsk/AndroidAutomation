import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { avdConfigFor, avdDirFor, avdIniFor, readAvdConfig } from '../src/avd/avdfiles.js';
import { isAvdmError } from '../src/errors.js';
import type { AvdManager } from '../src/manager.js';
import type { InstanceState, ScriptRunInfo } from '../src/types.js';
import {
  PNG_SIGNATURE,
  createManagerHarness,
  isAlive,
  recordEvents,
  reserveIndices,
  waitUntil,
  type ManagerHarness,
} from './helpers/manager-harness.js';

/**
 * End-to-end instance lifecycle against the fake SDK (Node scripts standing in for emulator/adb):
 * create → list → start (wait) → screenshot / scripts / scrcpy / apk → stop → clone → update → remove.
 * Instances live at indices 40.. (ports 5634.., 8594..) so parallel test files never collide.
 */

const BASE = 40;
let h: ManagerHarness;
let m: AvdManager;
let ids: number[] = [];

beforeAll(async () => {
  h = await createManagerHarness();
  m = h.manager;
}, 60_000);

afterAll(async () => {
  await h?.cleanup();
}, 60_000);

function finalsOf(runs: ScriptRunInfo[], events: ReturnType<typeof recordEvents>, timeoutMs = 20_000) {
  return waitUntil(
    () => {
      const done = runs.map((r) => events.runs.find((e) => e.runId === r.runId && e.status !== 'running'));
      return done.every(Boolean) ? (done as Array<{ runId: string; status: string; exitCode?: number | null }>) : undefined;
    },
    'script runs to finish',
    timeoutMs,
  );
}

describe('instance lifecycle (fake SDK)', () => {
  it('creates 3 instances that list as stopped with the right ports', async () => {
    const release = await reserveIndices(m, BASE);
    const ev = recordEvents(m);
    const recs = await m.create({ count: 3, namePrefix: '测试' });
    await release();
    ev.stop();
    ids = recs.map((r) => r.index);
    expect(ids).toEqual([BASE, BASE + 1, BASE + 2]);
    expect(ev.changed).toBeGreaterThanOrEqual(2);
    for (const r of recs) {
      expect(r.name).toBe(`测试-${r.index}`);
      expect(r.avdName).toBe(`avdm_${r.index}`);
      expect(r.image).toBe('system-images;android-35;default;arm64-v8a');
      expect(r.provisioning).toBeUndefined();
      expect(r.autoRestart).toBe(false);
      expect(r.spec.ramMb).toBe(1024);
      const cfg = await readAvdConfig(m.paths.avdHome, r.avdName);
      expect(cfg?.['hw.ramSize']).toBe('1024');
      expect(cfg?.['avd.ini.displayname']).toBe(r.name);
    }

    const states = await m.list();
    expect(states.map((s) => s.record.index)).toEqual(ids);
    for (const s of states) {
      const i = s.record.index;
      expect(s.status).toBe('stopped');
      expect(s.bootCompleted).toBe(false);
      expect(s.pid).toBeUndefined();
      expect(s.ports).toEqual({ console: 5554 + 2 * i, adb: 5555 + 2 * i, grpc: 8554 + i, serial: `emulator-${5554 + 2 * i}` });
    }
    expect(await m.indices()).toEqual(ids);
  });

  it('starts all three (wait) → running with distinct pids, run records and events', async () => {
    const ev = recordEvents(m);
    const results = await m.batch(ids, (i) => m.start(i, { wait: true, timeoutMs: 30_000 }), { concurrency: 3 });
    ev.stop();
    for (const r of results) expect(r.ok, r.ok ? '' : r.error.message).toBe(true);

    const states = await m.list();
    const pids = states.map((s) => s.pid);
    for (const s of states) {
      expect(s.status).toBe('running');
      expect(s.bootCompleted).toBe(true);
      expect(isAlive(s.pid)).toBe(true);
      expect(s.startedAt).toBeTruthy();
      expect(s.grpcToken).toBeTruthy(); // launcher passes -grpc-use-token, the fake then requires the token
      const run = await m.registry.readRun(s.record.index);
      expect(run?.pid).toBe(s.pid);
      expect(run?.ports).toEqual(s.ports);
      const argv = run!.argv.join(' ');
      expect(argv).toContain(`-avd avdm_${s.record.index}`);
      expect(argv).toContain(`-port ${s.ports.console}`);
      expect(argv).toContain(`-grpc ${s.ports.grpc}`);
      expect(argv).toContain('-no-window');
      const log = await m.instanceLog(s.record.index, 50);
      expect(log.join('\n')).toContain('=== launch');
    }
    expect(new Set(pids).size).toBe(3);

    for (const i of ids) {
      const seq = ev.states.filter((s) => s.index === i).map((s) => s.status);
      expect(seq[0], `events of #${i}`).toBe('starting'); // published right after the spawn
      expect(seq[seq.length - 1]).toBe('running');
      expect(seq.every((st) => ['starting', 'booting', 'running'].includes(st))).toBe(true);
    }
    expect(ev.logs.some((l) => l.level === 'info' && l.message.includes('已启动实例'))).toBe(true);

    // start again: no-op, same process
    const again = await m.start(ids[0]!);
    expect(again.pid).toBe(pids[0]);
    expect(again.status).toBe('running');
  }, 60_000);

  it('a second manager on the same home sees the same states', async () => {
    const other = await h.open();
    const states = await other.list();
    expect(states.map((s) => [s.record.index, s.status])).toEqual(ids.map((i) => [i, 'running']));
    const st = await other.start(ids[1]!); // no-op there too
    expect(st.pid).toBe(states[1]!.pid);
    await other.dispose();
  });

  it('takes screenshots (PNG) and exposes device / gRPC handles', async () => {
    const png = await m.screenshot(ids[0]!, { width: 320 });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const dev = await m.device(ids[0]!);
    expect(dev.serial).toBe(`emulator-${5554 + 2 * ids[0]!}`);
    expect(await dev.getprop('sys.boot_completed')).toBe('1');
    const g = await m.grpc(ids[0]!);
    expect(await m.grpc(ids[0]!)).toBe(g); // cached
    expect((await g.getStatus()).booted).toBe(true);

    const host = await m.hostStats();
    expect(host.runningInstances).toBe(3);
    expect(host.committedInstanceRamMb).toBe(3 * 1024);
    expect(host.availableMemMb).toBeGreaterThan(0);
  });

  it('rejects spec changes / clone / remove while running, but allows renames and notes', async () => {
    const i = ids[0]!;
    const e1 = await m.update(i, { spec: { cpuCores: 2 } }).catch((e: unknown) => e);
    expect(isAvdmError(e1, 'INSTANCE_RUNNING')).toBe(true);
    const e2 = await m.clone(i, { count: 1 }).catch((e: unknown) => e);
    expect(isAvdmError(e2, 'INSTANCE_RUNNING')).toBe(true);
    const e3 = await m.remove(i).catch((e: unknown) => e);
    expect(isAvdmError(e3, 'INSTANCE_RUNNING')).toBe(true);

    const rec = await m.update(i, { name: '  主号  ', notes: '账号 A', autoRestart: true });
    expect(rec).toMatchObject({ name: '主号', notes: '账号 A', autoRestart: true });
    expect(rec.spec.cpuCores).toBe(1);
    expect((await m.registry.get(i))?.name).toBe('主号');
    // same spec as before is not a spec change
    await m.update(i, { spec: { cpuCores: 1 }, autoRestart: false });
  });

  it('runs a node script on running instances with env vars and streamed output', async () => {
    const dir = path.join(m.paths.scriptsDir, 'env-dump');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'script.json'),
      JSON.stringify({ name: '环境检查', command: [process.execPath, 'main.mjs'], env: { GREETING: '你好' } }),
    );
    await fsp.writeFile(
      path.join(dir, 'main.mjs'),
      `import { execFileSync } from 'node:child_process';
for (const k of ['ANDROID_SERIAL','AVDM_INDEX','AVDM_NAME','AVDM_CONSOLE_PORT','AVDM_ADB_PORT','AVDM_GRPC_PORT','AVDM_ADB','ANDROID_SDK_ROOT','AVDM_HOME','GREETING'])
  console.log(k + '=' + process.env[k]);
console.log('TOKEN_SET=' + Boolean(process.env.AVDM_GRPC_TOKEN));
console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));
const booted = execFileSync(process.env.AVDM_ADB, ['shell', 'getprop', 'sys.boot_completed'], { encoding: 'utf8' }).trim();
console.log('BOOTED=' + booted);
`,
    );
    expect((await m.listScripts()).map((s) => s.id)).toContain('env-dump');

    const ev = recordEvents(m);
    const [a, b] = ids;
    const runs = await m.runScript('env-dump', [a!, b!, 63], ['--round', '2']);
    expect(runs.map((r) => r.index)).toEqual([a, b]);
    expect(ev.logs.some((l) => l.level === 'warn' && l.index === 63)).toBe(true);
    const done = await finalsOf(runs, ev);
    ev.stop();
    for (const d of done) expect(d).toMatchObject({ status: 'exited', exitCode: 0 });

    for (const run of runs) {
      const i = run.index;
      const lines = ev.output.filter((o) => o.runId === run.runId).map((o) => o.line);
      expect(lines).toEqual(
        expect.arrayContaining([
          `ANDROID_SERIAL=emulator-${5554 + 2 * i}`,
          `AVDM_INDEX=${i}`,
          `AVDM_CONSOLE_PORT=${5554 + 2 * i}`,
          `AVDM_ADB_PORT=${5555 + 2 * i}`,
          `AVDM_GRPC_PORT=${8554 + i}`,
          `AVDM_ADB=${h.fake.adbBin}`,
          `ANDROID_SDK_ROOT=${h.fake.root}`,
          `AVDM_HOME=${h.home}`,
          'GREETING=你好',
          'TOKEN_SET=true',
          'ARGS=["--round","2"]',
          'BOOTED=1',
        ]),
      );
      expect(await fsp.readFile(run.logFile, 'utf8')).toContain(`AVDM_INDEX=${i}`);
    }
    const unknown = await m.runScript('does-not-exist', [a!]).catch((e: unknown) => e);
    expect(isAvdmError(unknown, 'SCRIPT_NOT_FOUND')).toBe(true);
  }, 30_000);

  it('stops a long-running script', async () => {
    const dir = path.join(m.paths.scriptsDir, 'forever');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'script.json'),
      JSON.stringify({ name: '常驻', command: [process.execPath, '-e', 'setInterval(() => console.log("tick"), 50)'] }),
    );
    const ev = recordEvents(m);
    const [run] = await m.runScript('forever', [ids[2]!]);
    await waitUntil(() => ev.output.some((o) => o.runId === run!.runId && o.line === 'tick'), 'first tick');
    await m.scripts.stop(run!.runId);
    const info = m.scripts.listRuns().find((r) => r.runId === run!.runId)!;
    expect(info.status).toBe('stopped');
    expect(isAlive(run!.pid)).toBe(false);
    expect(ev.runs.some((r) => r.runId === run!.runId && r.status === 'stopped')).toBe(true);
    ev.stop();
  }, 20_000);

  it('runs the generated hello-adb example (python3) against the fake adb', async () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    await m.scripts.createExample();
    const ev = recordEvents(m);
    const [run] = await m.runScript('hello-adb', [ids[0]!]);
    const [done] = await finalsOf([run!], ev);
    const text = ev.output.filter((o) => o.runId === run!.runId).map((o) => o.line).join('\n');
    ev.stop();
    expect(done, text).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(text).toContain('设备型号');
    expect(text).toContain('屏幕尺寸: 1280x720');
    expect(text).toContain('已点击屏幕中心 (640, 360)');
    const adbCalls = (await fsp.readFile(h.fake.adbLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(adbCalls).toContainEqual(expect.objectContaining({ serial: `emulator-${5554 + 2 * ids[0]!}`, args: ['shell', 'input tap 640 360'] }));
  }, 30_000);

  it('installs an APK and opens scrcpy with the documented arguments', async () => {
    const apk = path.join(h.home, 'game.apk');
    await fsp.writeFile(apk, 'PK fake apk');
    expect(await m.installApk(ids[0]!, [apk])).toMatch(/Success/);
    const missing = await m.installApk(ids[0]!, [path.join(h.home, 'nope.apk')]).catch((e: unknown) => e);
    expect(isAvdmError(missing, 'INVALID_ARGUMENT')).toBe(true);

    const out = path.join(h.home, 'scrcpy-args.json');
    const fakeScrcpy = path.join(h.home, 'fake-scrcpy');
    await fsp.writeFile(
      fakeScrcpy,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), adb: process.env.ADB }));\n`,
      { mode: 0o755 },
    );
    await m.updateSettings({ scrcpyPath: fakeScrcpy });
    const { pid } = await m.openScrcpy(ids[0]!, ['--max-size', '800']);
    expect(pid).toBeGreaterThan(0);
    const got = await waitUntil(async () => JSON.parse(await fsp.readFile(out, 'utf8')), 'fake scrcpy output');
    expect(got).toEqual({
      args: ['-s', `emulator-${5554 + 2 * ids[0]!}`, '--window-title', `主号 (#${ids[0]})`, '--no-audio', '--max-size', '800'],
      adb: h.fake.adbBin,
    });
    await m.updateSettings({ scrcpyPath: path.join(h.home, 'no-scrcpy-here') });
    const unsupported = await m.openScrcpy(ids[0]!).catch((e: unknown) => e);
    expect(isAvdmError(unsupported, 'UNSUPPORTED')).toBe(true);
    await m.updateSettings({ scrcpyPath: '' });
  }, 20_000);

  it('stops all instances gracefully: stopped, run records cleared, scripts stopped', async () => {
    const before = await m.list();
    const pids = before.map((s) => s.pid!);
    const dir = path.join(m.paths.scriptsDir, 'forever');
    expect((await fsp.stat(dir)).isDirectory()).toBe(true);
    const [scriptRun] = await m.runScript('forever', [ids[1]!]);

    const ev = recordEvents(m);
    const results = await m.batch(ids, (i) => m.stop(i), { concurrency: 8 });
    ev.stop();
    for (const r of results) expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);

    const states = await m.list();
    for (const s of states) {
      expect(s.status).toBe('stopped');
      expect(s.pid).toBeUndefined();
      expect(await m.registry.readRun(s.record.index)).toBeUndefined();
      // console `kill` = graceful: the fake saves a Quick Boot snapshot like the real emulator
      await fsp.access(path.join(avdDirFor(m.paths.avdHome, s.record.avdName), 'snapshots', 'default_boot', 'snapshot.pb'));
    }
    for (const i of ids) {
      const seq = ev.states.filter((s) => s.index === i).map((s) => s.status);
      expect(seq).toContain('stopping');
      expect(seq[seq.length - 1]).toBe('stopped');
    }
    expect(m.scripts.listRuns().find((r) => r.runId === scriptRun!.runId)?.status).toBe('stopped');

    await m.stop(ids[0]!); // stopping a stopped instance is a no-op
    const notRunning = await m.screenshot(ids[0]!).catch((e: unknown) => e);
    expect(isAvdmError(notRunning, 'INSTANCE_NOT_RUNNING')).toBe(true);
    const grpcErr = await m.grpc(ids[0]!).catch((e: unknown) => e);
    expect(isAvdmError(grpcErr, 'INSTANCE_NOT_RUNNING')).toBe(true);
    const apkErr = await m.installApk(ids[0]!, [path.join(h.home, 'game.apk')]).catch((e: unknown) => e);
    expect(isAvdmError(apkErr, 'INSTANCE_NOT_RUNNING')).toBe(true);
  }, 60_000);

  let cloneIndex = -1;

  it('clones a stopped instance into a new index with clonedFrom', async () => {
    const src = ids[0]!;
    const srcRec = (await m.registry.get(src))!;
    const [c] = await m.clone(src, { count: 1 });
    cloneIndex = c!.index;
    expect(cloneIndex).toBe(0); // placeholders were released, lowest free index is 0
    expect(c).toMatchObject({
      name: `实例-${cloneIndex}`,
      avdName: `avdm_${cloneIndex}`,
      image: srcRec.image,
      spec: srcRec.spec,
      clonedFrom: src,
      autoRestart: srcRec.autoRestart,
    });
    expect(c!.provisioning).toBeUndefined();
    const cfg = await readAvdConfig(m.paths.avdHome, c!.avdName);
    expect(cfg?.AvdId).toBe(c!.avdName);
    expect(cfg?.['avd.ini.displayname']).toBe(c!.name);
    const ini = await fsp.readFile(avdIniFor(m.paths.avdHome, c!.avdName), 'utf8');
    expect(ini).toContain(`path=${avdDirFor(m.paths.avdHome, c!.avdName)}`);
    // snapshots are dropped by default (first boot of a clone is a cold boot)
    await expect(fsp.access(path.join(avdDirFor(m.paths.avdHome, c!.avdName), 'snapshots'))).rejects.toThrow();
    const state = await m.getState(cloneIndex);
    expect(state.status).toBe('stopped');
    expect(state.ports.console).toBe(5554);
  }, 30_000);

  it('updates the spec of a stopped instance (config.ini rewritten)', async () => {
    const i = ids[0]!;
    const rec = await m.update(i, { spec: { cpuCores: 2, width: 720, height: 1280, dataPartitionGb: 24 } });
    expect(rec.spec).toMatchObject({ cpuCores: 2, width: 720, height: 1280, dataPartitionGb: 24 });
    const cfg = await readAvdConfig(m.paths.avdHome, rec.avdName);
    expect(cfg).toMatchObject({
      'hw.cpu.ncore': '2',
      'hw.lcd.width': '720',
      'hw.lcd.height': '1280',
      'hw.initialOrientation': 'portrait',
      'disk.dataPartition.size': '24G',
      'avd.ini.displayname': '主号',
    });
    const shrink = await m.update(i, { spec: { dataPartitionGb: 8 } }).catch((e: unknown) => e);
    expect(isAvdmError(shrink, 'INVALID_ARGUMENT')).toBe(true);
    const invalid = await m.update(i, { spec: { ramMb: 10 } }).catch((e: unknown) => e);
    expect(isAvdmError(invalid, 'INVALID_ARGUMENT')).toBe(true);
    const empty = await m.update(i, { name: '   ' }).catch((e: unknown) => e);
    expect(isAvdmError(empty, 'INVALID_ARGUMENT')).toBe(true);
    const cleared = await m.update(i, { notes: '' });
    expect(cleared.notes).toBeUndefined();
  });

  it('removes instances with their AVD files and logs', async () => {
    const ev = recordEvents(m);
    const rec = (await m.registry.get(cloneIndex))!;
    await m.remove(cloneIndex);
    expect(await m.registry.get(cloneIndex)).toBeUndefined();
    await expect(fsp.access(avdDirFor(m.paths.avdHome, rec.avdName))).rejects.toThrow();
    await expect(fsp.access(avdConfigFor(m.paths.avdHome, rec.avdName))).rejects.toThrow();
    await expect(fsp.access(avdIniFor(m.paths.avdHome, rec.avdName))).rejects.toThrow();

    await m.remove(ids[2]!);
    await expect(fsp.access(path.join(m.paths.logsDir, `instance-${ids[2]}.log`))).rejects.toThrow();
    expect(await m.indices()).toEqual([ids[0], ids[1]]);
    expect(ev.changed).toBeGreaterThanOrEqual(2);
    ev.stop();
    const gone = await m.remove(cloneIndex).catch((e: unknown) => e);
    expect(isAvdmError(gone, 'INSTANCE_NOT_FOUND')).toBe(true);
    const gone2 = await m.getState(cloneIndex).catch((e: unknown) => e);
    expect(isAvdmError(gone2, 'INSTANCE_NOT_FOUND')).toBe(true);
  });

  it('remove --force stops a running instance first', async () => {
    const i = ids[1]!;
    const st: InstanceState = await m.start(i, { wait: true, timeoutMs: 30_000 });
    expect(st.status).toBe('running');
    await m.remove(i, { force: true });
    expect(isAlive(st.pid)).toBe(false);
    expect(await m.indices()).toEqual([ids[0]]);
  }, 40_000);
});
