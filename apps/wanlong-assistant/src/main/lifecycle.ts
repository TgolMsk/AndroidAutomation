import type { ServiceFailure } from '../shared/ipc';

/** One named start or stop step of an assistant service. */
export interface ServiceStep {
  /** Chinese service name used in the log line, e.g. 「脚本计划」. */
  name: string;
  /** What the user loses when this start step fails, shown with the failure, e.g. 「定时脚本不会自动运行」. */
  impact?: string;
  run: () => unknown;
}

export interface ServiceStepFailure {
  name: string;
  impact?: string;
  error: unknown;
}

export type ServiceStepLogger = (message: string, error: unknown) => void;

/** Only the message is logged: a stack or cause could carry a credential-bearing URL. */
const defaultLogger: ServiceStepLogger = (message, error) =>
  console.error(message, error instanceof Error ? error.message : String(error));

/**
 * Runs service steps in order, each isolated: a step that throws (or rejects) is logged as
 * `[wanlong] <name>启动失败` / `关闭失败` and the remaining steps still run. One broken store must never keep the
 * other services from starting, or from being stopped on quit. Returns the failures for callers that report them.
 */
export async function runServiceSteps(
  phase: 'start' | 'stop', steps: readonly ServiceStep[], log: ServiceStepLogger = defaultLogger,
): Promise<ServiceStepFailure[]> {
  const failures: ServiceStepFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push(step.impact ? { name: step.name, impact: step.impact, error } : { name: step.name, error });
      try { log(`[wanlong] ${step.name}${phase === 'start' ? '启动' : '关闭'}失败`, error); }
      catch { /* Logging must not break the lifecycle. */ }
    }
  }
  return failures;
}

/**
 * Start failures the user must hear about (the original panel showed them as a warning toast: 「…没能启动，其余功能
 * 不受影响」). Kept in main because `restore()` runs while the window is still loading: the renderer reads `list()`
 * on mount and then follows `notify` pushes. Only the message crosses IPC, never the error object.
 */
export class ServiceHealth {
  private failures: ServiceFailure[] = [];

  constructor(
    private readonly notify: (failures: ServiceFailure[]) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record start failures; a later failure of the same service replaces the earlier entry. */
  report(failures: readonly ServiceStepFailure[]): void {
    if (failures.length === 0) return;
    const at = this.now();
    for (const failure of failures) {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      const entry: ServiceFailure = { name: failure.name, message: message || '未知错误', at };
      if (failure.impact) entry.impact = failure.impact;
      this.failures = [...this.failures.filter((item) => item.name !== failure.name), entry];
    }
    try { this.notify(this.list()); }
    catch { /* A closed window must not break startup. */ }
  }

  list(): ServiceFailure[] {
    return this.failures.map((item) => ({ ...item }));
  }
}
