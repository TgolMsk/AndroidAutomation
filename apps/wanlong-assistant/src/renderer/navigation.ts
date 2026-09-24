/**
 * Information architecture of the assistant: seven top-level sections with their pages, following the
 * original panel (`wanlong-panel/src/renderer/src/navigation.tsx`). Pure data and helpers, testable in Node.
 *
 * ★ A ViewKey appears exactly once in NAVIGATION: `sectionForView` takes the first hit, so a duplicate would
 *   highlight the wrong section. When a page is removed, map its key in RETIRED_VIEWS so remembered pages
 *   still land somewhere sensible instead of silently falling back to the default.
 */
import type { IconName } from './components/Icon';

export type ViewKey =
  | 'instances'
  | 'accounts'
  | 'gatherOverview'
  | 'scriptConsole'
  | 'plans'
  | 'runs'
  | 'stats'
  | 'ai'
  | 'scripts'
  | 'templates'
  | 'settings';

export type SectionKey = 'devices' | 'gather' | 'activity' | 'stats' | 'ai' | 'tools' | 'settings';

export interface NavigationView {
  key: ViewKey;
  label: string;
}

export interface NavigationSection {
  key: SectionKey;
  label: string;
  description: string;
  icon: IconName;
  views: readonly NavigationView[];
}

export const NAVIGATION: readonly NavigationSection[] = [
  {
    key: 'devices',
    label: '设备与账号',
    description: '管理模拟器实例、查看连接状态与绑定账号',
    icon: 'devices',
    views: [
      { key: 'instances', label: '模拟器实例' },
      { key: 'accounts', label: '账号管理' },
    ],
  },
  {
    key: 'gather',
    label: '自动采集',
    description: '采集配置、只读探测、运行一轮与自动续跑',
    icon: 'play',
    views: [{ key: 'gatherOverview', label: '采集总览' }],
  },
  {
    key: 'activity',
    label: '运行记录',
    description: '多台模拟器统一执行脚本、排定定时任务，查看正在执行的任务与最近结果',
    icon: 'log',
    views: [
      { key: 'scriptConsole', label: '脚本控制台' },
      { key: 'plans', label: '任务计划' },
      { key: 'runs', label: '执行监控' },
    ],
  },
  {
    key: 'stats',
    label: '数据统计',
    description: '按北京日期看派兵、预计采集量、失败熔断与告警',
    icon: 'gauge',
    views: [{ key: 'stats', label: '数据统计' }],
  },
  {
    key: 'ai',
    label: 'AI 处理',
    description: '认不出界面时问视觉大模型，查看建议与处理记录',
    icon: 'chip',
    views: [{ key: 'ai', label: 'AI 处理' }],
  },
  {
    key: 'tools',
    label: '脚本与模板',
    description: '编排脚本与维护识别模板',
    icon: 'script',
    views: [
      { key: 'scripts', label: '脚本' },
      { key: 'templates', label: '模板库' },
    ],
  },
  {
    key: 'settings',
    label: '设置',
    description: '管理运行环境、日志与通知',
    icon: 'settings',
    views: [{ key: 'settings', label: '应用设置' }],
  },
];

export const VIEW_KEYS: readonly ViewKey[] = NAVIGATION.flatMap((section) => section.views.map((view) => view.key));

export const DEFAULT_VIEW: ViewKey = 'instances';

/** localStorage key of the last page. */
export const VIEW_STORAGE_KEY = 'wl.view';

/** Retired page keys → where they live now (original panel keys and the old single-page workspace tabs). */
export const RETIRED_VIEWS: Readonly<Record<string, ViewKey>> = {
  gatherConfig: 'gatherOverview',
  run: 'gatherOverview',
  insights: 'stats',
  advisor: 'ai',
};

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === 'string' && (VIEW_KEYS as readonly string[]).includes(value);
}

export function sectionForView(view: ViewKey): NavigationSection {
  return NAVIGATION.find((section) => section.views.some((item) => item.key === view)) ?? NAVIGATION[0]!;
}

export function viewLabel(view: ViewKey): string {
  return sectionForView(view).views.find((item) => item.key === view)?.label ?? view;
}

/** A remembered value → a current page; unknown or empty values fall back to the default page. */
export function parseStoredView(raw: string | null | undefined): ViewKey {
  if (isViewKey(raw)) return raw;
  const moved = raw ? RETIRED_VIEWS[raw] : undefined;
  return moved ?? DEFAULT_VIEW;
}

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ViewStorage | undefined {
  return typeof window !== 'undefined' ? window.localStorage : undefined;
}

/**
 * The last page, or the default. Storage can throw (private windows, blocked site data): page memory is a
 * convenience and must never blank the app, so every access is guarded.
 */
export function readStoredView(storage?: ViewStorage): ViewKey {
  try {
    const store = storage ?? defaultStorage();
    const raw = store?.getItem(VIEW_STORAGE_KEY);
    const view = parseStoredView(raw);
    if (raw && raw !== view && RETIRED_VIEWS[raw]) store?.setItem(VIEW_STORAGE_KEY, view);
    return view;
  } catch {
    return DEFAULT_VIEW;
  }
}

export function storeView(view: ViewKey, storage?: ViewStorage): void {
  try { (storage ?? defaultStorage())?.setItem(VIEW_STORAGE_KEY, view); }
  catch { /* Not remembering the page is harmless. */ }
}

/** Page to open when a section is clicked: the page last used in that section this session, else its first. */
export function viewForSection(section: SectionKey, memory: Partial<Record<SectionKey, ViewKey>>): ViewKey {
  const target = NAVIGATION.find((item) => item.key === section) ?? NAVIGATION[0]!;
  const remembered = memory[section];
  return remembered && target.views.some((item) => item.key === remembered) ? remembered : target.views[0]!.key;
}
