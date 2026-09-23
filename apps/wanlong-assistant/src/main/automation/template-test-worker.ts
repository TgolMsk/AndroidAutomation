import { parentPort } from 'node:worker_threads';
import { matchTemplate, prepareFrame, prepareTemplate, type MatchResult, type RawFrame, type TemplateDefinition, type TemplateSet } from '@avdm/automation';

export interface TemplateTestWorkerInput {
  frame: RawFrame;
  set: TemplateSet;
  definition: TemplateDefinition;
  image: Uint8Array;
}

export type TemplateTestWorkerOutput =
  | { ok: true; match: MatchResult }
  | { ok: false; error: string };

if (!parentPort) throw new Error('模板测试工作线程缺少通信端口');

parentPort.once('message', (input: TemplateTestWorkerInput) => {
  void (async () => {
    const frame = await prepareFrame(input.frame, { refWidth: input.set.refWidth, refHeight: input.set.refHeight });
    const template = await prepareTemplate(input.image, input.definition, input.set);
    const match = await matchTemplate(frame, template);
    parentPort!.postMessage({ ok: true, match } satisfies TemplateTestWorkerOutput);
  })().catch((error: unknown) => {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies TemplateTestWorkerOutput);
  });
});
