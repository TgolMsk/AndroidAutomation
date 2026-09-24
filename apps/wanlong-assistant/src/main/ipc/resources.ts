import type { OpenDialogOptions } from 'electron';
import { RESOURCE_SEED_FRAMES, type ResourceSeedFrame } from '@avdm/automation/wanlong/pure';
import type { ResourcesApi, ResourceTemplateSeedSource } from '../../shared/ipc';
import type { AutomationHost } from '../automation/host';
import { readResourceSeedFolder } from '../resources/seed-frames';
import type { ResourcesService } from '../resources/service';
import type { DomainHandlers } from './types';
import { asIndex, flag, game } from './validate';

/** Services the resources handlers need. */
export interface ResourcesServices {
  resources: ResourcesService;
  automation: AutomationHost;
}

/** Only 万龙觉醒 has a resource table reader. */
function resourcesGame(resources: ResourcesService, value: unknown): string {
  const id = game(value);
  if (id !== resources.gameId) throw new Error('该游戏没有资源统计表');
  return id;
}

function seedSource(value: unknown): ResourceTemplateSeedSource {
  const source = value as { kind?: unknown; frame?: unknown } | null;
  if (source && typeof source === 'object' && source.kind === 'folder') return { kind: 'folder' };
  if (source && typeof source === 'object' && source.kind === 'screen' && RESOURCE_SEED_FRAMES.includes(source.frame as ResourceSeedFrame)) {
    return { kind: 'screen', frame: source.frame as ResourceSeedFrame };
  }
  throw new Error('截图来源无效');
}

export const resourcesHandlers: DomainHandlers<ResourcesApi, ResourcesServices> = {
  async resourcesRead({ resources }, gameId, index) {
    resourcesGame(resources, gameId);
    return resources.read(asIndex(index));
  },
  async resourcesReading({ resources }, gameId) {
    resourcesGame(resources, gameId);
    return resources.readingList();
  },
  async resourcesSeedTemplates({ resources, automation, sender }, gameId, index, source, overwrite) {
    const id = resourcesGame(resources, gameId);
    const i = asIndex(index);
    const from = seedSource(source);
    const replace = overwrite === undefined ? false : flag(overwrite, '覆盖开关');
    if (from.kind === 'screen') {
      // Read-only capture with the foreground check; the user has put the game on that screen by hand.
      const capture = await automation.captureTemplate(id, i);
      return automation.seedResourceTemplates(id, i, { [from.frame]: capture.png }, { overwrite: replace });
    }
    // Imported lazily (conventions §2.4): handler modules stay importable in vitest without the Electron mock.
    const { BrowserWindow, dialog } = await import('electron');
    const options: OpenDialogOptions = {
      title: '选择资源统计截图所在的文件夹', buttonLabel: '用这些截图裁模板', properties: ['openDirectory'],
    };
    const win = BrowserWindow.fromWebContents(sender);
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const dir = result.canceled ? null : result.filePaths[0] ?? null;
    if (!dir) return null;
    const folder = await readResourceSeedFolder(dir);
    return automation.seedResourceTemplates(id, i, folder.frames, { overwrite: replace, files: folder.files });
  },
};
