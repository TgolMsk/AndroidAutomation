/**
 * tplkit: developer CLI for cutting and checking Wanlong templates and digit glyph kits (port of wanlong-panel's
 * scripts/tplkit.ts). Run it with tsx from the app package:
 *
 *   pnpm --filter @avdm/wanlong-assistant run tplkit -- <command> [args...] [--dir <template set folder>]
 *
 * Commands: cap | view | analyze | probe | alpha | glyphs | save | verify | cross | ocr | find | scan | ls | del.
 *
 * Where things go (never into the repository: frames are real game screenshots):
 *   - template set: `--dir` or TPLKIT_SET_DIR; else the folder bound to instance WL_INSTANCE in the assistant's
 *     settings (~/.avdm/automation/wanlong/<i>.json); else the managed set named 「万龙觉醒」 (created when absent);
 *   - scratch frames: TPLKIT_SCRATCH, default ~/.avdm/automation/tplkit/{frames,view};
 *   - capture: `cap` reads a raw frame from AVD instance WL_INSTANCE (default: the first running one) via @avdm/core.
 * TPLKIT_SHRINK (default 2) is the downscale used by verify / cross / find / scan, as in the original.
 * Coordinates are reference pixels; author on a 2560×1440 instance (smaller frames are upscaled and blur glyphs).
 */
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  loadPreparedSet, loadTemplateSet, matchTemplate, prepareFrame, renderAlphaPreview, TemplateLibrary,
  type PreparedFrame, type PreparedTemplate, type Rect,
} from '@avdm/automation';
import { tplkit, wanlongPlugin } from '@avdm/automation/wanlong';
import { AvdManager, defaultHome } from '@avdm/core';
import { AutomationSettingsStore } from '../src/main/automation/store';

const SET_NAME = '万龙觉醒';
const REF = wanlongPlugin.referenceSize ?? { width: 2560, height: 1440 };
const SHRINK = Number(process.env.TPLKIT_SHRINK ?? 2);
const HOME = defaultHome();

/** `--dir <path>` may appear anywhere; everything else is positional. */
function parseArgs(raw: string[]): { args: string[]; dir?: string } {
  const args: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--dir') { dir = raw[++i]; continue; }
    if (raw[i] === '--') continue;
    args.push(raw[i]!);
  }
  return { args, dir };
}

const { args: argv, dir: dirOption } = parseArgs(process.argv.slice(2));
const cmd = argv[0];

function num(value: string | undefined, fallback?: number): number {
  if (value === undefined) {
    if (fallback === undefined) throw new Error('缺少数字参数');
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`不是合法数字：${value}`);
  return n;
}

function need(value: string | undefined, label: string): string {
  if (!value) throw new Error(`缺少参数：${label}`);
  return value;
}

async function ensureDir(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
}

function scratch(): string {
  return process.env.TPLKIT_SCRATCH ?? join(HOME, 'automation', 'tplkit');
}

function instanceIndex(): number | undefined {
  const wanted = (process.env.WL_INSTANCE ?? '').trim();
  if (!wanted) return undefined;
  const index = Number(wanted);
  if (!Number.isInteger(index) || index < 0 || index > 63) throw new Error(`WL_INSTANCE 无效：${wanted}`);
  return index;
}

let resolvedSet: string | undefined;

/** The template set this run works on (see the file header for the order). */
async function resolveSetDir(): Promise<string> {
  if (resolvedSet) return resolvedSet;
  const explicit = dirOption ?? process.env.TPLKIT_SET_DIR;
  if (explicit) {
    const directory = resolve(explicit);
    await access(join(directory, 'manifest.json')).catch(() => { throw new Error(`${directory} 里没有 manifest.json，不是模板集目录`); });
    resolvedSet = directory;
  } else {
    const index = instanceIndex();
    const bound = index === undefined ? '' : (await new AutomationSettingsStore(HOME).get(wanlongPlugin.id, index)).templateDir;
    if (bound) {
      resolvedSet = bound;
    } else {
      const library = new TemplateLibrary(HOME);
      const found = (await library.managedSets(wanlongPlugin.id)).find((set) => set.name === SET_NAME);
      const set = found ?? await library.createSet(wanlongPlugin.id, SET_NAME, wanlongPlugin.packageName, REF.width, REF.height);
      if (!found) console.error(`[tplkit] 新建模板集 ${set.name}（${set.id}）`);
      resolvedSet = set.directory;
    }
  }
  console.error(`[tplkit] 模板集：${resolvedSet}`);
  return resolvedSet;
}

/** Captures a raw frame from an AVD instance (no throttle), stores the PNG and a 1280-wide JPEG for eyes. */
async function cmdCap(name: string): Promise<void> {
  const manager = await AvdManager.open();
  try {
    let index = instanceIndex();
    if (index === undefined) {
      const running = (await manager.list()).find((state) => state.status === 'running');
      if (!running) throw new Error('没有运行中的实例，无法抓帧（可用 WL_INSTANCE=<序号> 指定）');
      index = running.record.index;
    }
    const state = await manager.getState(index);
    if (state.status !== 'running') throw new Error(`实例 #${index} 尚未就绪（${state.status}），请先启动并等待 Android 启动完成`);
    const raw = await (await manager.device(index)).screencapRaw();
    const png = await sharp(Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.width * raw.height * 4),
      { raw: { width: raw.width, height: raw.height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    const out = join(scratch(), 'frames', `${name}.png`);
    await ensureDir(out);
    await writeFile(out, png, { mode: 0o600 });
    const view = join(scratch(), 'view', `${name}.jpg`);
    await ensureDir(view);
    await sharp(png).resize({ width: 1280 }).jpeg({ quality: 80 }).toFile(view);
    if (raw.width !== REF.width) console.error(`[tplkit] 注意：画面 ${raw.width}×${raw.height} 不是参考分辨率 ${REF.width}×${REF.height}，模板会被放大，字形可能不可靠。`);
    console.log(JSON.stringify({ ok: true, instance: index, out, view, w: raw.width, h: raw.height }));
  } finally {
    await manager.dispose().catch(() => undefined);
  }
}

async function cmdView(framePng: string, x: number, y: number, w: number, h: number, out: string, zoom: number): Promise<void> {
  await ensureDir(out);
  await sharp(framePng).extract({ left: x, top: y, width: w, height: h }).resize({ width: Math.round(w * zoom), kernel: 'nearest' }).png().toFile(out);
  console.log(JSON.stringify({ ok: true, out, zoom }));
}

async function grayRegion(framePng: string, r: Rect): Promise<tplkit.GrayRegion> {
  const buf = await sharp(framePng).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).greyscale().raw().toBuffer();
  return { w: r.w, h: r.h, gray: new Uint8Array(buf) };
}

async function cmdAnalyze(framePng: string, rect: Rect, polarity?: string, thr?: number): Promise<void> {
  const report = tplkit.analyzeRegion(await grayRegion(framePng, rect), rect, polarity, thr ?? 45, SHRINK);
  console.log(JSON.stringify(report, null, 1));
}

async function cmdProbe(framePng: string, x: number, y: number, n: number): Promise<void> {
  const half = Math.floor(n / 2);
  const buf = await sharp(framePng).extract({ left: x - half, top: y - half, width: n, height: n }).raw().toBuffer();
  const ch = buf.length / (n * n);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n * n; i++) { r += buf[i * ch]!; g += buf[i * ch + 1]!; b += buf[i * ch + 2]!; }
  const k = n * n;
  console.log(JSON.stringify({ at: [x, y], n, rgb: [Math.round(r / k), Math.round(g / k), Math.round(b / k)] }));
}

async function cmdGlyphs(framePng: string, rect: Rect, polarity: string, thr: number, chars: string, prefix: string, outFile: string, pad: number, minSegW: number): Promise<void> {
  const meta = await sharp(framePng).metadata();
  if (meta.width !== REF.width) console.error(`[tplkit] 注意：字形应从 ${REF.width} 宽的帧上切，当前帧宽 ${meta.width}。`);
  const result = tplkit.cutGlyphJobs(await grayRegion(framePng, rect), { frame: framePng, rect, polarity, thr, chars, prefix, pad, minSegW });
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }
  await ensureDir(outFile);
  await writeFile(outFile, JSON.stringify(result.jobs, null, 1), 'utf8');
  console.log(JSON.stringify({ ok: true, out: outFile, count: result.jobs.length, glyphRow: result.glyphRow, glyphH: result.glyphH, widths: result.widths, ids: result.ids }));
}

async function cmdAlpha(rect: Rect, out: string, tolerance: number, frames: string[]): Promise<void> {
  const buffers = await Promise.all(frames.map((file) => readFile(file)));
  const preview = await renderAlphaPreview(buffers, rect, { tolerance, previewWidth: Math.min(1200, rect.w * 4) });
  await ensureDir(out);
  await writeFile(out, preview.previewPng);
  console.log(JSON.stringify({ ok: true, out, coverage: Number(preview.coverage.toFixed(3)), tol: tolerance, frames: frames.length }));
}

async function cmdSave(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as tplkit.SaveJob[];
  const directory = await resolveSetDir();
  const library = new TemplateLibrary(HOME);
  const out: unknown[] = [];
  for (const job of jobs) {
    try {
      const png = await readFile(job.frame);
      const meta = await sharp(png).metadata();
      const diffFrames = job.diffFrames?.length ? await Promise.all(job.diffFrames.map((file) => readFile(file))) : undefined;
      // The job names a fixed id on purpose: saving it again replaces that template (the original behaviour).
      const saved = await library.save(directory, {
        id: job.id, name: job.name, image: png, authoredWidth: meta.width ?? REF.width, authoredHeight: meta.height ?? REF.height,
        crop: job.crop, defaultRoi: job.defaultRoi, threshold: job.threshold, tags: job.tags, note: job.note,
        diffFrames, diffTolerance: job.diffTolerance, overwrite: true,
      });
      out.push({ id: saved.definition.id, ok: true, std: saved.definition.std, bounds: saved.definition.bounds, roi: saved.definition.defaultRoi,
        maskCoverage: saved.maskCoverage ?? null, diffCoverage: saved.diffCoverage ?? null });
    } catch (error) {
      out.push({ id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify(out, null, 1));
}

const frameCache = new Map<string, PreparedFrame>();

async function preparedFromPng(png: string): Promise<PreparedFrame> {
  const hit = frameCache.get(png);
  if (hit) return hit;
  const image = sharp(png).ensureAlpha();
  const meta = await image.metadata();
  const raw = await image.raw().toBuffer();
  const frame = await prepareFrame({ width: meta.width ?? REF.width, height: meta.height ?? REF.height, format: 1, data: new Uint8Array(raw), capturedAt: Date.now() },
    { refW: REF.width, refH: REF.height, shrink: SHRINK });
  frameCache.set(png, frame);
  return frame;
}

async function preparedSet(): Promise<Map<string, PreparedTemplate>> {
  const { templates, failed } = await loadPreparedSet(await resolveSetDir(), { shrink: SHRINK, onWarn: (message) => console.error(`[tplkit] ${message}`) });
  if (failed.length) console.error(`[tplkit] ${failed.length} 张模板编译失败，已跳过`);
  return templates;
}

async function cmdVerify(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as tplkit.VerifyJob[];
  const templates = await preparedSet();
  const out: unknown[] = [];
  for (const job of jobs) {
    const tpl = templates.get(job.id);
    if (!tpl) { out.push({ id: job.id, ok: false, error: '模板未编译出来（可能存盘失败）' }); continue; }
    const hit = await matchTemplate(await preparedFromPng(job.pos.frame), tpl, { roi: job.pos.roi, threshold: job.threshold });
    const negatives = [];
    for (const neg of job.neg) {
      const m = await matchTemplate(await preparedFromPng(neg.frame), tpl, { roi: neg.roi, threshold: job.threshold });
      negatives.push({ label: neg.label ?? basename(neg.frame), found: m.found, score: m.score, reason: m.reason });
    }
    const verdict = tplkit.verifyVerdict(hit, job.pos.expect, negatives);
    out.push({
      id: job.id, ok: verdict.ok, std: tpl.std, masked: tpl.maskCoverage ?? null, size: [tpl.refW, tpl.refH],
      pos: { found: hit.found, score: hit.score, at: [hit.x, hit.y], center: [hit.centerX, hit.centerY], dx: verdict.dx, dy: verdict.dy },
      neg: negatives,
    });
  }
  console.log(JSON.stringify(out, null, 1));
}

async function cmdCross(jobFile: string): Promise<void> {
  const jobs = JSON.parse(await readFile(jobFile, 'utf8')) as Array<{ id: string; frame: string; roi: Rect }>;
  const templates = await preparedSet();
  const rows: Array<Record<string, unknown>> = [];
  let worst = { self: '', other: '', score: -1 };
  for (const a of jobs) {
    const tpl = templates.get(a.id);
    if (!tpl) { rows.push({ id: a.id, error: '模板缺失' }); continue; }
    const row: Record<string, unknown> = { id: a.id, std: tpl.std };
    for (const b of jobs) {
      const m = await matchTemplate(await preparedFromPng(b.frame), tpl, { roi: b.roi, threshold: 0.01 });
      row[b.id] = m.score;
      if (a.id !== b.id && m.score > worst.score) worst = { self: a.id, other: b.id, score: m.score };
    }
    rows.push(row);
  }
  console.log(JSON.stringify({ rows, worstCross: worst }, null, 1));
}

async function cmdOcr(framePng: string, rect: Rect, polarity: string, thr: number, expect: string, setPrefix: string, minSegW: number): Promise<void> {
  const seg = tplkit.segmentGlyphs(await grayRegion(framePng, rect), polarity, thr, minSegW);
  const templates = await preparedSet();
  const members = [...templates.values()].filter((t) => t.id.startsWith(`${setPrefix}_`));
  if (!members.length) throw new Error(`模板集里没有前缀为 ${setPrefix}_ 的字形`);
  const maxTplW = Math.max(...members.map((t) => t.refW));
  const frame = await preparedFromPng(framePng);
  const got: string[] = [];
  const detail: unknown[] = [];
  for (const s of seg.segs) {
    const roi = tplkit.ocrSegmentRoi(s, rect, maxTplW);
    const scores = [];
    for (const t of members) scores.push({ id: t.id, score: (await matchTemplate(frame, t, { roi, threshold: 0.01 })).score });
    const best = tplkit.pickBest(scores);
    const c = tplkit.glyphIdToChar(best.id, setPrefix);
    got.push(c);
    detail.push({ at: rect.x + s.x0, w: s.x1 - s.x0 + 1, pick: c, score: Number(best.score.toFixed(4)), margin: Number(best.margin.toFixed(4)) });
  }
  const text = got.join('');
  console.log(JSON.stringify({ setPrefix, frame: basename(framePng), expect, got: text, ok: text === expect, segs: seg.segs.length, wanted: [...expect].length, detail }, null, 1));
  if (text !== expect) process.exitCode = 2;
}

async function cmdFind(id: string, framePng: string, roiJson?: string): Promise<void> {
  const tpl = (await preparedSet()).get(id);
  if (!tpl) throw new Error(`模板 ${id} 不存在`);
  const roi = roiJson ? JSON.parse(roiJson) as Rect : undefined;
  const m = await matchTemplate(await preparedFromPng(framePng), tpl, { roi, threshold: 0.5 });
  console.log(JSON.stringify({ frame: basename(framePng), found: m.found, score: m.score, at: [m.x, m.y], wh: [m.w, m.h], center: [m.centerX, m.centerY] }));
}

async function cmdScan(framesDir: string, prefix: string): Promise<void> {
  const templates = await preparedSet();
  const defs = (await loadTemplateSet(await resolveSetDir())).templates;
  const byId = new Map(defs.map((d) => [d.id, d]));
  const names = (await readdir(framesDir)).filter((f) => f.endsWith('.png')).sort();
  const frames = new Map<string, PreparedFrame>();
  for (const n of names) frames.set(n, await preparedFromPng(join(framesDir, n)));
  const rows: unknown[] = [];
  for (const t of [...templates.values()].filter((item) => item.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id))) {
    const roi = byId.get(t.id)?.defaultRoi;
    const hits: Array<{ f: string; s: number; at: [number, number] }> = [];
    let maxMiss = 0;
    for (const [n, f] of frames) {
      const m = await matchTemplate(f, t, { roi });
      if (m.found) hits.push({ f: n.replace('.png', ''), s: Number(m.score.toFixed(3)), at: [m.x, m.y] });
      else if (m.score > maxMiss) maxMiss = m.score;
    }
    rows.push({ id: t.id, std: Number(t.std.toFixed(1)), size: [t.refW, t.refH], hitCount: hits.length, bestMiss: Number(maxMiss.toFixed(3)), hits });
  }
  console.log(JSON.stringify(rows, null, 1));
}

async function cmdDel(prefix: string): Promise<void> {
  const directory = await resolveSetDir();
  const library = new TemplateLibrary(HOME);
  const hit = (await library.load(directory)).templates.filter((t) => t.id === prefix || t.id.startsWith(prefix));
  for (const t of hit) await library.delete(directory, t.id);
  console.log(JSON.stringify({ deleted: hit.map((t) => t.id) }));
}

async function cmdList(): Promise<void> {
  const set = await loadTemplateSet(await resolveSetDir());
  console.log(JSON.stringify(set.templates.map((t) => ({ id: t.id, name: t.name, std: t.std, bounds: t.bounds, roi: t.defaultRoi, tags: t.tags, note: t.note })), null, 1));
}

function rectArgs(from: number): Rect {
  return { x: num(argv[from]), y: num(argv[from + 1]), w: num(argv[from + 2]), h: num(argv[from + 3]) };
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'scan': await cmdScan(need(argv[1], '帧目录'), argv[2] ?? 'tpl_'); break;
    case 'del': await cmdDel(need(argv[1], 'id 或前缀')); break;
    case 'ls': await cmdList(); break;
    case 'ocr': await cmdOcr(need(argv[1], '帧'), rectArgs(2), need(argv[6], '极性'), num(argv[7]), need(argv[8], '期望文本'), need(argv[9], '字形前缀'), num(argv[10], 3)); break;
    case 'find': await cmdFind(need(argv[1], '模板 id'), need(argv[2], '帧'), argv[3]); break;
    case 'cap': await cmdCap(argv[1] ?? 'frame'); break;
    case 'view': { const r = rectArgs(2); await cmdView(need(argv[1], '帧'), r.x, r.y, r.w, r.h, need(argv[6], '输出文件'), num(argv[7], 4)); break; }
    case 'analyze': await cmdAnalyze(need(argv[1], '帧'), rectArgs(2), argv[6], argv[7] ? num(argv[7]) : undefined); break;
    case 'probe': await cmdProbe(need(argv[1], '帧'), num(argv[2]), num(argv[3]), num(argv[4], 5)); break;
    case 'glyphs': await cmdGlyphs(need(argv[1], '帧'), rectArgs(2), need(argv[6], '极性'), num(argv[7]), need(argv[8], '字符'), need(argv[9], '字形前缀'), need(argv[10], '输出作业'), num(argv[11], 2), num(argv[12], 2)); break;
    case 'alpha': await cmdAlpha(rectArgs(1), need(argv[5], '输出文件'), num(argv[6]), argv.slice(7)); break;
    case 'save': await cmdSave(need(argv[1], '作业文件')); break;
    case 'verify': await cmdVerify(need(argv[1], '作业文件')); break;
    case 'cross': await cmdCross(need(argv[1], '作业文件')); break;
    default:
      console.error('用法：tplkit cap|view|analyze|probe|alpha|glyphs|save|verify|cross|ocr|find|scan|ls|del ... [--dir <模板集目录>]');
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
