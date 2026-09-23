import { mkdir } from 'node:fs/promises';
import { BrowserWindow, Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import { defaultHome } from '@avdm/core';
import { sendEvent } from './events';
import type { ManagerHost } from './manager-host';

const ALWAYS_ON_TOP_ID = 'always-on-top';

/** Reflect `win`'s always-on-top state in 窗口 › 置顶显示 (when it is the focused window). */
export function refreshAlwaysOnTopMenu(win: BrowserWindow): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(ALWAYS_ON_TOP_ID);
  if (!item || win.isDestroyed()) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused !== win) return;
  item.checked = win.isAlwaysOnTop();
}

async function openDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  const err = await shell.openPath(dir);
  if (err) console.error(`[avdm] 无法打开目录 ${dir}: ${err}`);
}

/** Chinese application menu with the standard macOS roles. */
export function installAppMenu(host: ManagerHost): void {
  const mac = process.platform === 'darwin';
  const name = app.name;
  const homeDir = () => host.manager?.paths.home ?? defaultHome();

  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: name,
      submenu: [
        { role: 'about', label: `关于 ${name}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${name}` },
      ],
    });
  }
  template.push(
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => void openDir(homeDir()) },
        {
          label: '打开脚本目录',
          click: () => void openDir(host.manager?.paths.scriptsDir ?? `${homeDir()}/scripts`),
        },
        {
          label: '打开日志目录',
          click: () => void openDir(host.manager?.paths.logsDir ?? `${homeDir()}/logs`),
        },
        { type: 'separator' },
        mac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'forceReload', label: '强制重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      role: 'window',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        {
          id: ALWAYS_ON_TOP_ID,
          label: '置顶显示',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: (item) => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) {
              item.checked = false;
              return;
            }
            win.setAlwaysOnTop(item.checked, 'floating');
            // Live windows show the state on their 置顶 button.
            sendEvent(win.webContents, 'window-state', { alwaysOnTop: win.isAlwaysOnTop() });
          },
        },
        { type: 'separator' },
        ...(mac ? [{ role: 'front', label: '前置全部窗口' } as const] : [{ role: 'close', label: '关闭' } as const]),
      ],
    },
  );

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Reflect the focused window's always-on-top state in the checkbox.
  app.on('browser-window-focus', (_event, win) => {
    const item = menu.getMenuItemById(ALWAYS_ON_TOP_ID);
    if (item) item.checked = win.isAlwaysOnTop();
  });
}
