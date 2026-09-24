import type { InstancesApi } from '../../shared/ipc';
import type { InstanceProvisioner } from '../instances/provisioner';
import type { DomainHandlers } from './types';
import { asIndex, game, optionalIndex, patchObject } from './validate';

/** Services the instances handlers need; later instance features append theirs here. */
export interface InstancesServices {
  provisioner: InstanceProvisioner;
}

export const instancesHandlers: DomainHandlers<InstancesApi, InstancesServices> = {
  async instanceBase({ provisioner }, gameId) { return provisioner.view(game(gameId)); },
  async instanceSetBase({ provisioner }, gameId, index) {
    return provisioner.setBase(game(gameId), optionalIndex(index));
  },
  async instanceCloneFromBase({ provisioner }, gameId, request) {
    const value = patchObject(request, '克隆参数');
    if (typeof value.count !== 'number') throw new Error('克隆数量无效');
    if (value.rotateIdentity !== undefined && typeof value.rotateIdentity !== 'boolean') throw new Error('设备标识选项无效');
    return provisioner.cloneFromBase(game(gameId), {
      count: value.count, expectedBaseIndex: asIndex(value.expectedBaseIndex),
      ...(value.rotateIdentity === undefined ? {} : { rotateIdentity: value.rotateIdentity }),
    });
  },
};
