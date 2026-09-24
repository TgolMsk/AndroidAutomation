import { bootstrapApp } from '@avdm/emulator-shell/main/bootstrap';
import { AccountManager } from './automation/accounts';
import { HomeVerifier } from './automation/accounts/home-verify';
import { loginActive } from './automation/accounts/types';
import { AdvisorService } from './automation/advisor';
import { gamePlugin } from './automation/games';
import { AutomationHost } from './automation/host';
import { InsightsService } from './automation/insights';
import { InstanceProvisioner } from './instances/provisioner';
import { broadcast } from './events';
import { registerWanlongIpcHandlers } from './ipc-handlers';
import { runServiceSteps, ServiceHealth } from './lifecycle';
import { MonitoringService, ReadOnlyTelegramBot } from './monitoring';
import { PlanService } from './plans';

/**
 * Composition root. Services are built and wired here only, one `// ── <domain> ──` section each, so ported
 * modules append to their own section. Cross-service hooks are closures over ports, never service imports.
 */
bootstrapApp({
  name: '万龙助手',
  rendererPage: 'index.html',
  createAddon(services, home) {
    // ── app (service health) ──
    const serviceHealth = new ServiceHealth((failures) => broadcast('service-failures', failures));

    // ── insights (stats / notifications) ──
    const insights = new InsightsService(home);

    // ── automation (gather runs, schedules, templates) ──
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
      automationReadiness: (gameId, index) => accounts.readiness(gameId, index),
      onSchedulePause: (gameId, index, reason) => insights.recordSchedulePause(gameId, index, reason),
    });
    // Template edits (save / delete / import) make compiled templates stale: tell the renderer; cache owners
    // (vision workers, sampler, resources, AI harvest) subscribe through automation.onTemplatesChanged too.
    automation.onTemplatesChanged((change) => broadcast('templates-changed', change));

    // ── accounts ──
    const homeVerifier = new HomeVerifier({
      capture: (gameId, index) => automation.captureReadOnly(gameId, index),
      // A fresh copy inherits the base's template set; until then the base's set is the fallback.
      templateDir: async (gameId, index): Promise<string> =>
        (await automation.settings(gameId, index)).templateDir || await provisioner.baseTemplateDir(gameId),
    });
    const accounts: AccountManager = new AccountManager(services.host, automation, home, {
      base: (gameId) => provisioner.baseIdentity(gameId),
      verifyHome: (gameId, index) => homeVerifier.verify(gameId, index),
      homeCheckIssue: (gameId, index) => homeVerifier.precheck(gameId, index),
      // `instanceGatherConfig` (move the instance's gather config into a newly bound account) is wired by the
      // scheduler port together with gather settings that read `accounts.gatherConfigFor()` first; until then
      // the instance file stays the only copy.
      onAccountsChanged: (event) => broadcast('account-changed', event),
      onLoginChanged: (session) => broadcast('login-changed', session),
    });

    // ── instances (base instance, batch clone) ──
    const provisioner: InstanceProvisioner = new InstanceProvisioner(services.host, home, {
      settings: (gameId, index) => automation.settings(gameId, index),
      saveSettings: (gameId, index, patch) => automation.saveSettings(gameId, index, patch),
      disableSchedule: async (gameId, index) => { await automation.setSchedule(gameId, index, false); },
      async busyReason(index): Promise<string | null> {
        if (accounts.loginActiveOn(index)) return '正在进行账号登录';
        if (plans.isActiveForInstance(index)) return '正在运行脚本计划';
        const runs = await automation.runs();
        return runs.some((run) => run.index === index && (run.status === 'running' || run.status === 'stopping')) ? '正在运行自动采集' : null;
      },
      boundAccountName: async (gameId, index, createdAt): Promise<string | null> => (await accounts.list(gameId)).find((account) =>
        account.binding?.index === index && account.binding.instanceCreatedAt === createdAt)?.name ?? null,
      onChanged: (event) => broadcast('instance-base-changed', event),
    });

    // ── advisor (AI) ──
    const advisor = new AdvisorService(home, (gameId, index) => automation.captureReadOnly(gameId, index));

    // ── plans (task plans + script library) ──
    const plans = new PlanService(home, {
      accounts: (gameId) => accounts.list(gameId),
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await services.host.get()).device(index),
      templateDir: async (gameId, index) => (await automation.settings(gameId, index)).templateDir,
      gatherScheduleEnabled: async (gameId, index) =>
        (await automation.schedules()).some((item) => item.gameId === gameId && item.index === index && item.enabled),
    });

    // ── monitoring (failure / freeze / kicked detection) ──
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

    // ── bot (Telegram) ──
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

    // ── ipc ── (one service per line: a ported module appends its own line)
    registerWanlongIpcHandlers({
      automation,
      accounts,
      insights,
      advisor,
      plans,
      remoteBot,
      serviceHealth,
      provisioner,
      windows: services.windows,
    });

    return {
      /** Each service starts on its own: one failure is logged, shown in the top bar and never blocks the others. */
      async restore() {
        serviceHealth.report(await runServiceSteps('start', [
          { name: '自动续跑调度', impact: '自动采集不会续跑', run: () => automation.restoreSchedules() },
          { name: '脚本计划', impact: '定时脚本不会自动运行', run: () => plans.start('wanlong') },
          { name: '运行监控', impact: '掉线与卡死不会告警', run: () => monitoring.start() },
          { name: '只读机器人', impact: 'Telegram 机器人不会响应', run: () => remoteBot.start() },
        ]));
      },
      /** Inbound network first, then observers, device writers, and finally stores that flush on exit. */
      async dispose() {
        await runServiceSteps('stop', [
          { name: '只读机器人', run: () => remoteBot.stop() },
          { name: '运行监控', run: () => monitoring.dispose() },
          { name: '脚本计划', run: () => plans.shutdown() },
          { name: '账号登录', run: () => accounts.shutdown() },
          { name: '登录检查', run: () => homeVerifier.dispose() },
          { name: '自动化运行', run: () => automation.dispose() },
          { name: '运行统计', run: () => insights.dispose() },
        ]);
      },
    };
  },
});
