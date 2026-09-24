/** Assistant-side instance operations: base instance, batch clone and occupancy checks. */
import type {
  BaseInstanceView, CloneFromBaseRequest, CloneFromBaseResult, InstanceBaseChangedEvent,
} from '../../main/instances/types';
import type { Assert, ListsExactly } from './contract';

export interface InstancesApi {
  /** The game's base instance, validated against the live AVD (a deleted or replaced base is cleared). */
  instanceBase(gameId: string): Promise<BaseInstanceView>;
  /** Mark an instance as the clone source of this game, or `null` to cancel. */
  instanceSetBase(gameId: string, index: number | null): Promise<BaseInstanceView>;
  /** Clone 1–8 copies from the stopped base; copies inherit its template set. */
  instanceCloneFromBase(gameId: string, request: CloneFromBaseRequest): Promise<CloneFromBaseResult>;
}

export const INSTANCES_METHODS = [
  'instanceBase', 'instanceSetBase', 'instanceCloneFromBase',
] as const satisfies readonly (keyof InstancesApi)[];

export interface InstancesEvents {
  /** The base selection or its clone availability changed (set, cancelled, auto-cleared, clone finished). */
  'instance-base-changed': InstanceBaseChangedEvent;
}

export const INSTANCES_EVENTS = ['instance-base-changed'] as const satisfies readonly (keyof InstancesEvents)[];

export type InstancesContractCheck = [
  Assert<ListsExactly<InstancesApi, typeof INSTANCES_METHODS>>,
  Assert<ListsExactly<InstancesEvents, typeof INSTANCES_EVENTS>>,
];
