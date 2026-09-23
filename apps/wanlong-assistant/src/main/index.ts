import { bootstrapApp } from '@avdm/emulator-shell/main/bootstrap';
import { AccountManager } from './automation/accounts';
import { loginActive } from './automation/accounts/types';
import { AdvisorService } from './automation/advisor';
import { AutomationHost } from './automation/host';
import { InsightsService } from './automation/insights';
import { registerWanlongIpcHandlers } from './ipc-handlers';
import { MonitoringService, ReadOnlyTelegramBot } from './monitoring';
import { gamePlugin } from './automation/games';
import { PlanService } from './plans';

bootstrapApp({
  name: '万龙助手',
  rendererPage: 'index.html',
  createAddon(services, home) {
    const insights = new InsightsService(home);
    let monitoring: MonitoringService;
    const automation = new AutomationHost(services.host, home, undefined, undefined, {
      onCycle: async (run, result, source) => {
        await insights.recordCycle(run, result, source).catch((error: unknown) => console.error('[wanlong] 统计写入失败', error));
        await monitoring.recordCycle(run, result);
      },
      onFailure: async (run, error, source) => {
        await insights.recordFailure(run, error, source).catch((cause: unknown) => console.error('[wanlong] 失败统计写入失败', cause));
        await monitoring.recordFailure(run, error);
      },
      onScheduleStop: (gameId, index, count) => insights.recordScheduleStop(gameId, index, count),
    });
    const accounts = new AccountManager(services.host, automation, home);
    const advisor = new AdvisorService(home, (gameId, index) => automation.captureReadOnly(gameId, index));
    const plans = new PlanService(home, {
      accounts: (gameId) => accounts.list(gameId),
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await services.host.get()).device(index),
      templateDir: async (gameId, index) => (await automation.settings(gameId, index)).templateDir,
      gatherScheduleEnabled: async (gameId, index) =>
        (await automation.schedules()).some((item) => item.gameId === gameId && item.index === index && item.enabled),
    });
    monitoring = new MonitoringService(home, {
      async targets() {
        const [schedules, runs, states] = await Promise.all([
          automation.schedules(), automation.runs(), (await services.host.get()).list(),
        ]);
        const byIndex = new Map(states.map((state) => [state.record.index, state]));
        return schedules.filter((schedule) => schedule.enabled).flatMap((schedule) => {
          const state = byIndex.get(schedule.index);
          if (!state) return [];
          const login = accounts.loginSession(schedule.index);
          return [{
            gameId: schedule.gameId, index: schedule.index,
            packageName: gamePlugin(schedule.gameId).packageName,
            instanceIdentity: state.record.createdAt,
            instanceRunning: state.status === 'running',
            busy: plans.isActiveForInstance(schedule.index) ||
              runs.some((run) => run.index === schedule.index && (run.status === 'running' || run.status === 'stopping')) ||
              Boolean(login && loginActive(login.phase)),
          }];
        });
      },
      capture: (gameId, index) => automation.captureReadOnly(gameId, index),
      templateSet: (gameId, index) => automation.templateSet(gameId, index),
      testTemplate: (gameId, index, id) => automation.testTemplate(gameId, index, id),
      onAlert: (alert) => insights.recordMonitorAlert(alert),
      classifyCaptureError: (error) => error instanceof Error && error.message.startsWith('ADB 截图失败:') ? 'device' : 'unknown',
    });
    const remoteBot = new ReadOnlyTelegramBot({
      config: () => insights.readOnlyBotConfig(),
      async statuses() {
        const [states, schedules] = await Promise.all([
          (await services.host.get()).list(), automation.schedules(),
        ]);
        return states.map((state) => ({
          index: state.record.index, name: state.record.name, instanceStatus: state.status,
          automationStatus: schedules.some((item) => item.index === state.record.index && item.gameId === 'wanlong' && item.enabled)
            ? '自动续跑中' : '未自动续跑',
        }));
      },
      screenshot: async (index) => (await automation.captureReadOnly('wanlong', index)).frame,
      log: (message) => console.warn('[wanlong/bot]', message),
    });
    registerWanlongIpcHandlers({ automation, accounts, insights, advisor, plans, remoteBot, windows: services.windows });
    return {
      async restore() {
        await automation.restoreSchedules();
        await plans.start('wanlong');
        monitoring.start();
        await remoteBot.start().catch((error: unknown) =>
          console.warn('[wanlong/bot] 只读机器人未启动', error instanceof Error ? error.message : String(error)));
      },
      async dispose() {
        await remoteBot.stop();
        await monitoring.dispose();
        await plans.shutdown();
        await accounts.shutdown();
        await automation.dispose();
        await insights.dispose();
      },
    };
  },
});
