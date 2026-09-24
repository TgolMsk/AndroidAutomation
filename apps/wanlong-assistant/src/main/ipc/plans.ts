import type { PlansApi } from '../../shared/ipc';
import type { PlanService } from '../plans';
import type { DomainHandlers } from './types';
import { game, patchObject, text } from './validate';

export interface PlansServices {
  plans: PlanService;
}

export const plansHandlers: DomainHandlers<PlansApi, PlansServices> = {
  async planOverview({ plans }, gameId) { return plans.overview(game(gameId)); },
  async planSaveConfig({ plans }, gameId, patch) {
    return plans.saveConfig(game(gameId), patchObject(patch, '计划配置'));
  },
  async planSave({ plans }, gameId, plan) {
    return plans.savePlan(game(gameId), patchObject(plan, '账号计划'));
  },
  async planRunNow({ plans }, gameId, accountId, taskId) {
    return plans.runNow(game(gameId), text(accountId, '账号 ID'), text(taskId, '任务 ID'));
  },
  async planCancelRun({ plans }, gameId, runId) {
    await plans.cancelRun(game(gameId), text(runId, '运行 ID'));
  },
  async scriptList({ plans }, gameId) { return plans.listScripts(game(gameId)); },
  async scriptGet({ plans }, gameId, id) { return plans.getScript(game(gameId), text(id, '脚本 ID')); },
  async scriptValidate({ plans }, gameId, raw) { return plans.validateScript(game(gameId), raw); },
  async scriptSave({ plans }, gameId, raw) { return plans.saveScript(game(gameId), raw); },
  async scriptDelete({ plans }, gameId, id) { await plans.deleteScript(game(gameId), text(id, '脚本 ID')); },
};
