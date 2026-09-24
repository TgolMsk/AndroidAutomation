import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import type { LoginPreviewRequest, LoginPreviewResponse } from './login-preview-contract';

if (!parentPort) throw new Error('登录画面工作线程缺少通信端口');
const port = parentPort;

/** Long-lived: one JPEG per request, so the preview never resizes full frames on the Electron main thread. */
port.on('message', (request: LoginPreviewRequest) => {
  const { id, width, height, data, maxWidth, quality } = request;
  void sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
    .resize({ width: Math.min(maxWidth, width) }).jpeg({ quality }).toBuffer({ resolveWithObject: true })
    .then(({ data: out, info }) => {
      const jpeg = new Uint8Array(out.byteLength);
      jpeg.set(out);
      port.postMessage({ id, ok: true, jpeg, width: info.width, height: info.height } satisfies LoginPreviewResponse, [jpeg.buffer]);
    })
    .catch(() => { port.postMessage({ id, ok: false } satisfies LoginPreviewResponse); });
});
