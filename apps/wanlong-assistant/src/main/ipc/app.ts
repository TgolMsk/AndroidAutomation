import type { AppApi, AppLogLevel, AppLogQuery } from '../../shared/ipc';
import type { AppHealth } from '../app/health';
import type { AppLog } from '../app/app-log';
import type { InstanceOccupancy } from '../app/occupancy';
import { isAppPathKey, listAppPaths, openAppPath } from '../app/paths';
import type { AppSettingsStore } from '../app/settings-store';
import type { AppToasts } from '../app/toasts';
import type { ServiceHealth } from '../lifecycle';
import type { DomainHandlers } from './types';
import { asIndex, game, patchObject } from './validate';

/** Services the app handlers need. */
export interface AppServices {
  serviceHealth: Pick<ServiceHealth, 'list'>;
  appSettings: Pick<AppSettingsStore, 'ready' | 'view' | 'save'>;
  appLog: Pick<AppLog, 'query'>;
  appHealth: Pick<AppHealth, 'last' | 'check'>;
  appToasts: Pick<AppToasts, 'recent'>;
  occupancy: Pick<InstanceOccupancy, 'holders'>;
  /** AVDM_HOME: the root every data path is resolved under. */
  appHome: string;
}

const LOG_LEVELS: readonly AppLogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Renderer log filters are untrusted: every field is checked and bounded. */
function logQuery(value: unknown): AppLogQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('日志查询条件无效');
  const raw = value as Record<string, unknown>;
  const query: AppLogQuery = {};
  if (raw['minLevel'] !== undefined) {
    if (!LOG_LEVELS.includes(raw['minLevel'] as AppLogLevel)) throw new Error('日志级别无效');
    query.minLevel = raw['minLevel'] as AppLogLevel;
  }
  if (raw['scope'] !== undefined && raw['scope'] !== '') {
    if (typeof raw['scope'] !== 'string' || raw['scope'].length > 60) throw new Error('日志来源无效');
    query.scope = raw['scope'];
  }
  if (raw['index'] !== undefined && raw['index'] !== null) query.index = asIndex(raw['index']);
  if (raw['since'] !== undefined) {
    if (typeof raw['since'] !== 'number' || !Number.isFinite(raw['since'])) throw new Error('日志起始时间无效');
    query.since = raw['since'];
  }
  if (raw['search'] !== undefined && raw['search'] !== '') {
    if (typeof raw['search'] !== 'string' || raw['search'].length > 200) throw new Error('日志搜索词无效');
    query.search = raw['search'];
  }
  if (raw['limit'] !== undefined) {
    if (typeof raw['limit'] !== 'number' || !Number.isInteger(raw['limit']) || raw['limit'] < 1 || raw['limit'] > 2000) throw new Error('日志条数无效');
    query.limit = raw['limit'];
  }
  return query;
}

export const appHandlers: DomainHandlers<AppApi, AppServices> = {
  async appServiceFailures({ serviceHealth }) { return serviceHealth.list(); },
  async appSettings({ appSettings }) {
    await appSettings.ready;
    return appSettings.view();
  },
  async saveAppSettings({ appSettings }, patch) {
    patchObject(patch, '应用设置');
    await appSettings.ready;
    return appSettings.save(patch);
  },
  async appPaths({ appHome }, gameId) { return listAppPaths(appHome, game(gameId)); },
  async openAppPath({ appHome }, gameId, key) {
    const id = game(gameId);
    if (!isAppPathKey(key)) throw new Error('数据目录无效');
    await openAppPath(appHome, id, key);
  },
  async appHealth({ appHealth }) { return appHealth.last(); },
  async runAppHealthCheck({ appHealth }) { return appHealth.check(); },
  async appLogs({ appLog }, query) { return appLog.query(logQuery(query)); },
  async appRecentToasts({ appToasts }) { return appToasts.recent(); },
  async instanceOccupancy({ occupancy }, index) { return occupancy.holders(asIndex(index)); },
};
