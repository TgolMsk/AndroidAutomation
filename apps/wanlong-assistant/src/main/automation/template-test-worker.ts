import { parentPort } from 'node:worker_threads';
import { runTemplateJob, type TemplateJob, type TemplateJobOutput } from './template-jobs';

/**
 * One-shot template worker: a 「立即验证」 match, a full compile check, a 透明底 preview or a save's diff mask.
 * OpenCV, sharp decodes and per-pixel loops stay off the main thread.
 */
export type TemplateTestWorkerInput = TemplateJob;
export type TemplateTestWorkerOutput = TemplateJobOutput;

if (!parentPort) throw new Error('模板测试工作线程缺少通信端口');

parentPort.once('message', (input: TemplateTestWorkerInput) => {
  void runTemplateJob(input).then((output) => parentPort!.postMessage(output satisfies TemplateTestWorkerOutput));
});
