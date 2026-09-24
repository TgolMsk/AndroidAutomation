import { runDoctorChecks } from '@avdm/core';
import { loadTemplateSet } from '@avdm/automation';
import { normalizeGatherConfig } from '@avdm/automation/wanlong';
import { app } from 'electron';
import { bootstrapApp } from '@avdm/emulator-shell/main/bootstrap';
import { AccountManager } from './automation/accounts';
import { HomeVerifier } from './automation/accounts/home-verify';
import { loginActive } from './automation/accounts/types';
import { AdvisorService } from './automation/advisor';
import { AiRecoveryService } from './automation/ai-recover';
import { gamePlugin } from './automation/games';
import { builtinDefaultResolver, builtinTemplatesDir, listBuiltinTemplateSets } from './automation/builtin-templates';
import { AutomationHost } from './automation/host';
import { InsightsService } from './automation/insights';
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
import { shouldKeepShot } from '@avdm/automation/wanlong';
import { broadcast, setBroadcastLogSink } from './events';
import { registerWanlongIpcHandlers } from './ipc-handlers';
import { runServiceSteps, ServiceHealth } from './lifecycle';
import { AlertsService, createAvdFreezeRecoveryIo, KICKED_TEMPLATE_IDS, ledgerAlertOf, safeStorageCodec } from './alerts';
import { BotService, linkBotToAlerts } from './bot';
import { ShotStore } from './scheduler/shots';
import { PlanService, ScriptRunner } from './plans';
import { ResourcesService } from './resources/service';
import { StatsService, alertRaisedEvent, autoChangedEvent, countsAsAlert, cycleFailedEvent, dispatchEvents, pauseRealityPort, tripEvents } from './stats';
import { renderDailyStatsText } from '../shared/stats';
import { cstDateKey, formatCstClock } from '../shared/time';
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
    const insights = new InsightsService(home);

    // ── automation (gather runs, schedules, templates) ──
    const automation = new AutomationHost(deviceHost, home, undefined, undefined, {
      onCycle: async (run, result, source) => {
        await insights.recordCycle(run, result, source).catch((error: unknown) => console.error('[wanlong] 统计写入失败', error));
      },
      onFailure: async (run, error, source) => {
        await insights.recordFailure(run, error, source).catch((cause: unknown) => console.error('[wanlong] 失败统计写入失败', cause));
      },
      automationReadiness: (gameId, index) => accounts.readiness(gameId, index),
      // 「测试模板」 hits or misses exactly as a script run would (same threshold / shrink as the script worker).
      matchDefaults,
      // Gather failure scenes follow the app settings' shot policy (original saveAlertShot).
      shotPolicy: () => appSettings.get().shotPolicy,
      // onScheduleStop / onSchedulePause / onNeedsAttention / onCycleResult: the alerts section below.
    }, {
      // Check-then-act sequences (foreground → screencap → foreground, foreground → tap) stay whole on the lane.
      deviceLane: (index, work) => deviceLanes.run(index, work),
    });
    // Template edits (save / delete / import) make compiled templates stale: tell the renderer; cache owners
    // (vision workers, sampler, resources, AI harvest) subscribe through automation.onTemplatesChanged too.
    automation.onTemplatesChanged((change) => broadcast('templates-changed', change));

    // ── built-in template library (shipped with the app; seeded into the user library at start, only-add) ──
    const builtinTemplates = builtinTemplatesDir(app.isPackaged, process.resourcesPath, app.getAppPath());
    // An instance without a chosen template set uses the managed copy of the shipped set for its game.
    automation.setDefaultTemplateDir(builtinDefaultResolver(
      (gameId) => automation.managedTemplateRoot(gameId), listBuiltinTemplateSets(builtinTemplates),
      (gameId) => gamePlugin(gameId).packageName,
    ));

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
      clearInstanceGatherConfig: (gameId, index) => automation.clearInstanceGatherConfig(gameId, index),
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
    // Read-only advisor: config, quota, two-stage questions, records. Records and config changes are pushed
    // (`ai-consulted` / `ai-config-changed`, masked view only); the executor that taps lives in the「ai」section below.
    const advisor = new AdvisorService(home, (gameId, index) => automation.captureReadOnly(gameId, index), {
      onRecord: (record) => broadcast('ai-consulted', record),
      onConfigChanged: (view) => broadcast('ai-config-changed', view),
      log: (level, message) => appLog.record(level, 'ai', message),
      gameName: (gameId) => { try { return gamePlugin(gameId).name; } catch { return gameId; } },
    });
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
      // scheduler yield (polite wait of the plan config's preemptGraceMs, then abort) and gives it back afterwards;
      // gather auto never refuses a script.
      suspendForScript: (gameId, index, reason, graceMs) => gameId === 'wanlong'
        ? automation.eta.suspendForScript(index, graceMs, reason)
        : Promise.resolve(() => undefined),
      onRun: (run) => broadcast('plan-run', { kind: 'plan', run }),
      onChanged: (overview) => broadcast('plan-changed', overview),
      onConfigChanged: (event) => broadcast('plan-config-changed', event),
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
        // Only a script that holds the instance (admitted / running) makes gathering wait; a task still waiting in the
        // plan queue does not (original busyRunIdOf) — it preempts gathering itself when it starts.
        if (plans.runIdOfInstance(index) !== null) return '脚本计划';
        const login = accounts.loginSession(index);
        return login && loginActive(login.phase) ? '账号登录' : null;
      },
    });

    // ── alerts / freeze (failure detection, automatic pauses, notifications, freeze watchdog; see src/main/alerts) ──
    const alertShots = new ShotStore(home);
    const alertLog = appLog.scoped('alerts');
    const wanlongPackage = gamePlugin('wanlong').packageName;
    // Saves reload the bot; the bot's start / stop only toggles the alert buttons (see linkBotToAlerts).
    const botLink = linkBotToAlerts({ bot: () => remoteBot, hub: () => alerts.hub, log: (message) => alertLog.warn(message) });
    const alerts: AlertsService = new AlertsService(home, {
      // The bot token stays in the Keychain; every plaintext that passes the codec is scrubbed from the app log.
      codec: rememberingCodec(safeStorageCodec, logSecrets),
      // ★ Pause = setAuto(false) (never takes the instance lock); resume = setAuto(true) from IPC / the bot only.
      setAuto: (index, enabled, reason) => automation.eta.setAuto(index, enabled, reason),
      exclusive: (index, what, fn, signal) => automation.eta.exclusive(index, what, fn, signal),
      accountOf: async (index) => {
        const account = await accounts.accountForInstance('wanlong', index);
        return account ? { id: account.id, name: account.name } : null;
      },
      identityOf: async (index) => {
        try { return (await (await services.host.get()).getState(index)).record.createdAt; }
        catch (error) { if ((error as { code?: unknown }).code === 'INSTANCE_NOT_FOUND') return null; throw error; }
      },
      // A frozen guest can read as「booting」to a fresh manager process: booting with a live pid still counts.
      instanceAlive: async (index) => {
        const state = await (await services.host.get()).getState(index);
        return { alive: state.status === 'running' || (state.status === 'booting' && Boolean(state.pid)), status: state.status, identity: state.record.createdAt };
      },
      recoveryIo: (index, signal) => createAvdFreezeRecoveryIo({
        manager: () => deviceHost.get(), index, signal, gamePackage: wanlongPackage,
        recognize: (raw, abort) => automation.recognizeScreen(index, raw, abort),
        dropLane: (i) => deviceLanes.drop(i),
        log: (level, message) => alertLog[level](`[卡死][实例 #${index}] ${message}`, undefined, index),
      }),
      matchTemplates: (index, raw, ids) => automation.matchTemplates(index, raw, ids),
      hasKickedTemplates: async (index) => Boolean((await automation.templateSet('wanlong', index))?.templates
        .some((template) => KICKED_TEMPLATE_IDS.includes(template.id))),
      // Alert scenes follow the app settings' shot policy (original saveAlertShot: failure labels under 'onFail').
      saveShot: async (index, label, raw) => shouldKeepShot(appSettings.get().shotPolicy, label) ? alertShots.save(index, label, raw) : null,
      // Every real alert also lands in the daily ledger (statistics count alerts per Beijing day).
      ledger: async (record) => {
        const row = ledgerAlertOf(record, 'wanlong');
        if (row) await insights.recordAlert(row);
      },
      log: (level, message, index) => alertLog[level](message, undefined, index),
      onPauseChanged: (pause) => broadcast('alert-pause-changed', pause),
      // The scheduler's queue view carries the pause (pauseOf): republish it whenever the record changes.
      refreshSchedulerView: (index) => automation.eta.refreshView(index),
      onRaised: (record) => broadcast('alert-raised', record),
      // A save: the bot restarts only when its own settings changed (`reload`). ★ The bot's start / stop only pushes the
      // view (`onViewChanged`) — restarting there would feed its status back into another restart forever.
      onConfigChanged: (view) => {
        broadcast('alert-config-changed', view);
        botLink.configSaved();
      },
      onViewChanged: (view) => broadcast('alert-config-changed', view),
      gamePackage: wanlongPackage,
    });
    automation.eta.setHooks(alerts.schedulerHooks());
    automation.setHooks(alerts.hostHooks());
    automation.setPorts({
      probeKicked: (index, raw) => alerts.probeKicked(index, raw),
      pauseReason: (index) => alerts.center.pauseInfo(index)?.reason ?? null,
    });

    // ── ai (unknown-screen recovery: gather G0, troop-panel sampler, script runs; see automation/ai-recover/README.md) ──
    // One routing for the three chains (original recoverUnknownWithUpdate): calibrated game-update handling first (even
    // with the AI off), then the AI executor — which taps only when「自动处理」(autoActions) is on. Template matching
    // is asked of the instance's vision worker; taps go through the device lane with identity + foreground checks.
    // Built after the alerts section: a paused instance is not touched, and「需要人处理」goes through the alerts module.
    const aiRecovery = new AiRecoveryService({
      gameId: 'wanlong',
      packageName: gamePlugin('wanlong').packageName,
      advisor,
      manager: {
        getState: async (index) => (await deviceHost.get()).getState(index),
        device: async (index) => (await deviceHost.get()).device(index),
      },
      lane: (index, work) => deviceLanes.run(index, work),
      // ★ An instance an alert paused (kicked, offline, needs a human…) waits for a person: no automatic chain consults
      //   the AI or taps it (checked before each chain and before every tap).
      paused: (index) => alerts.center.pauseInfo(index)?.reason ?? null,
      // Gather G0 / sampler: act for the AVD the running job was admitted with (script runs carry their own identity).
      admittedIdentity: (index) => automation.admittedIdentity(index),
      // Before-tap stability and after-tap change checks run in the instance's vision worker, not on this thread.
      frames: (index, signal) => ({
        meanAbsDiff: (a, b, refWidth, refHeight) => automation.frameDiff(index, a, b, refWidth, refHeight, signal),
        stableTarget: (a, b, box, refWidth, refHeight) => automation.targetStable(index, a, b, box, refWidth, refHeight, signal),
      }),
      instanceTemplateSet: (index) => automation.templateSet('wanlong', index),
      loadTemplateSet: (directory) => loadTemplateSet(directory),
      recognize: (index, raw, signal) => automation.recognizeScreen(index, raw, signal),
      match: (index, directory, raw, ids, options) => automation.matchTemplatesIn(index, directory, raw, ids, options),
      updateVerdict: (index, directory, raw, signal) => automation.checkGameUpdate(index, directory, raw, signal),
      // Learnt close buttons go through the template library (variance guard, atomic write); the change notification
      // drops the vision workers' compiled sets, so the next round already uses the new template.
      saveTemplate: async (directory, draft) => {
        const saved = await automation.saveTemplateToSet('wanlong', directory, draft);
        return { id: saved.definition.id, std: saved.std };
      },
      // The plan config's「脚本执行期间允许 AI 介入」(PlanConfig.aiAssist, default on; DECISIONS A.3), read live at each
      // consult (original planRunner.getConfig().aiAssist): switching it off stops AI help in runs already going.
      planAiAssist: (gameId) => plans.aiAssistEnabled(gameId),
      // AI_RISK_BLOCKED / GAME_UPDATE_REQUIRED on every chain (scheduled or manual gather, a sample of any kind, the
      // re-sample after a dispatch, a script run) take the scheduler's one「需要人处理」exit — the same one a scheduled
      // wake uses — whose hook is the alerts module (`alerts.raiseNeedsAttention`): pause first (pause record,
      // setAuto(false), persisted), then notify in the background. The pause aborts the in-flight auto work, whose
      // wake then ends silently; an instance already paused (or being paused) is not alerted again: one alert, not two.
      onNeedsAttention: (index, info) => automation.eta.raiseAttention(index, { code: info.code, message: info.message }),
      log: (level, message, index) => appLog.record(level, 'ai', message, undefined, index),
    });
    automation.setPorts({
      adviseUnknownScreen: (index, raw, attempt, signal) => aiRecovery.adviseGather(index, raw, attempt, signal),
    });
    // ★ Unknown sampler frame, original order (wanlong-panel onUnrecognizedFrame): the alerts module's kicked /
    //   maintenance probe on the same frame → game update → AI. The two modules own separate slots that the scheduler
    //   runs in that order (`probeUnrecognizedFrame` from alerts.schedulerHooks() above, then this one; a probe hit
    //   stops the sampler before the AI is asked), so neither setHooks call can replace or reorder the other.
    //   Gather keeps the original split: G0 asks this advisor before its blind BACK (`adviseUnknownScreen`), and the
    //   alerts probe runs on the cycle's failure frame (`probeKicked`).
    automation.eta.setHooks({
      onUnrecognizedFrame: (index, raw, { signal }) => aiRecovery.recoverForSampler(index, raw, signal),
    });
    scriptRunner.setAiAssist((request) => aiRecovery.assistScript(request));

    // ── bot (Telegram) ──
    // Buttons and commands on the phone (see src/main/bot/README.md). ★ Read actions need 「允许手机查看状态与截图」, control
    // actions 「允许手机远程操作」 (both default off); only the configured Chat ID AND the authorized user are served.
    // Device actions run inside the scheduler's instance lock; resume runs outside it. Statistics / resource-table
    // ports are plugged in by that module's section with `remoteBot.setPorts({ readResources, dailyStatsText })`.
    const botLog = appLog.scoped('bot');
    const remoteBot: BotService = new BotService({
      home,
      gamePackage: wanlongPackage,
      referenceSize: gamePlugin('wanlong').referenceSize ?? { width: 2560, height: 1440 },
      config: async () => { await alerts.hub.ready; return alerts.hub.currentTelegramConfig(); },
      accounts: async () => (await accounts.list('wanlong')).map((account) => ({
        name: account.name, enabled: account.enabled, binding: account.binding, loginReady: account.login.status === 'ready',
      })),
      instances: async () => {
        const [states, base] = await Promise.all([(await services.host.get()).list(), provisioner.baseIdentity('wanlong')]);
        // ★ Only index / name / status / identity: an InstanceState carries a gRPC token.
        return states.map((state) => ({
          index: state.record.index, name: state.record.name, status: state.status, createdAt: state.record.createdAt,
          base: Boolean(base && base.index === state.record.index && base.createdAt === state.record.createdAt),
        }));
      },
      schedulerState: (index) => automation.eta.getState(index),
      pauseOf: (index) => {
        const pause = alerts.center.pauseInfo(index);
        return { paused: pause !== null, reason: pause?.reason ?? null };
      },
      // Manual pause = the user's schedule switch (supersedes an enable still probing); no statistics event here.
      pauseInstance: (index) => automation.setSchedule('wanlong', index, false),
      // ★ Outside the lock. An alert pause is cleared by the alerts module (counters, cooldown, 「已恢复」 notice);
      //   anything else goes through the user's schedule switch with its gates (readiness, first-enable probe).
      resumeInstance: async (index) => {
        if (alerts.center.isPaused(index)) return alerts.resume(index);
        return automation.setSchedule('wanlong', index, true);
      },
      exclusive: (index, what, fn) => automation.eta.exclusive(index, what, fn),
      manager: () => deviceHost.get(),
      lane: (index, work) => deviceLanes.run(index, work),
      matchTemplates: (index, raw, ids) => automation.matchTemplates(index, raw, ids),
      shotPolicy: () => appSettings.get().shotPolicy,
      log: (level, message, index) => botLog[level](message, undefined, index),
      onStatus: (status) => {
        // Alert buttons are attached only while this bot answers them (a view push only, never a config save).
        botLink.botStatus(status);
        broadcast('bot-status', status);
      },
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

    // ── stats / resources (daily statistics by Beijing date, resource-table reads; see src/main/stats/README.md) ──
    const statsLog = appLog.scoped('stats');
    const stats = new StatsService(home, {
      // Facts carry the AVD identity and the account bound to that exact AVD (a recreated instance inherits nothing).
      instanceInfo: async (index) => {
        let createdAt: string | null = null;
        try { createdAt = (await (await services.host.get()).getState(index)).record.createdAt; } catch { createdAt = null; }
        if (!createdAt) return { createdAt: null, accountName: null };
        const account = (await accounts.list('wanlong')).find((item) =>
          item.binding?.index === index && item.binding.instanceCreatedAt === createdAt);
        return { createdAt, accountName: account?.name ?? null };
      },
      // Open pauses are checked against the scheduler's restored auto switch and the AVD list (reconcilePauses below).
      pauseStates: pauseRealityPort({
        isAuto: (index) => automation.eta.isAuto(index),
        instance: async (index) => (await services.host.get()).getState(index),
      }),
      snapshotNow: (index) => resources.read(index),
      onToday: (day) => broadcast('stats-today', day),
      onSnapshot: (push) => broadcast('stats-snapshot', push),
      log: (level, message) => statsLog[level](message),
    });
    const resources: ResourcesService = new ResourcesService('wanlong', {
      // Vision worker job inside `eta.exclusive` (the instance lock of samples and cycles); busy → retry later.
      read: (index) => automation.readResourceStats(index),
      record: (snapshot) => stats.recordSnapshot(snapshot),
      onReading: (index, reading) => broadcast('resources-reading', { gameId: 'wanlong', index, reading }),
      log: (level, message) => statsLog[level](message),
    });
    // Dispatches and failed cycles are observed next to the alerts module's own `onCycleResult`; trips and pauses come
    // from the ETA scheduler (★ onAutoChanged is the only source of pause/resume facts); alerts are counted when an
    // alert conclusion is stored (never the per-run「运行失败」notice).
    automation.observe({
      onDispatched: (index, records, at) => { for (const event of dispatchEvents(index, records, at)) stats.record(event); },
      onCycleResult: async (index, fact) => {
        const event = cycleFailedEvent(index, fact, Date.now());
        if (event) stats.record(event);
      },
    });
    automation.eta.setHooks({
      onMarchGone: (index, gone, at) => { for (const event of tripEvents(index, gone, at)) stats.record(event); },
      onAutoChanged: (index, enabled, at, reason) => stats.record(autoChangedEvent(index, enabled, at, reason)),
    });
    insights.onAlertStored((alert) => {
      if (alert.gameId === 'wanlong' && countsAsAlert(alert.kind)) stats.record(alertRaisedEvent(alert.index, alert.kind, alert.at));
    });
    // The bot's 📈 今日统计 and 💰 资源 (original bot actions `stats` / `resources`). `resources.read` already records
    // the snapshot, so no `recordSnapshot` port; the bot calls it inside its own `eta.exclusive` (the lock is reentrant).
    remoteBot.setPorts({
      readResources: (index) => resources.read(index),
      dailyStatsText: async (now) => renderDailyStatsText(await stats.daily(cstDateKey(now)), { now, formatClock: formatCstClock }),
    });

    // ── ipc ── (one service per line: a ported module appends its own line)
    registerWanlongIpcHandlers({
      automation,
      accounts,
      insights,
      advisor,
      plans,
      remoteBot,
      alerts,
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
      stats,
      resources,
      windows: services.windows,
    });

    return {
      /** Each service starts on its own: one failure is logged, shown in the top bar and never blocks the others. */
      async restore() {
        const failures = await runServiceSteps('start', [
          // First: the shell may reopen the 数据统计 page at once, before the emulator manager has even opened.
          { name: '数据统计', impact: '数据统计页没有数据，派兵与暂停不会记账', run: () => stats.start() },
          // Before the scheduler re-arms: a fresh install needs the shipped templates before its first gather.
          {
            name: '内置模板库', impact: '随应用分发的模板没有补进模板库，未选模板集的实例无法识别画面',
            run: async () => {
              const seeded = await automation.seedBuiltinTemplates('wanlong', builtinTemplates);
              const copied = Object.keys(seeded?.copiedSets ?? {}).length;
              const added = Object.values(seeded?.addedTemplates ?? {}).reduce((sum, ids) => sum + ids.length, 0);
              if (copied || added) appLog.info('templates', `内置模板库已补进模板库：新模板集 ${copied} 个，已有模板集补充模板 ${added} 张`);
              for (const [setId, reason] of Object.entries(seeded?.skipped ?? {})) appLog.warn('templates', `内置模板集 ${setId} 未补进：${reason}`);
            },
          },
          {
            name: '模拟器日志记录', impact: '模拟器管理器的警告不会写入助手日志文件',
            run: async () => (await services.host.get()).on('log', (entry) => appLog.record(entry.level, 'emulator', entry.message, undefined, entry.index)),
          },
          // Alerts first (original order): a wake re-armed by the scheduler may raise an alert right away.
          { name: '异常告警', impact: '掉线、顶号与卡死不会自动暂停或推送', run: async () => { await Promise.all([alerts.hub.ready, alerts.center.ready]); } },
          { name: '自动续跑调度', impact: '自动采集不会续跑', run: () => automation.restoreSchedules() },
          // After the scheduler restored its switches: close pauses of deleted / resumed instances, carry the rest.
          { name: '暂停状态核对', impact: '重启前的暂停可能多算或少算', run: () => stats.reconcilePauses() },
          { name: '脚本计划', impact: '定时脚本不会自动运行', run: () => plans.start('wanlong') },
          { name: 'Telegram 机器人', impact: '手机上的机器人命令与告警消息下面的按钮不会响应', run: async () => { await remoteBot.start(); } },
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
          { name: 'Telegram 机器人', run: () => remoteBot.dispose() },
          // Aborts freeze restarts first (quitting must not wait minutes), then flushes pauses and pushes.
          { name: '异常告警', run: () => alerts.dispose() },
          { name: '脚本计划', run: () => plans.shutdown() },
          { name: '账号登录', run: () => accounts.shutdown() },
          { name: '登录检查', run: () => homeVerifier.dispose() },
          { name: '自动化运行', run: () => automation.dispose() },
          { name: '运行统计', run: () => insights.dispose() },
          { name: '数据统计', run: () => stats.stop() },
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
