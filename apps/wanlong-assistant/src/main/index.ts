import { runDoctorChecks } from '@avdm/core';
import { normalizeGatherConfig } from '@avdm/automation/wanlong';
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
import { AppLog, describeThrown, installConsoleCapture } from './app/app-log';
import { AppHealth, runAssistantHealthCheck } from './app/health';
import { InstanceAccess, readLeaseOwner } from './app/instance-access';
import { InstanceOccupancy } from './app/occupancy';
import { AppSettingsStore } from './app/settings-store';
import { announceHealth, announceServiceFailures } from './app/startup';
import { AppToasts } from './app/toasts';
import { DeviceLanes } from './device/lane';
import { broadcast, setBroadcastLogSink } from './events';
import { registerWanlongIpcHandlers } from './ipc-handlers';
import { runServiceSteps, ServiceHealth } from './lifecycle';
import { MonitoringService, ReadOnlyTelegramBot } from './monitoring';
import { PlanService, readAppShotPolicy, ScriptRunner } from './plans';

/**
 * Composition root. Services are built and wired here only, one `// ── <domain> ──` section each, so ported
 * modules append to their own section. Cross-service hooks are closures over ports, never service imports.
 */
bootstrapApp({
  name: '万龙助手',
  rendererPage: 'index.html',
  createAddon(services, home) {
    // ── app (settings, log, toasts, occupancy, device lanes, service health) ──
    const appLog = new AppLog(home, {
      persistLevel: () => appSettings.get().logLevel,
      onEntry: (entry) => broadcast('app-log', entry),
    });
    const appSettings = new AppSettingsStore(home, {
      onChange: (view) => broadcast('app-settings-changed', view),
      log: (message) => appLog.warn('settings', message),
    });
    // A packaged app has no console: services' console.warn/error and user-visible `log` pushes reach the disk.
    const uninstallConsoleCapture = installConsoleCapture(appLog);
    setBroadcastLogSink((entry) => appLog.record(entry.level, 'assistant', entry.message, undefined, entry.index));
    const appToasts = new AppToasts((toast) => broadcast('app-toast', toast));
    const serviceHealth = new ServiceHealth((failures) => broadcast('service-failures', failures));
    const instanceAccess = new InstanceAccess();
    const occupancy = new InstanceOccupancy({
      access: instanceAccess,
      leaseOwner: (index) => readLeaseOwner(home, index),
      onSourceError: (name, error) => appLog.warn('occupancy', `占用来源 ${name} 读取失败：${describeThrown(error)}`),
    });
    const deviceLanes = new DeviceLanes({ minCaptureIntervalMs: () => appSettings.get().minCaptureIntervalMs });
    /** Services that talk to devices get this host: every adb call runs on its instance's lane (read-only paths too). */
    const deviceHost = deviceLanes.host(services.host);

    // ── insights (stats / notifications) ──
    const insights = new InsightsService(home);

    // ── automation (gather runs, schedules, templates) ──
    let monitoring: MonitoringService;
    const automation = new AutomationHost(deviceHost, home, undefined, undefined, {
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
    const accounts: AccountManager = new AccountManager(deviceHost, automation, home, {
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

    // ── plans (task plans + script library) + runs (script executor, run monitor) ──
    // Scripts execute in script-worker threads; snapshots, log batches and debug matches are pushed to the monitor.
    const scriptRunner = new ScriptRunner(home, {
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await services.host.get()).device(index),
    }, {
      onSnapshot: (snapshot) => broadcast('plan-run', { kind: 'snapshot', snapshot }),
      onLogs: (event) => broadcast('run-logs', event),
      onMatches: (event) => broadcast('run-matches', event),
    });
    const plans = new PlanService(home, {
      accounts: (gameId) => accounts.list(gameId),
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await deviceHost.get()).device(index),
      templateDir: async (gameId, index) => (await automation.settings(gameId, index)).templateDir,
      gatherScheduleEnabled: async (gameId, index) =>
        (await automation.schedules()).some((item) => item.gameId === gameId && item.index === index && item.enabled),
      onRun: (run) => broadcast('plan-run', { kind: 'plan', run }),
      // The app settings' default (DECISIONS C), read from app-settings.json per run; with the settings service
      // wired here, `() => appSettings.get().shotPolicy` is the same value without the file read.
      shotPolicy: () => readAppShotPolicy(home),
    }, scriptRunner);

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

    // ── app (occupancy sources, self-check) ──
    const knownIndices = async (index?: number): Promise<number[]> =>
      index !== undefined ? [index] : (await (await services.host.get()).list()).map((state) => state.record.index);
    occupancy.register('gather', async () => (await automation.runs())
      .filter((run) => run.status === 'running' || run.status === 'stopping')
      .map((run) => ({ index: run.index, label: run.status === 'stopping' ? '停止采集' : '运行采集', source: 'gather', blocking: true })));
    occupancy.register('schedule', async () => (await automation.schedules()).filter((item) => item.enabled)
      .map((item) => ({ index: item.index, label: '自动采集已开启', source: 'schedule', blocking: false })));
    occupancy.register('plans', async (index) => (await knownIndices(index)).filter((i) => plans.isActiveForInstance(i))
      .map((i) => ({ index: i, label: '运行脚本计划', source: 'plans', blocking: true })));
    occupancy.register('login', async (index) => (await knownIndices(index)).flatMap((i) => {
      const session = accounts.loginSession(i);
      return session && loginActive(session.phase) ? [{ index: i, label: '进行账号登录', source: 'login', blocking: true }] : [];
    }));
    const appHealth = new AppHealth(() => runAssistantHealthCheck({
      home,
      environment: async () => runDoctorChecks(await services.host.get(), { audience: 'app', skip: ['scrcpy', 'licenses'] }),
      instances: async () => (await (await services.host.get()).list()).map((state) => ({
        index: state.record.index, name: state.record.name, width: state.record.spec.width, height: state.record.spec.height,
      })),
      referenceSize: gamePlugin('wanlong').referenceSize ?? { width: 2560, height: 1440 },
      async templateTargets() {
        const [states, schedules] = await Promise.all([(await services.host.get()).list(), automation.schedules()]);
        const targets = [];
        for (const state of states) {
          const index = state.record.index;
          const scheduled = schedules.some((item) => item.gameId === 'wanlong' && item.index === index && item.enabled);
          const settings = await automation.settings('wanlong', index).catch(() => null);
          const configured = settings ? normalizeGatherConfig(settings.config as Parameters<typeof normalizeGatherConfig>[0]).enabled : false;
          if (!scheduled && !configured) continue;
          targets.push({
            index,
            load: async () => {
              const set = await automation.templateSet('wanlong', index);
              return set ? { templates: set.templates.length, name: set.name } : null;
            },
          });
        }
        return targets;
      },
    }), (report) => broadcast('app-health', report));

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
      appSettings,
      appLog,
      appHealth,
      appToasts,
      occupancy,
      appHome: home,
      windows: services.windows,
    });

    return {
      /** Each service starts on its own: one failure is logged, shown in the top bar and never blocks the others. */
      async restore() {
        const failures = await runServiceSteps('start', [
          {
            name: '模拟器日志记录', impact: '模拟器管理器的警告不会写入助手日志文件',
            run: async () => (await services.host.get()).on('log', (entry) => appLog.record(entry.level, 'emulator', entry.message, undefined, entry.index)),
          },
          { name: '自动续跑调度', impact: '自动采集不会续跑', run: () => automation.restoreSchedules() },
          { name: '脚本计划', impact: '定时脚本不会自动运行', run: () => plans.start('wanlong') },
          { name: '运行监控', impact: '掉线与卡死不会告警', run: () => monitoring.start() },
          { name: '只读机器人', impact: 'Telegram 机器人不会响应', run: () => remoteBot.start() },
        ]);
        serviceHealth.report(failures);
        announceServiceFailures(serviceHealth.list().filter((item) => failures.some((failure) => failure.name === item.name)), appToasts);
        // Startup self-check in the background (OpenCV warms up in a worker); problems become one toast.
        void appHealth.check().then((report) => announceHealth(report, appToasts))
          .catch((error: unknown) => appLog.error('health', `环境自检没能完成：${describeThrown(error)}`));
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
          { name: '设备通道', run: () => deviceLanes.dispose() },
          {
            name: '运行日志',
            run: async () => { setBroadcastLogSink(undefined); await appLog.flush(); uninstallConsoleCapture(); },
          },
        ]);
      },
    };
  },
});
