import type { UpdateApi } from '../../shared/ipc';
import type { UpdateCenter } from '../update/center';
import type { DomainHandlers } from './types';

/** Services the update handlers need. */
export interface UpdateServices {
  updateCenter: Pick<UpdateCenter,
    'getState' | 'check' | 'download' | 'cancelDownload' | 'install' | 'openReleasePage' | 'revealDownload'>;
}

/** No handler takes renderer arguments: the main process alone decides what to fetch, save and open. */
export const updateHandlers: DomainHandlers<UpdateApi, UpdateServices> = {
  async updateState({ updateCenter }) { return updateCenter.getState(); },
  async updateCheck({ updateCenter }) { return updateCenter.check(); },
  async updateDownload({ updateCenter }) { return updateCenter.download(); },
  async updateCancelDownload({ updateCenter }) { return updateCenter.cancelDownload(); },
  async updateInstall({ updateCenter }) { await updateCenter.install(); },
  async updateOpenReleasePage({ updateCenter }) { await updateCenter.openReleasePage(); },
  async updateRevealDownload({ updateCenter }) { await updateCenter.revealDownload(); },
};
