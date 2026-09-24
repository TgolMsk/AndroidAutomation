/**
 * Turn the dragon logo (build/logo-source.png, alpha kept) into the app icons:
 *   build/app-icon.png (1024), build/app-icon.icns (macOS, 16~1024), src/renderer/assets/brand/app-icon.png (256,
 *   the sidebar mark).
 *
 *   pnpm --filter @avdm/wanlong-assistant run icons:app
 *
 * Only sizes and container formats change; the artwork is never redrawn. Port of wanlong-panel's
 * scripts/app-icons.mjs; this app only ships a macOS package, so no ICO is generated.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(app, 'build');
const renderer = resolve(app, 'src/renderer/assets/brand');
await mkdir(renderer, { recursive: true });
const sizes = [16, 32, 64, 128, 256, 512, 1024];
const pngs = new Map();
for (const size of sizes) {
  pngs.set(size, await sharp(resolve(build, 'logo-source.png')).resize(size, size).png().toBuffer());
}
await writeFile(resolve(build, 'app-icon.png'), pngs.get(1024));
await writeFile(resolve(renderer, 'app-icon.png'), pngs.get(256));

// ICNS: an 8-byte header ('icns' + total length) followed by one PNG chunk per size (type code + chunk length + PNG).
const icnsEntries = [
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
];
const chunks = icnsEntries.map(([size, type]) => {
  const png = pngs.get(size);
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, 'ascii');
  chunk.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([chunk, png]);
});
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 'ascii');
icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(resolve(build, 'app-icon.icns'), Buffer.concat([icnsHeader, ...chunks]));
console.log('已生成 app-icon.png、macOS ICNS 和侧栏标志。');
