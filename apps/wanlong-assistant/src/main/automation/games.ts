import { wanlongPlugin } from '@avdm/automation/wanlong';
import type { GamePlugin } from '@avdm/automation';
import type { AutomationGameSummary } from '../../shared/ipc';

interface RegisteredGame {
  plugin: GamePlugin;
  version: string;
  tasks: AutomationGameSummary['tasks'];
}

/** One registry owns the UI catalogue and the host's task allowlist. */
const games: ReadonlyMap<string, RegisteredGame> = new Map([
  [wanlongPlugin.id, {
    plugin: wanlongPlugin,
    version: '0.1.0',
    tasks: [{ id: 'gather-once', name: '采集一轮', description: '运行一次采集流程；结果中的唤醒建议不会自动执行。' }],
  }],
]);

export function gamePlugin(id: string): GamePlugin {
  const game = games.get(id);
  if (!game) throw new Error(`未知游戏包：${id}`);
  return game.plugin;
}

export function gameTask(gameId: string, taskId: string): AutomationGameSummary['tasks'][number] {
  const game = games.get(gameId);
  if (!game) throw new Error(`未知游戏包：${gameId}`);
  const task = game.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`未知自动化任务：${taskId}`);
  return task;
}

export function gameSummaries(): AutomationGameSummary[] {
  return [...games.values()].map(({ plugin, version, tasks }) => ({
    id: plugin.id,
    name: plugin.name,
    version,
    packageName: plugin.packageName,
    tasks: tasks.map((task) => ({ ...task })),
  }));
}
