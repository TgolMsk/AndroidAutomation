import { parentPort } from 'node:worker_threads';
import { probeGame, type ProbeReport, type RawFrame } from '@avdm/automation';
import { gamePlugin } from './games';

export interface ProbeWorkerInput {
  gameId: string;
  templateDir: string;
  foregroundPackage: string | null;
  frame: RawFrame;
}

export type ProbeWorkerOutput =
  | { ok: true; report: ProbeReport }
  | { ok: false; error: string };

if (!parentPort) throw new Error('图像识别工作线程缺少通信端口');

parentPort.once('message', (input: ProbeWorkerInput) => {
  void (async () => {
    const plugin = gamePlugin(input.gameId);
    const report = await probeGame({
      plugin,
      templateDir: input.templateDir,
      device: {
        capture: async () => input.frame,
        foregroundPackage: async () => input.foregroundPackage,
      },
    });
    parentPort!.postMessage({ ok: true, report } satisfies ProbeWorkerOutput);
  })().catch((error: unknown) => {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies ProbeWorkerOutput);
  });
});
