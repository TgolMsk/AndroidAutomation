import { parentPort } from 'node:worker_threads';
import { attachScriptWorker } from './script-worker-core';

/** Thread entry of the script executor (bundled as `script-worker.js` beside the main bundle). */
if (!parentPort) throw new Error('脚本执行线程缺少通信端口');
attachScriptWorker(parentPort as unknown as Parameters<typeof attachScriptWorker>[0]);
