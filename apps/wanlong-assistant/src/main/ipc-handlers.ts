import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { errorCode, errorMessage } from '@avdm/emulator-shell/main/util';
import { isAppUrl, type WindowKind, type WindowManager } from '@avdm/emulator-shell/main/windows';
import type { IpcEnvelope } from '@avdm/emulator-shell/main/ipc-handlers';
import { explainLeaseTimeout } from './app/instance-access';
import { WANLONG_INVOKE_METHODS, wanlongInvokeChannel, type WanlongDomainApi } from '../shared/ipc';
import { accountsHandlers, type AccountsServices } from './ipc/accounts';
import { advisorHandlers, type AdvisorServices } from './ipc/advisor';
import { alertsHandlers, type AlertsServices } from './ipc/alerts';
import { appHandlers, type AppServices } from './ipc/app';
import { automationHandlers, type AutomationServices } from './ipc/automation';
import { botHandlers, type BotServices } from './ipc/bot';
import { insightsHandlers, type InsightsServices } from './ipc/insights';
import { instancesHandlers, type InstancesServices } from './ipc/instances';
import { plansHandlers, type PlansServices } from './ipc/plans';
import { resourcesHandlers, type ResourcesServices } from './ipc/resources';
import { runsHandlers, type RunsServices } from './ipc/runs';
import { schedulerHandlers, type SchedulerServices } from './ipc/scheduler';
import { statsHandlers, type StatsServices } from './ipc/stats';
import { templatesHandlers, type TemplatesServices } from './ipc/templates';
import type { DomainHandlers, HandlerBase } from './ipc/types';
import { updateHandlers, type UpdateServices } from './ipc/update';

export type { DomainHandlers, HandlerBase } from './ipc/types';

/** Every service any domain handler needs, plus the window manager used for authorization. */
export type WanlongServices =
  AutomationServices & TemplatesServices & AccountsServices & PlansServices & RunsServices & InsightsServices &
  StatsServices & AlertsServices & BotServices & ResourcesServices & AdvisorServices & SchedulerServices &
  InstancesServices & AppServices & UpdateServices & { windows: WindowManager };

type HandlerContext = WanlongServices & HandlerBase;

/** A domain left out of this spread is a compile error: `HandlerMap` requires every invoke method. */
const handlers: DomainHandlers<WanlongDomainApi, WanlongServices> = {
  ...automationHandlers,
  ...templatesHandlers,
  ...accountsHandlers,
  ...plansHandlers,
  ...runsHandlers,
  ...insightsHandlers,
  ...statsHandlers,
  ...alertsHandlers,
  ...botHandlers,
  ...resourcesHandlers,
  ...advisorHandlers,
  ...schedulerHandlers,
  ...instancesHandlers,
  ...appHandlers,
  ...updateHandlers,
};

/** Game commands are unavailable to live windows and unknown renderer frames. */
export function authorizeWanlongInvoke(frameUrl: string | undefined, kind: WindowKind | undefined): void {
  if (!frameUrl || !isAppUrl(frameUrl)) throw new Error('拒绝来自未知页面的请求');
  if (kind !== 'main') throw new Error('此操作仅允许在万龙助手主窗口执行');
}

/** Failures travel as data with their code; the renderer rebuilds a `WanlongError` from the envelope. */
export function errorEnvelope(error: unknown): IpcEnvelope {
  const code = errorCode(error);
  return { ok: false, error: code ? { message: errorMessage(error), code } : { message: errorMessage(error) } };
}

/** Register assistant-only channels after the generic emulator channels. */
export function registerWanlongIpcHandlers(services: WanlongServices): void {
  for (const method of WANLONG_INVOKE_METHODS) {
    const handler = handlers[method] as (ctx: HandlerContext, ...args: unknown[]) => Promise<unknown>;
    ipcMain.handle(wanlongInvokeChannel(method), async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<IpcEnvelope> => {
      try {
        authorizeWanlongInvoke(event.senderFrame?.url, services.windows.kindOf(event.sender));
        return { ok: true, value: await handler({ ...services, sender: event.sender }, ...args) };
      } catch (error) {
        return errorEnvelope(await explainLeaseTimeout(error, services.appHome));
      }
    });
  }
}
