/** One named start or stop step of an assistant service. */
export interface ServiceStep {
  /** Chinese service name used in the log line, e.g. 「脚本计划」. */
  name: string;
  run: () => unknown;
}

export interface ServiceStepFailure {
  name: string;
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
      failures.push({ name: step.name, error });
      try { log(`[wanlong] ${step.name}${phase === 'start' ? '启动' : '关闭'}失败`, error); }
      catch { /* Logging must not break the lifecycle. */ }
    }
  }
  return failures;
}
