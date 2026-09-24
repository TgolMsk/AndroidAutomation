import type { HealthReport, ServiceFailure } from '../../shared/ipc';
import { serviceFailureDetail } from '../../shared/service-failures';
import { healthProblemSummary } from './health';
import type { AppToasts } from './toasts';

/**
 * One warning toast per service that failed to start in this `restore()` (original: 「…没能启动，其余功能不受影响」),
 * linked to the settings page where the 「后台服务未启动」 card lists them.
 */
export function announceServiceFailures(failures: readonly ServiceFailure[], toasts: Pick<AppToasts, 'push'>): void {
  for (const failure of failures) {
    toasts.push({ level: 'warn', title: `${failure.name}没能启动`, detail: serviceFailureDetail(failure), view: 'settings' });
  }
}

/** The startup self-check toast (original: 「环境自检发现 N 个问题：…请到「设置」页查看修复建议」); silent when all passed. */
export function announceHealth(report: HealthReport, toasts: Pick<AppToasts, 'push'>): void {
  const summary = healthProblemSummary(report);
  if (summary) toasts.push({ level: 'warn', title: summary, detail: '请到「设置」页的「环境自检」查看修复建议。', view: 'settings' });
}
