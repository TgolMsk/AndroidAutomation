import { NOTIFIER_IDS, type AlertsConfigPatch, type NotifierId } from '../../shared/alerts';
import type { AlertsApi } from '../../shared/ipc';
import type { AlertsService } from '../alerts';
import type { DomainHandlers } from './types';
import { asIndex, patchObject, text } from './validate';

/** Services the alerts handlers need. */
export interface AlertsServices {
  alerts: AlertsService;
}

export const alertsHandlers: DomainHandlers<AlertsApi, AlertsServices> = {
  async alertsConfig({ alerts }) {
    await alerts.hub.ready;
    return alerts.hub.getConfigView();
  },
  async saveAlertsConfig({ alerts }, patch) {
    return alerts.hub.saveConfig(patchObject(patch as AlertsConfigPatch, '告警设置'));
  },
  async testAlertPush({ alerts }, channel) {
    if (!(NOTIFIER_IDS as readonly string[]).includes(channel)) throw new Error('通知渠道无效');
    return alerts.hub.test(channel as NotifierId);
  },
  async alertPauses({ alerts }) {
    return alerts.center.listPauses();
  },
  async resumeAlertPause({ alerts }, index) {
    return alerts.resume(asIndex(index));
  },
  async alertHistory({ alerts }, limit) {
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('告警条数无效');
    await alerts.center.ready;
    return alerts.center.history(limit);
  },
  async alertScreenshot({ alerts }, shotPath) {
    return alerts.screenshot(text(shotPath, '截图路径'));
  },
  async freezeStatus({ alerts }) {
    return alerts.freezeStatus();
  },
};
