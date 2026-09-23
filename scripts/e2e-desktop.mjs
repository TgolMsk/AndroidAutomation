#!/usr/bin/env node
/**
 * End-to-end smoke test of the BUILT Electron client (packages/desktop/out) against the fake Android SDK.
 * The app is launched with --remote-debugging-port and driven over the Chrome DevTools Protocol: IPC calls
 * go through the real preload (window.avdm) into the real AvdManager, and UI flows are exercised with DOM
 * clicks / synthetic input. Fake emulators listen on the real per-index ports (5554+ / 8554+).
 *
 *   pnpm e2e:desktop                                   # builds everything, then runs this script
 *   node scripts/e2e-desktop.mjs [--shots <dir>]       # against the existing build; --shots saves UI captures
 *
 * Temp dirs only (AVDM_HOME, SDK, Electron user data). Windows appear on screen while it runs (~30 s).
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const DESKTOP = path.join(ROOT, 'packages', 'desktop');
const DESKTOP_MAIN = path.join(DESKTOP, 'out', 'main', 'index.js');
const FAKE_HELPER = path.join(ROOT, 'packages', 'core', 'test', 'helpers', 'fakeSdk.ts');

const argv = process.argv.slice(2);
const shotsIdx = argv.indexOf('--shots');
const SHOTS = shotsIdx >= 0 && argv[shotsIdx + 1] ? path.resolve(argv[shotsIdx + 1]) : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out }));
  });
}

async function cli(args, env) {
  const r = await run(process.execPath, [CLI, ...args], { env });
  if (r.code !== 0) throw new Error(`avdm ${args.join(' ')} 失败:\n${r.out}`);
  return r.out;
}

/** Minimal CDP client over the global WebSocket (Node >= 22). */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error('CDP 连接失败'));
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /** Evaluate an async function body in the page; returns its (JSON) value. */
  async eval(body) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }
  async key(key, code = key) {
    const extra = key === 'Escape' ? { windowsVirtualKeyCode: 27 } : {};
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...extra });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, ...extra });
  }
  close() {
    this.ws.close();
  }
}

async function pageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()).filter((t) => t.type === 'page');
}

async function waitForTarget(port, pred, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = (await pageTargets(port)).find(pred);
      if (t) return t;
    } catch {
      // DevTools endpoint not up yet.
    }
    await sleep(200);
  }
  throw new Error('等待窗口超时');
}

async function readInputLog(file, consolePort) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.port === consolePort);
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    const extra = detail === undefined ? '' : ` → ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    console.log(`✓ ${name}${extra.length > 220 ? `${extra.slice(0, 220)}…` : extra} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`✗ ${name}: ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  for (const f of [CLI, DESKTOP_MAIN]) {
    try {
      await fsp.access(f);
    } catch {
      console.error(`缺少构建产物 ${path.relative(ROOT, f)}，请先运行 pnpm build（或直接 pnpm e2e:desktop）`);
      process.exit(1);
    }
  }
  const { createFakeSdk, getFreePort } = await import(FAKE_HELPER);
  const fake = await createFakeSdk({ bootMs: 1500, grpcToken: 'e2e-desktop-token', maxLifetimeMs: 5 * 60_000 });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'avdm-e2e-desktop-'));
  const home = path.join(work, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(
    path.join(home, 'settings.json'),
    JSON.stringify({ sdkRoot: fake.root, memoryReserveMb: 0, maxRunning: 8, defaultSpec: { ramMb: 1024 } }, null, 2),
  );
  const env = { ...process.env, ...fake.env, AVDM_HOME: home, NO_COLOR: '1', FAKE_SCREEN_FPS: '15' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ANDROID_AVD_HOME;

  let app;
  let appOut = '';
  try {
    await cli(['create', '-n', '3'], env);
    await cli(['start', '0,1', '--wait'], env);

    const port = await getFreePort();
    const electron = createRequire(path.join(DESKTOP, 'package.json'))('electron');
    app = spawn(electron, ['.', `--user-data-dir=${path.join(work, 'electron')}`, `--remote-debugging-port=${port}`], {
      cwd: DESKTOP,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout.on('data', (d) => (appOut += d));
    app.stderr.on('data', (d) => (appOut += d));

    const main = await waitForTarget(port, (t) => t.url.includes('index.html') && !t.url.includes('#/live/'));
    const c = new Cdp(main.webSocketDebuggerUrl);
    await c.open();
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.eval(`for (let i = 0; i < 100 && !document.querySelector('.toolbar'); i++) await new Promise(r => setTimeout(r, 100)); return true`);
    await sleep(1000);

    // ── IPC through the real preload ──
    await check('preload 暴露 window.avdm', async () => {
      const n = await c.eval(`return Object.keys(window.avdm).length`);
      assert(n >= 40, `只有 ${n} 个方法`);
      return `${n} 个方法`;
    });
    await check('listInstances', async () => {
      const v = await c.eval(
        `return (await window.avdm.listInstances()).map(s => s.record.index + ':' + s.status + (s.grpcToken ? '+token' : ''))`,
      );
      assert(v.join(',') === '0:running+token,1:running+token,2:stopped', v.join(','));
      return v;
    });
    await check('sdkInstallStatus（无安装任务时为 null）', async () => {
      const v = await c.eval(`return await window.avdm.sdkInstallStatus()`);
      assert(v === null, JSON.stringify(v));
    });
    await check('hostStats / getSdk / appInfo', async () => {
      const v = await c.eval(`
        const h = await window.avdm.hostStats(); const s = await window.avdm.getSdk(); const a = await window.avdm.appInfo();
        return { mem: h.totalMemMb, running: h.runningInstances, emulator: s.emulator?.version, images: s.images.length, home: a.home }`);
      assert(v.running === 2 && v.emulator === '37.1.11' && v.images === 1 && v.home === home, JSON.stringify(v));
      return v;
    });
    await check('实例卡片渲染', async () => {
      const n = await c.eval(`return document.querySelectorAll('.card').length`);
      assert(n === 3, `卡片数 ${n}`);
      return n;
    });
    await check('缩略图事件', async () => {
      const n = await c.eval(
        `let n = 0; const off = window.avdm.on('thumbnail', () => n++); await new Promise(r => setTimeout(r, 4500)); off(); return n`,
      );
      assert(n > 0, '4.5 秒内没有收到缩略图');
      return `${n} 帧`;
    });
    await check('start([2]) + instance-state 事件', async () => {
      const v = await c.eval(`
        const ev = []; const off = window.avdm.on('instance-state', s => ev.push(s.record.index + ':' + s.status));
        const r = await window.avdm.start([2]); await new Promise(r => setTimeout(r, 2500)); off(); return { r, ev }`);
      assert(v.r[0]?.ok && v.ev.includes('2:starting'), JSON.stringify(v));
      return v.ev;
    });
    await check('shell 批量执行', async () => {
      const v = await c.eval(`return await window.avdm.shell([0, 1], 'getprop ro.product.model')`);
      assert(v.every((x) => x.ok && String(x.value).includes('fake')), JSON.stringify(v));
      return v.map((x) => `#${x.index}:${String(x.value).trim()}`);
    });
    await check('startApp / listPackages / instanceLog', async () => {
      const v = await c.eval(`return {
        app: await window.avdm.startApp([0], 'com.example.game'),
        pkgs: await window.avdm.listPackages(0),
        log: (await window.avdm.instanceLog(0, 3)).length }`);
      assert(v.app[0].ok && v.pkgs.includes('com.example.game') && v.log === 3, JSON.stringify(v));
      return v.pkgs;
    });
    await check('错误以中文消息抛出', async () => {
      const msg = await c.eval(
        `try { await window.avdm.update(0, { spec: { ramMb: 4096 } }); return 'no error' } catch (e) { return e.message }`,
      );
      assert(/[一-龥]/.test(msg) && !msg.includes('Error invoking'), msg);
      return msg;
    });
    await check('脚本：生成示例 + 运行 + 结束事件', async () => {
      const v = await c.eval(`
        await window.avdm.createExampleScript();
        const ids = (await window.avdm.listScripts()).map(s => s.id);
        const lines = []; let done; const ended = new Promise(r => (done = r));
        const off1 = window.avdm.on('script-output', e => lines.push(e.line));
        const off2 = window.avdm.on('script-run', run => { if (run.status !== 'running') done(run.status); });
        await window.avdm.runScript('hello-adb', [0]);
        const status = await Promise.race([ended, new Promise(r => setTimeout(() => r('timeout'), 10000))]);
        off1(); off2();
        return { ids, status, lines: lines.length }`);
      assert(v.ids.includes('hello-adb') && v.status === 'exited' && v.lines >= 4, JSON.stringify(v));
      return v;
    });
    await check('create / update / clone / remove', async () => {
      const v = await c.eval(`
        const created = await window.avdm.create({ count: 1, namePrefix: 'IPC' });
        const renamed = await window.avdm.update(created[0].index, { name: '改名测试' });
        const cloned = await window.avdm.clone(created[0].index, { count: 1 });
        const removed = await window.avdm.remove([cloned[0].index]);
        const left = (await window.avdm.listInstances()).map(s => s.record.index);
        return { created: created.map(r => r.index), renamed: renamed.name, cloned: cloned.map(r => r.index), removed, left }`);
      assert(v.renamed === '改名测试' && v.removed[0].ok && v.left.join(',') === '0,1,2,3', JSON.stringify(v));
      return v;
    });

    await check('CLI 新建/删除实例后界面 3 秒内刷新（文件监视，不等 15 秒轮询）', async () => {
      const cards = () => c.eval(`return document.querySelectorAll('.card').length`);
      const before = await cards();
      const indicesBefore = await c.eval(`return (await window.avdm.listInstances()).map(s => s.record.index)`);
      await c.eval(`window.__ic = 0; window.__icOff = window.avdm.on('instances-changed', () => window.__ic++); return true`);
      await cli(['create', '-n', '1', '--name', 'CLI'], env);
      let t0 = Date.now();
      while ((await cards()) !== before + 1) {
        assert(Date.now() - t0 < 3000, `CLI 新建后 3 秒内卡片数仍为 ${await cards()}（应为 ${before + 1}）`);
        await sleep(100);
      }
      const createdMs = Date.now() - t0;
      const now = await c.eval(`return (await window.avdm.listInstances()).map(s => s.record.index)`);
      const added = now.find((i) => !indicesBefore.includes(i));
      assert(added !== undefined, `找不到新实例: ${now}`);
      await cli(['rm', String(added), '-y'], env);
      t0 = Date.now();
      while ((await cards()) !== before) {
        assert(Date.now() - t0 < 3000, `CLI 删除后 3 秒内卡片数仍为 ${await cards()}（应为 ${before}）`);
        await sleep(100);
      }
      const events = await c.eval(`window.__icOff(); return window.__ic`);
      assert(events >= 2, `instances-changed 事件 ${events} 次`);
      return { createdMs, removedMs: Date.now() - t0, events };
    });

    // ── live view window ──
    await check('实时画面：帧 + 触控 + 按键 + 工具条', async () => {
      await c.eval(`await window.avdm.openLiveView(0); return true`);
      const live = await waitForTarget(port, (t) => t.url.includes('#/live/0'));
      const lc = new Cdp(live.webSocketDebuggerUrl);
      await lc.open();
      try {
        const frame = await lc.eval(`
          for (let i = 0; i < 50; i++) {
            const cv = document.querySelector('canvas');
            if (cv && cv.width > 1) {
              const d = cv.getContext('2d').getImageData(cv.width >> 1, Math.floor(cv.height * 0.1), 1, 1).data;
              if (d[3] > 0 && (d[0] || d[1] || d[2])) return { w: cv.width, h: cv.height, px: [...d] };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return null`);
        assert(frame, '画布上没有画面');
        const rect = await lc.eval(
          `const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }`,
        );
        await lc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await sleep(60);
        await lc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await lc.key('a', 'KeyA');
        const home = await lc.eval(
          `const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('主页')); b?.click(); return !!b`,
        );
        assert(home, '工具条没有“主页”按钮');
        await sleep(800);
      } finally {
        lc.close();
      }
      const input = await readInputLog(fake.inputLog, 5554);
      const touches = input.filter((e) => e.type === 'touch').map((e) => e.request.touches?.[0]);
      const keys = input.filter((e) => e.type === 'key').map((e) => `${e.request.eventType}:${e.request.key || e.request.text}`);
      assert(touches.some((t) => t.pressure > 0) && touches.some((t) => !t.pressure), `touches ${JSON.stringify(touches)}`);
      assert(Math.abs(touches[0].x - 640) <= 2 && Math.abs(touches[0].y - 360) <= 2, `触点未映射到设备中心: ${JSON.stringify(touches[0])}`);
      assert(keys.includes('keypress:GoHome') && keys.some((k) => k.endsWith(':a')), keys.join(','));
      return { touches: touches.map((t) => `${t.x},${t.y}@${t.pressure}`), keys };
    });

    await check('实时画面：置顶按钮 / 帧率指示 / 中文粘贴提示 / IPC 权限', async () => {
      const live = await waitForTarget(port, (t) => t.url.includes('#/live/0'));
      const lc = new Cdp(live.webSocketDebuggerUrl);
      await lc.open();
      try {
        const pin = () =>
          lc.eval(`const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('置顶')); b?.click(); return !!b`);
        assert(await pin(), '工具条没有“置顶”按钮');
        await sleep(300);
        const on = await lc.eval(`return { state: await window.avdm.alwaysOnTop(), pressed: [...document.querySelectorAll('button')].find(b => b.textContent.includes('置顶'))?.getAttribute('aria-pressed') }`);
        assert(on.state === true && on.pressed === 'true', `置顶未生效: ${JSON.stringify(on)}`);
        await pin();
        await sleep(300);
        const off = await lc.eval(`return await window.avdm.alwaysOnTop()`);
        assert(off === false, '再次点击未取消置顶');
        await sleep(1200);
        const rate = await lc.eval(`return document.querySelector('.live-rate')?.textContent ?? ''`);
        assert(/\d+ fps|画面静止/.test(rate) && rate !== '0 fps', `帧率指示: "${rate}"`);
        const denied = await lc.eval(`try { await window.avdm.updateSettings({ maxRunning: 1 }); return 'no error' } catch (e) { return e.message }`);
        assert(denied.includes('无权'), `实时画面窗口竟可修改设置: ${denied}`);
        const keysBefore = (await readInputLog(fake.inputLog, 5554)).filter((e) => e.type === 'key').length;
        await lc.eval(`
          const canvas = document.querySelector('canvas'); canvas.focus();
          const dt = new DataTransfer(); dt.setData('text/plain', 'hi 世界!');
          window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
          return true`);
        await sleep(500);
        const toast = await lc.eval(`return [...document.querySelectorAll('.toast')].map(t => t.innerText).join(' | ')`);
        assert(/非 ASCII/.test(toast), `没有中文粘贴提示: ${toast}`);
        const keysAfter = (await readInputLog(fake.inputLog, 5554)).filter((e) => e.type === 'key').length;
        assert(keysAfter === keysBefore, '含中文的粘贴仍被发送到了设备');
        return { rate, denied };
      } finally {
        lc.close();
      }
    });

    // ── UI flows ──
    const shot = async (name) => {
      if (!SHOTS) return;
      await fsp.mkdir(SHOTS, { recursive: true });
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      await fsp.writeFile(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    };
    const clickButton = (prefix, scope = 'button') =>
      c.eval(
        `const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim().startsWith(${JSON.stringify(prefix)}) && !b.disabled); if (!b) return false; b.click(); return true`,
      );
    const dialogOpen = () => c.eval(`return !!document.querySelector('.modal, [role=dialog]')`);

    await check('UI：新建实例对话框（Esc 关闭）', async () => {
      assert(await clickButton('新建实例'), '找不到“新建实例”按钮');
      await sleep(400);
      assert(await dialogOpen(), '对话框未打开');
      await shot('create.png');
      await c.key('Escape');
      await sleep(300);
      assert(!(await dialogOpen()), 'Esc 未关闭对话框');
    });
    await check('UI：设置 / 脚本对话框', async () => {
      assert(await c.eval(`const b = document.querySelector('button[title="设置"], button[aria-label="设置"]'); b?.click(); return !!b`), '找不到设置按钮');
      await sleep(500);
      assert(await dialogOpen(), '设置未打开');
      await shot('settings.png');
      await c.key('Escape');
      await sleep(300);
      assert(await clickButton('脚本'), '找不到“脚本”按钮');
      await sleep(600);
      assert(await dialogOpen(), '脚本对话框未打开');
      await shot('scripts.png');
      await c.key('Escape');
      await sleep(300);
    });
    await check('设置对话框只保存改动项（不覆盖 CLI 的并发修改）', async () => {
      const changed = await c.eval(`let n = 0; window.__scOff = window.avdm.on('settings-changed', () => n++); window.__sc = () => n; return true`);
      assert(changed, 'listener');
      assert(await c.eval(`const b = document.querySelector('button[title="设置"], button[aria-label="设置"]'); b?.click(); return !!b`), '找不到设置按钮');
      await sleep(600);
      // The user edits 启动超时 …
      const edited = await c.eval(`
        const label = [...document.querySelectorAll('.modal label.field, [role=dialog] label.field')].find(l => l.textContent.includes('启动超时'));
        const input = label?.querySelector('input'); if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '300'); input.dispatchEvent(new Event('input', { bubbles: true })); return true`);
      assert(edited, '找不到“启动超时”输入框');
      // … while the CLI changes another key.
      await cli(['settings', 'set', 'maxRunning', '12'], env);
      const t0 = Date.now();
      while ((await c.eval(`return window.__sc()`)) === 0) {
        assert(Date.now() - t0 < 3000, '3 秒内没有收到 settings-changed 事件');
        await sleep(100);
      }
      assert(await clickButton('保存', '.modal button, [role=dialog] button'), '找不到“保存”按钮');
      await sleep(800);
      const v = await c.eval(`window.__scOff(); const s = await window.avdm.getSettings(); return { maxRunning: s.maxRunning, bootTimeoutSec: s.bootTimeoutSec }`);
      assert(v.maxRunning === 12 && v.bootTimeoutSec === 300, `保存后设置为 ${JSON.stringify(v)}（应保留 CLI 的 maxRunning=12）`);
      return v;
    });
    await check('UI：列表视图', async () => {
      await c.eval(`document.querySelector('button[aria-label="列表视图"]').click(); return true`);
      await sleep(500);
      const rows = await c.eval(`return document.querySelectorAll('table tbody tr, [role=row]').length`);
      await shot('list.png');
      await c.eval(`document.querySelector('button[aria-label="卡片视图"]').click(); return true`);
      assert(rows >= 4, `列表行数 ${rows}`);
      return `${rows} 行`;
    });
    await check('UI：全选 + 工具条批量停止 + toast', async () => {
      await c.eval(`document.querySelector('.toolbar label.select-all input').click(); return true`);
      await sleep(300);
      const sel = await c.eval(`return document.querySelector('.toolbar .sel-count')?.innerText`);
      assert(await clickButton('停止', '.toolbar button'), '工具条“停止”不可用');
      await sleep(300);
      // A confirmation step, if any.
      await c.eval(`const b = [...document.querySelectorAll('.modal button, [role=dialog] button')].find(b => /停止|确定|确认/.test(b.textContent)); b?.click(); return true`);
      const deadline = Date.now() + 15_000;
      let states = [];
      while (Date.now() < deadline) {
        states = await c.eval(`return (await window.avdm.listInstances()).map(s => s.status)`);
        if (states.every((s) => s === 'stopped')) break;
        await sleep(300);
      }
      await sleep(500);
      const toast = await c.eval(`return [...document.querySelectorAll('.toast')].map(t => t.innerText.replace(/\\s+/g, ' ')).join(' | ')`);
      await shot('stopped.png');
      assert(states.every((s) => s === 'stopped'), states.join(','));
      assert(/停止/.test(toast), `没有 toast: ${toast}`);
      return { sel, toast };
    });

    const problems = c.events
      .filter(
        (e) =>
          (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
          (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) ||
          e.method === 'Runtime.exceptionThrown',
      )
      .map((e) =>
        e.method === 'Log.entryAdded'
          ? `${e.params.entry.level}: ${e.params.entry.text}`
          : e.method === 'Runtime.exceptionThrown'
            ? `exception: ${e.params.exceptionDetails.exception?.description}`
            : `${e.params.type}: ${e.params.args.map((a) => a.value ?? a.description).join(' ')}`,
      );
    await check('渲染进程无错误/警告日志', async () => {
      assert(problems.length === 0, problems.join('\n  '));
    });
    c.close();
  } finally {
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      for (let i = 0; i < 30 && app.exitCode === null; i++) await sleep(100);
      if (app.exitCode === null) app.kill('SIGKILL');
    }
    await run(process.execPath, [CLI, 'stop', 'all', '--force'], { env }).catch(() => undefined);
    await fake.cleanup();
    await fsp.rm(work, { recursive: true, force: true });
  }

  const mainErrors = appOut
    .split('\n')
    .filter((l) => l.trim() && !/DevTools listening/.test(l));
  if (mainErrors.length) console.log(`\n主进程输出:\n${mainErrors.map((l) => `  ${l}`).join('\n')}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length} 通过，${failed.length} 失败`);
  if (SHOTS) console.log(`UI 截图: ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`e2e 脚本异常: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
