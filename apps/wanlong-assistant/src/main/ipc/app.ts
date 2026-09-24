import type { AppApi } from '../../shared/ipc';
import type { ServiceHealth } from '../lifecycle';
import type { DomainHandlers } from './types';

/** Services the app handlers need; the app-shell module adds its own here. */
export interface AppServices {
  serviceHealth: Pick<ServiceHealth, 'list'>;
}

export const appHandlers: DomainHandlers<AppApi, AppServices> = {
  async appServiceFailures({ serviceHealth }) { return serviceHealth.list(); },
};
