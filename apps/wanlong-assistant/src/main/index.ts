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
import { safeStorageCodec } from './automation/insights/notifications';
import { InstanceProvisioner } from './instances/provisioner';
import { AppLog, describeThrown, installConsoleCapture } from './app/app-log';
import { DeviceTools } from './app/device-tools';
import { AppHealth, runAssistantHealthCheck, type HealthTemplateTarget } from './app/health';
import { instanceAccess, readLeaseOwner, readLeaseOwners } from './app/instance-access';
import { rememberingCodec, SecretMemory } from './app/log-secrets';
import { InstanceOccupancy } from './app/occupancy';
import { configuredSettingsIndices, listInstanceTemplateSets } from './app/paths';
import { registerServiceOccupancy } from './app/service-occupancy';
import { AppSettingsStore } from './app/settings-store';
import { announceHealth, announceServiceFailures } from './app/startup';
import { AppToasts } from './app/toasts';
import { DeviceLanes } from './device/lane';
import { keepShot } from '../shared/app-settings';
import { broadcast, setBroadcastLogSink } from './events';
import { registerWanlongIpcHandlers } from './ipc-handlers';
import { runServiceSteps, ServiceHealth } from './lifecycle';
import { MonitoringService, ReadOnlyTelegramBot } from './monitoring';
import { SCRIPT_PREEMPT_GRACE_MS } from './scheduler/service';
import { PlanService, ScriptRunner } from './plans';
import { updateBusyCheck, updateLog, UpdateService } from './update';
import { electronUpdateDeps } from './update/electron-deps';

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
    // Plaintext credentials this process has seen (token typed in or decrypted, AI key loaded) never reach the log.
    const logSecrets = new SecretMemory();
    appLog.addSecrets(() => logSecrets.list());
    // A packaged app has no console: services' console.warn/error and user-visible `log` pushes reach the disk.
    const uninstallConsoleCapture = installConsoleCapture(appLog);
    setBroadcastLogSink((entry) => appLog.record(entry.level, 'assistant', entry.message, undefined, entry.index));
    const appToasts = new AppToasts((toast) => broadcast('app-toast', toast));
    const serviceHealth = new ServiceHealth((failures) => broadcast('service-failures', failures));
    const occupancy = new InstanceOccupancy({
      access: instanceAccess,
      leaseOwner: (index) => readLeaseOwner(home, index),
      leaseOwners: () => readLeaseOwners(home),
      onSourceError: (name, error) => appLog.warn('occupancy', `占用来源 ${name} 读取失败：${describeThrown(error)}`),
    });
    const deviceLanes = new DeviceLanes({ minCaptureIntervalMs: () => appSettings.get().minCaptureIntervalMs });
    /** Services that talk to devices get this host: every adb call runs on its instance's lane (read-only paths too). */
    const deviceHost = deviceLanes.host(services.host);
    const deviceTools = new DeviceTools(deviceHost);
    /** Script matching defaults from the app settings (script runs and 「测试模板」 use the same pair). */
    const matchDefaults = (): { threshold: number; shrink: number } => {
      const settings = appSettings.get();
      return { threshold: settings.matchThreshold, shrink: settings.shrink };
    };

    // ── insights (stats / notifications) ──
    const insights = new InsightsService(home, { codec: rememberingCodec(safeStorageCodec, logSecrets) });

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
      // 「测试模板」 hits or misses exactly as a script run would (same threshold / shrink as the script worker).
      matchDefaults,
      // Gather failure scenes follow the app settings' shot policy (original saveAlertShot).
      shotPolicy: () => appSettings.get().shotPolicy,
      // Fallback「需要人处理」alert until the alerts module sets the scheduler's own onNeedsAttention hook.
      onNeedsAttention: (gameId, index, info) => insights.recordAttentionPause(gameId, index, info),
    }, {
      // Check-then-act sequences (foreground → screencap → foreground, foreground → tap) stay whole on the lane.
      deviceLane: (index, work) => deviceLanes.run(index, work),
    });
    // Template edits (save / delete / import) make compiled templates stale: tell the renderer; cache owners
    // (vision workers, sampler, resources, AI harvest) subscribe through automation.onTemplatesChanged too.
    automation.onTemplatesChanged((change) => broadcast('templates-changed', change));

    // ── accounts ──
    const homeVerifier = new HomeVerifier({
      capture: (gameId, index) => automation.captureReadOnly(gameId, index),
      // A fresh copy inherits the base's template set; until then the base's set is the fallback.
      templateDir: async (gameId, index): Promise<string> =>
        (await automation.instanceSettings(gameId, index)).templateDir || await provisioner.baseTemplateDir(gameId),
    });
    const accounts: AccountManager = new AccountManager(deviceHost, automation, home, {
      base: (gameId) => provisioner.baseIdentity(gameId),
      verifyHome: (gameId, index) => homeVerifier.verify(gameId, index),
      homeCheckIssue: (gameId, index) => homeVerifier.precheck(gameId, index),
      // Binding moves the instance's gather config into a newly bound account that has none (original
      // afterAccountBind); from then on gather reads and saves the account's copy (`automation.settings()` and the
      // scheduler ports below read `gatherConfigFor()` first and fall back to the instance file).
      instanceGatherConfig: (gameId, index) => automation.instanceGatherConfig(gameId, index),
      onAccountsChanged: (event) => broadcast('account-changed', event),
      onLoginChanged: (session) => broadcast('login-changed', session),
    });

    // ── instances (base instance, batch clone) ──
    const provisioner: InstanceProvisioner = new InstanceProvisioner(services.host, home, {
      // A copy inherits the base's own settings file (the base instance never has an account).
      settings: (gameId, index) => automation.instanceSettings(gameId, index),
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
    appLog.addSecrets(() => advisor.logSecrets());

    // ── plans (task plans + script library) + runs (script executor, run monitor) ──
    // Scripts execute in script-worker threads; snapshots, log batches and debug matches are pushed to the monitor.
    // Device calls go through the instance's lane (DeviceLane) like every other service's.
    const scriptRunner = new ScriptRunner(home, {
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await deviceHost.get()).device(index),
    }, {
      onSnapshot: (snapshot) => broadcast('plan-run', { kind: 'snapshot', snapshot }),
      onLogs: (event) => broadcast('run-logs', event),
      onMatches: (event) => broadcast('run-matches', event),
      // Frame reuse window of the script worker = the app settings' capture interval (original worker/context.ts).
      captureIntervalMs: () => appSettings.get().minCaptureIntervalMs,
    });
    const plans = new PlanService(home, {
      accounts: (gameId) => accounts.list(gameId),
      instance: async (index) => (await services.host.get()).getState(index),
      device: async (index) => (await deviceHost.get()).device(index),
      templateDir: async (gameId, index) => (await automation.instanceSettings(gameId, index)).templateDir,
      // ★ Scripts first (DECISIONS A.4, original plan rule 1): a plan or manual run makes the instance's gather
      // scheduler yield (polite wait, then abort) and gives it back afterwards; gather auto never refuses a script.
      suspendForScript: (gameId, index, reason) => gameId === 'wanlong'
        ? automation.eta.suspendForScript(index, SCRIPT_PREEMPT_GRACE_MS, reason)
        : Promise.resolve(() => undefined),
      onRun: (run) => broadcast('plan-run', { kind: 'plan', run }),
      // App settings (DECISIONS C, one source of defaults): the default trace-shot policy of runs that chose none,
      // and the matching defaults (threshold of templates without their own, downsampling factor) handed to the
      // script worker. Awaiting `ready` keeps a run started right after launch off the built-in defaults.
      shotPolicy: async () => { await appSettings.ready; return appSettings.get().shotPolicy; },
      matchDefaults: async () => { await appSettings.ready; return matchDefaults(); },
    }, scriptRunner);

    // ── scheduler (ETA queue scheduler: ports and hooks; see src/main/scheduler/README.md) ──
    automation.setPorts({
      // The account bound to this AVD: same index AND same instance identity (a replaced AVD inherits nothing).
      accountIdOf: async (index) => (await accounts.accountForInstance('wanlong', index))?.id ?? null,
      // Gather config follows the bound account (original Account.scriptParams.gather); unbound → the instance file.
      accountGatherConfig: (index) => accounts.gatherConfigFor('wanlong', index),
      saveAccountGatherConfig: async (accountId, config) => { await accounts.saveGatherConfig(accountId, config); },
      // The readiness gate (original assertInstanceAutomationReady: base instance, active login, bound account not
      // checked or pointing at a replaced AVD) is the accounts module's `automationReadiness` hook above; a scheduled
      // wake it refuses pauses the ETA scheduler (not a failure) and `onSchedulePause` records the warning.
      externalBusy: (index) => {
        if (plans.isActiveForInstance(index)) return '脚本计划';
        const login = accounts.loginSession(index);
        return login && loginActive(login.phase) ? '账号登录' : null;
      },
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
              // The scheduler is reading the troop panel / dispatching / probing on it right now.
              automation.locks.holder(schedule.index) !== null ||
              Boolean(login && loginActive(login.phase)),
          }];
        });
      },
      capture: (gameId, index) => automation.captureReadOnly(gameId, index),
      templateSet: (gameId, index) => automation.templateSet(gameId, index),
      testTemplate: (gameId, index, id) => automation.testTemplate(gameId, index, id),
      onAlert: (alert) => insights.recordMonitorAlert(alert),
      keepEvidence: () => keepShot(appSettings.get().shotPolicy, 'failure'),
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
    // Gather runs, enabled schedules, script plans (running / enabled) and login wizards; the update gate asks this
    // same table (`occupancy.anyBusy()`), so every later source registered here also holds the update back.
    registerServiceOccupancy(occupancy, {
      instanceIndices: async () => (await (await services.host.get()).list()).map((state) => state.record.index),
      automation, plans, accounts, scheduler: automation.locks, gameId: 'wanlong',
    });
    const appHealth = new AppHealth(() => runAssistantHealthCheck({
      home,
      environment: async () => runDoctorChecks(await services.host.get(), { audience: 'app', skip: ['scrcpy', 'licenses'] }),
      adbServer: async () => (await (await services.host.get()).adb()).startServer(),
      instances: async () => (await (await services.host.get()).list()).map((state) => ({
        index: state.record.index, name: state.record.name, width: state.record.spec.width, height: state.record.spec.height,
      })),
      referenceSize: gamePlugin('wanlong').referenceSize ?? { width: 2560, height: 1440 },
      async templateTargets() {
        const [states, schedules] = await Promise.all([(await services.host.get()).list(), automation.schedules()]);
        const targets: HealthTemplateTarget[] = [];
        for (const state of states) {
          const index = state.record.index;
          const scheduled = schedules.some((item) => item.gameId === 'wanlong' && item.index === index && item.enabled);
          let settings: Awaited<ReturnType<typeof automation.settings>>;
          try { settings = await automation.settings('wanlong', index); }
          catch (error) {
            // An unreadable settings file hides whether gather is on: report it instead of skipping the instance.
            targets.push({ index, load: () => Promise.reject(new Error(`采集配置读取失败：${describeThrown(error)}`)) });
            continue;
          }
          const configured = normalizeGatherConfig(settings.config as Parameters<typeof normalizeGatherConfig>[0]).enabled;
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

    // ── update (in-app update from GitHub Releases) ──
    // One occupancy source for the install gate: the instance occupancy table above (blocking holders only; an
    // enabled schedule alone is not busy) plus the shell's SDK install, which belongs to no instance. Update lines go
    // to the app log with scope 'update' (a packaged app has no console); see update/README.md.
    const updateLogLine = updateLog(appLog);
    const updateBusy = updateBusyCheck({ occupancy, sdkInstall: services.sdkInstall });
    const updates = new UpdateService(() => electronUpdateDeps({
      busy: updateBusy,
      publish: (state) => broadcast('update-changed', state),
      log: updateLogLine,
    }), { autoCheck: !process.env['AVDM_SCREENSHOT_PATH'], log: updateLogLine });

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
      deviceTools,
      appTemplateSets: (gameId) => listInstanceTemplateSets({
        instances: async () => (await (await services.host.get()).list()).map((state) => ({ index: state.record.index, name: state.record.name })),
        configuredIndices: () => configuredSettingsIndices(home, gameId),
        templateDir: async (index) => (await automation.instanceSettings(gameId, index)).templateDir,
        describe: async (index) => {
          const set = await automation.templateSet(gameId, index);
          return set ? { name: set.name, templates: set.templates.length } : null;
        },
      }),
      updateCenter: updates.center,
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
          { name: '应用内更新', impact: '启动后不会自动检查新版本', run: () => updates.start() },
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
          { name: '应用内更新', run: () => updates.dispose() },
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
