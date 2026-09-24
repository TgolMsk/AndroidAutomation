import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawFrame } from '@avdm/automation';
import { decideHome, gameLoginDriver } from './drivers';
import {
  HOME_TEMPLATE_SET_MISSING, HOME_TEMPLATE_SET_REQUIRED, type HomeVerifyWorkerInput, type HomeVerifyWorkerOutput,
} from './home-verify-contract';
import type { HomeVerdict } from './types';

export {
  HOME_TEMPLATE_SET_MISSING, HOME_TEMPLATE_SET_REQUIRED, HOME_TEMPLATES_MISSING, type HomeVerifyMatch, type HomeVerifyWorkerInput,
  type HomeVerifyWorkerOutput,
} from './home-verify-contract';

const WORKER_TIMEOUT_MS = 120_000;

export interface HomeVerifyPorts {
  /** Read-only capture that requires the game in the foreground (AutomationHost.captureReadOnly). */
  capture(gameId: string, index: number): Promise<{ frame: RawFrame; foregroundPackage: string | null }>;
  /** Template set of the instance; the composition root falls back to the base instance's set. Empty = none. */
  templateDir(gameId: string, index: number): Promise<string>;
  /** Tests inject a fake; production matches in `home-verify-worker` (OpenCV never runs on the main thread). */
  runWorker?(input: HomeVerifyWorkerInput): Promise<HomeVerifyWorkerOutput>;
}

/**
 * The login wizard's home proof (original `login/verify.ts`): one read-only frame, the game's city / world-map
 * templates, any hit at its own threshold passes. No frame is persisted and nothing is sent to AI.
 */
export class HomeVerifier {
  private readonly workers = new Set<Worker>();
  private disposed = false;

  constructor(private readonly ports: HomeVerifyPorts) {}

  /**
   * Checked before the wizard takes the instance (`AccountManagerPorts.homeCheckIssue`): without a template set the
   * home proof can never pass, and choosing one needs the device lease the wizard would then hold.
   */
  async precheck(gameId: string, index: number): Promise<string | null> {
    if (!gameLoginDriver(gameId)) return null;
    return (await this.ports.templateDir(gameId, index)) ? null : HOME_TEMPLATE_SET_REQUIRED;
  }

  async verify(gameId: string, index: number): Promise<HomeVerdict> {
    const driver = gameLoginDriver(gameId);
    if (!driver) throw new Error('该游戏没有登录验证适配器');
    const templateDir = await this.ports.templateDir(gameId, index);
    if (!templateDir) throw new Error(HOME_TEMPLATE_SET_MISSING);
    const { frame, foregroundPackage } = await this.ports.capture(gameId, index);
    if (this.disposed) throw new Error('应用正在退出');
    const output = await (this.ports.runWorker ?? ((input) => this.runWorker(input)))({
      gameId, templateDir, templateIds: [...driver.homeTemplates], foregroundPackage, frame,
    });
    if (!output.ok) throw new Error(output.error);
    return decideHome(output.matches);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
  }

  private runWorker(input: HomeVerifyWorkerInput): Promise<HomeVerifyWorkerOutput> {
    // electron-vite emits this sibling entry for both dev and packaged builds.
    const worker = new Worker(join(dirname(fileURLToPath(import.meta.url)), 'home-verify-worker.js'));
    this.workers.add(worker);
    const pixels = Uint8Array.from(input.frame.data);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, output?: HomeVerifyWorkerOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.workers.delete(worker);
        void worker.terminate();
        if (output) resolve(output);
        else reject(error ?? new Error('登录检查未返回结果'));
      };
      const timer = setTimeout(() => finish(new Error('登录检查超时')), WORKER_TIMEOUT_MS);
      worker.once('message', (output: HomeVerifyWorkerOutput) => finish(undefined, output));
      worker.once('error', (error) => finish(error));
      worker.once('exit', (code) => finish(new Error(`登录检查工作线程已退出 (${code})`)));
      worker.postMessage({ ...input, frame: { ...input.frame, data: pixels } } satisfies HomeVerifyWorkerInput, [pixels.buffer]);
    });
  }
}
