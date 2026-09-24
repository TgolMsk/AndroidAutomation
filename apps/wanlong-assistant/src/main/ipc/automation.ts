import type { OpenDialogOptions } from 'electron';
import type { AutomationApi } from '../../shared/ipc';
import type { AutomationHost } from '../automation/host';
import type { DomainHandlers } from './types';
import { asIndex, flag, game, patchObject, text } from './validate';

export interface AutomationServices {
  automation: AutomationHost;
}

export const automationHandlers: DomainHandlers<AutomationApi, AutomationServices> = {
  async automationGames({ automation }) { return automation.games(); },
  async pickAutomationTemplateSet({ sender }) {
    // Imported lazily (conventions §2.4): domain handler modules stay importable in vitest without the Electron mock.
    const { BrowserWindow, dialog } = await import('electron');
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
    return automation.saveSettings(game(gameId), asIndex(index), patchObject(patch, '自动化设置'));
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
  async setAutomationSchedule({ automation }, gameId, index, enabled) {
    flag(enabled, '自动续跑开关');
    // No plans-vs-gather exclusion any more: a plan run preempts the scheduler (`eta.suspendForScript`).
    return automation.setSchedule(game(gameId), asIndex(index), enabled);
  },
  async automationRestartGame({ automation }, gameId, index) {
    return automation.restartGame(game(gameId), asIndex(index));
  },
};
