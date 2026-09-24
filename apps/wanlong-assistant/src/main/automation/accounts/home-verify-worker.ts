import { parentPort } from 'node:worker_threads';
import { matchHomeTemplates } from './home-match';
import type { HomeVerifyWorkerInput, HomeVerifyWorkerOutput } from './home-verify-contract';

if (!parentPort) throw new Error('登录检查工作线程缺少通信端口');

parentPort.once('message', (input: HomeVerifyWorkerInput) => {
  void matchHomeTemplates(input).then(({ matches, missing }) => {
    parentPort!.postMessage({ ok: true, matches, missing } satisfies HomeVerifyWorkerOutput);
  }).catch((error: unknown) => {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies HomeVerifyWorkerOutput);
  });
});
