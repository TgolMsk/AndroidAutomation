/**
 * Turn the white rounded-box resource artwork into transparent icons for the resource badges (gather overview rows,
 * gather config cards). Port of wanlong-panel's scripts/resource-icons.mjs:
 *
 *   pnpm --filter @avdm/wanlong-assistant run icons   # resources/icons/raw/{wood,gold,iron,mana}.(webp|png|jpg)
 *
 * Steps: ① crop 4% inward (drops the rounded outline); ② flood-fill from the border and make the connected
 * "bright and unsaturated" pixels (white background + soft grey shadow) transparent, so highlights inside the object
 * stay; ③ feather the 1~2 px edge; ④ trim to the opaque pixels and fit into 192 px.
 * Output: src/renderer/assets/resources/<type>.png, imported by src/renderer/components/ResourceBadge.tsx (which falls
 * back to the text badge when an image cannot be loaded).
 */
import sharp from 'sharp';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(APP, 'resources/icons/raw');
const OUT = join(APP, 'src/renderer/assets/resources');
const TYPES = ['wood', 'gold', 'iron', 'mana'];
const SIZE = 192;
/** A pixel at least this bright with low saturation counts as background / shadow. */
const BG_MIN = 212;
const BG_SAT = 14;

async function processOne(type, file) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  const w0 = meta.width, h0 = meta.height;
  const inset = Math.round(Math.min(w0, h0) * 0.04);
  const { data, info } = await img
    .extract({ left: inset, top: inset, width: w0 - inset * 2, height: h0 - inset * 2 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const isBg = (i) => {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mn >= BG_MIN && mx - mn <= BG_SAT;
  };
  // Flood fill: only background connected to the border becomes transparent.
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !isBg(i)) continue;
    bg[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  // Alpha: background 0; object pixels next to the background feathered by brightness; everything else 255.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) { data[i * 4 + 3] = 0; continue; }
    const x = i % w, y = (i - x) / w;
    const nearBg = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
    if (nearBg) {
      const mn = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      const a = mn <= 190 ? 255 : Math.round(255 * (1 - (mn - 190) / (255 - 190)));
      data[i * 4 + 3] = Math.max(40, a);
    } else data[i * 4 + 3] = 255;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error(`${file}：整张都被当成背景了，阈值不对`);
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
  const cx = Math.max(0, minX - pad), cy = Math.max(0, minY - pad);
  const cw = Math.min(w, maxX + pad + 1) - cx, ch = Math.min(h, maxY + pad + 1) - cy;
  const out = join(OUT, `${type}.png`);
  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: cx, top: cy, width: cw, height: ch })
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  const opaque = data.filter((_, i) => i % 4 === 3 && data[i] > 0).length;
  console.log(`${type}: ${file} → ${out}（不透明 ${(opaque / (w * h) * 100).toFixed(0)}%，裁边 ${cw}x${ch}）`);
}

await mkdir(OUT, { recursive: true });
const files = await readdir(RAW);
for (const type of TYPES) {
  const file = files.find((name) => name.replace(/\.[^.]+$/, '') === type);
  if (!file) { console.log(`${type}: resources/icons/raw 里没有这张，跳过（面板退回文字徽章）`); continue; }
  await processOne(type, join(RAW, file));
}
