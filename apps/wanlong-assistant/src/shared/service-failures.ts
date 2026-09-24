/** Wording for background services that failed to start (the original panel's startup warning). Pure. */
import type { ServiceFailure } from './ipc';

/** Why it failed, what is lost and that everything else still works. */
export function serviceFailureDetail(failure: ServiceFailure): string {
  const impact = failure.impact ? `${failure.impact}，` : '';
  return `${failure.message.replace(/[。.]$/, '')}。${impact}其余功能不受影响；排除问题后重启助手即可重试。`;
}

/** The full sentence, prefixed with the service name. */
export function describeServiceFailure(failure: ServiceFailure): string {
  return `${failure.name}没能启动：${serviceFailureDetail(failure)}`;
}

/** Short top-bar label for the current failures, or null when every service is up. */
export function serviceFailureLabel(failures: readonly ServiceFailure[]): string | null {
  if (failures.length === 0) return null;
  return failures.length === 1 ? `${failures[0]!.name}未启动` : `${failures.length} 项服务未启动`;
}
