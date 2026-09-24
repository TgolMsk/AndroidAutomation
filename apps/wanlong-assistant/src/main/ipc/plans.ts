import type { PlansApi } from '../../shared/ipc';
import { PLAN_ACCOUNT_RE } from '../../shared/plan';
import type { PlanService } from '../plans';
import type { DomainHandlers } from './types';
import { flag, game, optionalIndex, patchObject, text } from './validate';

export interface PlansServices {
  plans: PlanService;
}

function accountId(value: unknown): string {
  const id = text(value, '账号 ID');
  if (!PLAN_ACCOUNT_RE.test(id)) throw new Error('账号 ID无效');
  return id;
}

export const plansHandlers: DomainHandlers<PlansApi, PlansServices> = {
  async planOverview({ plans }, gameId) { return plans.overview(game(gameId)); },
  async planSaveConfig({ plans }, gameId, patch) {
    return plans.saveConfig(game(gameId), patchObject(patch, '计划配置'));
  },
  async planSave({ plans }, gameId, plan) {
    return plans.savePlan(game(gameId), patchObject(plan, '账号计划'));
  },
  async planRunNow({ plans }, gameId, account, taskId) {
    return plans.runNow(game(gameId), accountId(account), text(taskId, '任务 ID'));
  },
  async planCancelRun({ plans }, gameId, runId) {
    await plans.cancelRun(game(gameId), text(runId, '运行 ID'));
  },
  async scriptList({ plans }, gameId) { return plans.listScripts(game(gameId)); },
  async scriptGet({ plans }, gameId, id) { return plans.getScript(game(gameId), text(id, '脚本 ID')); },
  async scriptValidate({ plans }, gameId, raw, index) {
    return plans.validateScript(game(gameId), raw, index === undefined ? null : optionalIndex(index));
  },
  async scriptSave({ plans }, gameId, raw) { return plans.saveScript(game(gameId), raw); },
  async scriptDelete({ plans }, gameId, id) { await plans.deleteScript(game(gameId), text(id, '脚本 ID')); },
  async planGet({ plans }, gameId, account) { return plans.getPlan(game(gameId), accountId(account)); },
  async planSetTaskEnabled({ plans }, gameId, account, taskId, enabled) {
    return plans.setTaskEnabled(game(gameId), accountId(account), text(taskId, '任务 ID'), flag(enabled, '任务开关'));
  },
  async planSetAccountEnabled({ plans }, gameId, account, enabled) {
    return plans.setAccountEnabled(game(gameId), accountId(account), flag(enabled, '账号计划开关'));
  },
  async planCancel({ plans }, gameId, account, taskId) {
    return plans.cancelTask(game(gameId), accountId(account), text(taskId, '任务 ID'));
  },
  async planRemoveTask({ plans }, gameId, account, taskId) {
    return plans.removeTask(game(gameId), accountId(account), text(taskId, '任务 ID'));
  },
  async planConfig({ plans }, gameId) { return plans.config(game(gameId)); },
};
