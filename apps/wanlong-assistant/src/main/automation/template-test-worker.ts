import { parentPort } from 'node:worker_threads';
import { runTemplateJob, type TemplateJob, type TemplateJobOutput } from './template-jobs';

/** One-shot template worker: a 「立即验证」 match or a full compile check. OpenCV and sharp stay off the main thread. */
export type TemplateTestWorkerInput = TemplateJob;
export type TemplateTestWorkerOutput = TemplateJobOutput;

if (!parentPort) throw new Error('模板测试工作线程缺少通信端口');

parentPort.once('message', (input: TemplateTestWorkerInput) => {
  void runTemplateJob(input).then((output) => parentPort!.postMessage(output satisfies TemplateTestWorkerOutput));
});
