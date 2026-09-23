import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import type { WebContents } from 'electron';
import { errorCode, errorMessage, asIndex } from '@avdm/emulator-shell/main/util';
import { isAppUrl, type WindowKind, type WindowManager } from '@avdm/emulator-shell/main/windows';
import type { IpcEnvelope } from '@avdm/emulator-shell/main/ipc-handlers';
import { WANLONG_INVOKE_METHODS, wanlongInvokeChannel, type WanlongApi, type WanlongInvokeMethod } from '../shared/ipc';
import { gamePlugin } from './automation/games';
import type { AutomationHost } from './automation/host';
import type { AccountManager } from './automation/accounts';
import type { AdvisorService } from './automation/advisor';
import type { InsightsService } from './automation/insights';
import type { PlanService } from './plans';
import type { ReadOnlyTelegramBot } from './monitoring';

export interface WanlongServices {
  automation: AutomationHost;
  accounts: AccountManager;
  insights: InsightsService;
  plans: PlanService;
  remoteBot: ReadOnlyTelegramBot;
  advisor: AdvisorService;
  windows: WindowManager;
}

interface HandlerContext extends WanlongServices { sender: WebContents }
type Handler<K extends WanlongInvokeMethod> = (
  ctx: HandlerContext, ...args: Parameters<WanlongApi[K]>
) => Promise<Awaited<ReturnType<WanlongApi[K]>>>;
type HandlerMap = { [K in WanlongInvokeMethod]: Handler<K> };

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}无效`);
  return value.trim();
}

function game(value: unknown): string {
  const id = text(value, '游戏 ID');
  gamePlugin(id);
  return id;
}

function optionalIndex(value: unknown): number | null {
  return value === null ? null : asIndex(value);
}

/** Game commands are unavailable to live windows and unknown renderer frames. */
export function authorizeWanlongInvoke(frameUrl: string | undefined, kind: WindowKind | undefined): void {
  if (!frameUrl || !isAppUrl(frameUrl)) throw new Error('拒绝来自未知页面的请求');
  if (kind !== 'main') throw new Error('此操作仅允许在万龙助手主窗口执行');
}

const handlers: HandlerMap = {
  async automationGames({ automation }) { return automation.games(); },
  async pickAutomationTemplateSet({ sender }) {
    const options: OpenDialogOptions = {
      title: '选择游戏模板集目录', buttonLabel: '选择模板集', properties: ['openDirectory'],
    };
    const win = BrowserWindow.fromWebContents(sender);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  async getAutomationSettings({ automation }, gameId, index) {
    return automation.settings(game(gameId), asIndex(index));
  },
  async saveAutomationSettings({ automation }, gameId, index, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('自动化设置无效');
    return automation.saveSettings(game(gameId), asIndex(index), patch);
  },
  async probeAutomation({ automation }, gameId, index) {
    return automation.probe(game(gameId), asIndex(index));
  },
  async runAutomation({ automation }, gameId, taskId, index) {
    return automation.run(game(gameId), text(taskId, '任务 ID'), asIndex(index));
  },
  async stopAutomation({ automation }, runId) {
    await automation.stop(text(runId, '运行 ID'));
  },
  async automationRuns({ automation }) { return automation.runs(); },
  async automationSchedules({ automation }) { return automation.schedules(); },
  async setAutomationSchedule({ automation, plans }, gameId, index, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('自动续跑开关无效');
    const id = game(gameId);
    const i = asIndex(index);
    if (enabled && (plans.isActiveForInstance(i) || await plans.hasEnabledPlanForInstance(id, i))) {
      throw new Error(`实例 #${i} 已有脚本计划，请先关闭计划后再启用自动采集`);
    }
    return automation.setSchedule(id, i, enabled);
  },

  async automationTemplateSets({ automation }, gameId) {
    return automation.templateSets(game(gameId));
  },
  async createAutomationTemplateSet({ automation }, gameId, index, name) {
    return automation.createTemplateSet(game(gameId), asIndex(index), text(name, '模板集名称'));
  },
  async automationTemplateSet({ automation }, gameId, index) {
    return automation.templateSet(game(gameId), asIndex(index));
  },
  async automationTemplateImage({ automation }, gameId, index, id) {
    return automation.templateImage(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
  async captureAutomationTemplate({ automation }, gameId, index) {
    return automation.captureTemplate(game(gameId), asIndex(index));
  },
  async previewAutomationTemplateAlpha({ automation }, gameId, index, frames, crop, tolerance) {
    if (!Array.isArray(frames) || !frames.every((frame) => frame instanceof Uint8Array)) throw new Error('去底截图无效');
    return automation.previewTemplateAlpha(game(gameId), asIndex(index), frames, crop, tolerance);
  },
  async saveAutomationTemplate({ automation }, gameId, index, draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('模板草稿无效');
    return automation.saveTemplate(game(gameId), asIndex(index), draft);
  },
  async deleteAutomationTemplate({ automation }, gameId, index, id) {
    await automation.deleteTemplate(game(gameId), asIndex(index), text(id, '模板 ID'));
  },
  async testAutomationTemplate({ automation }, gameId, index, id) {
    return automation.testTemplate(game(gameId), asIndex(index), text(id, '模板 ID'));
  },

  async accountList({ accounts }, gameId) { return accounts.list(game(gameId)); },
  async accountCreate({ accounts }, gameId, details) {
    return accounts.create(game(gameId), details);
  },
  async accountUpdate({ accounts }, id, patch) {
    return accounts.update(text(id, '账号 ID'), patch);
  },
  async accountDelete({ accounts }, id) { await accounts.remove(text(id, '账号 ID')); },
  async accountBind({ accounts }, id, index) {
    return accounts.bind(text(id, '账号 ID'), optionalIndex(index));
  },
  async accountSetEnabled({ accounts }, id, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('账号开关无效');
    return accounts.setEnabled(text(id, '账号 ID'), enabled);
  },
  async accountBeginLogin({ accounts }, gameId, index, id) {
    return accounts.beginLogin(game(gameId), asIndex(index), text(id, '账号 ID'));
  },
  async accountLoginSession({ accounts }, index) { return accounts.loginSession(asIndex(index)); },
  async accountLoginCommand({ accounts }, sessionId, command) {
    return accounts.loginCommand(text(sessionId, '登录会话 ID'), command);
  },
  async accountVerifyLogin({ accounts }, sessionId, identityConfirmed) {
    if (typeof identityConfirmed !== 'boolean') throw new Error('登录确认无效');
    return accounts.verifyLogin(text(sessionId, '登录会话 ID'), identityConfirmed);
  },
  async accountCancelLogin({ accounts }, sessionId) {
    await accounts.cancelLogin(text(sessionId, '登录会话 ID'));
  },

  async planOverview({ plans }, gameId) { return plans.overview(game(gameId)); },
  async planSaveConfig({ plans }, gameId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('计划配置无效');
    return plans.saveConfig(game(gameId), patch);
  },
  async planSave({ plans }, gameId, plan) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('账号计划无效');
    return plans.savePlan(game(gameId), plan);
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

  async insightDays({ insights }, gameId, index, days) {
    return insights.days(game(gameId), optionalIndex(index), days);
  },
  async insightAlerts({ insights }, gameId, index, limit) {
    return insights.alerts(game(gameId), optionalIndex(index), limit);
  },
  async getNotificationConfig({ insights }, gameId, index) {
    return insights.config(game(gameId), asIndex(index));
  },
  async saveNotificationConfig({ insights, remoteBot }, gameId, index, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('通知设置无效');
    const saved = await insights.saveConfig(game(gameId), asIndex(index), patch);
    await remoteBot.restart().catch((error: unknown) => console.warn('[wanlong] 只读机器人重载失败', error instanceof Error ? error.message : String(error)));
    return saved;
  },
  async testNotification({ insights }, gameId, index, channel) {
    if (channel !== 'local' && channel !== 'telegram') throw new Error('通知渠道无效');
    return insights.test(game(gameId), asIndex(index), channel);
  },
  async remoteBotConfig({ insights, remoteBot }) {
    return insights.remoteBotConfig(remoteBot.isRunning());
  },
  async saveRemoteBotConfig({ insights, remoteBot }, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('只读机器人设置无效');
    await insights.saveRemoteBotConfig(patch);
    await remoteBot.restart().catch((error: unknown) => console.warn('[wanlong] 只读机器人重载失败', error instanceof Error ? error.message : String(error)));
    return insights.remoteBotConfig(remoteBot.isRunning());
  },
  async testRemoteBot({ remoteBot }) { return remoteBot.testConnection(); },

  async advisorConfig({ advisor }) { return advisor.config(); },
  async saveAdvisorConfig({ advisor }, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('AI 设置无效');
    return advisor.saveConfig(patch);
  },
  async advisorStatus({ advisor }) { return advisor.status(); },
  async advisorHistory({ advisor }, limit) { return advisor.history(limit); },
  async testAdvisor({ advisor }) { return advisor.test(); },
  async consultAdvisor({ advisor }, gameId, index) {
    const id = game(gameId);
    const plugin = gamePlugin(id);
    return advisor.consult({ gameId: id, gameName: plugin.name, packageName: plugin.packageName,
      index: asIndex(index), context: '用户手动查看当前画面' });
  },
};

/** Register assistant-only channels after the generic emulator channels. */
export function registerWanlongIpcHandlers(services: WanlongServices): void {
  for (const method of WANLONG_INVOKE_METHODS) {
    const handler = handlers[method] as (ctx: HandlerContext, ...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(wanlongInvokeChannel(method), async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcEnvelope> => {
      try {
        authorizeWanlongInvoke(event.senderFrame?.url, services.windows.kindOf(event.sender));
        return { ok: true, value: await handler({ ...services, sender: event.sender }, ...args) };
      } catch (error) {
        const code = errorCode(error);
        return { ok: false, error: code ? { message: errorMessage(error), code } : { message: errorMessage(error) } };
      }
    });
  }
}
