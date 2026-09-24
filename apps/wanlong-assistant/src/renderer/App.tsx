/**
 * Assistant shell: side navigation with the seven sections, a top status bar (game, global instance picker,
 * running tasks, badges) and the content area. Page state lives in `state/*` providers so every page reads the
 * same game, instance and activity.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Settings } from '@avdm/core';
import { avdm } from './api';
import { BADGE_SOURCES } from './badge-sources';
import { HealthBadge } from './components/HealthBadge';
import { Icon } from './components/Icon';
import { Spinner, StatusDot } from './components/StatusBadge';
import { displayStatus, displayStatusLabel, isRunning } from './format';
import { useAvdmEvent } from './hooks/useAvdmEvent';
import { NAVIGATION, sectionForView, type ViewKey } from './navigation';
import { ActivityProvider, useActivity } from './state/activity';
import { BadgesProvider, sectionTones, useShellBadges } from './state/badges';
import { NavigationProvider, useNavigation } from './state/navigation';
import { PlanImportProvider } from './state/plan-import';
import { PlanRunsProvider, scriptRunBadge, usePlanRuns } from './state/plan-runs';
import { SelectionProvider, useSelection } from './state/selection';
import { TemplateFlowProvider } from './state/template-flow';
import { VIEW_REGISTRY, restoredScrollTop } from './views/registry';
import { SidebarUpdate } from './views/update/SidebarUpdate';
import './shell.css';
import appIcon from './assets/brand/app-icon.png';

const COLLAPSED_KEY = 'wl.nav.collapsed';

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; }
  catch { return false; }
}

function storeCollapsed(collapsed: boolean): void {
  try { window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); }
  catch { /* Remembering the sidebar width is only a convenience. */ }
}

/** The emulator's global running limit, for the 「在线 N/上限」 chip. */
function useMaxRunning(): number | null {
  const [max, setMax] = useState<number | null>(null);
  const load = (): void => {
    avdm.getSettings().then((settings: Settings) => setMax(settings.maxRunning)).catch(() => undefined);
  };
  useEffect(load, []);
  useAvdmEvent('settings-changed', load);
  return max;
}

function GameStatus() {
  const { games, game, setGameId, gamesLoaded, gamesError } = useSelection();
  if (!game) {
    return <span className={`wl-shell-chip ${gamesError ? 'is-bad' : ''}`}>{gamesError ? '游戏模块不可用' : gamesLoaded ? '无可用游戏模块' : '正在载入游戏模块'}</span>;
  }
  if (games.length > 1) {
    return (
      <label className="wl-shell-picker">
        <span>游戏</span>
        <select value={game.id} onChange={(event) => setGameId(event.target.value)} aria-label="当前游戏">
          {games.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
    );
  }
  return <span className="wl-shell-chip" title={game.packageName}><Icon name="package" size={14} />{game.name}</span>;
}

function InstancePicker() {
  const { targets, index, setIndex, lockReason, selectedInstance, instancesLoaded } = useSelection();
  const { scriptRunByInstance } = usePlanRuns();
  return (
    <label className="wl-shell-picker" title={lockReason ?? '所有页面都针对当前实例操作'}>
      <span>当前实例</span>
      <select
        value={index ?? ''} onChange={(event) => setIndex(Number(event.target.value))}
        disabled={targets.length === 0 || Boolean(lockReason)} aria-label="当前实例"
      >
        {targets.length === 0 && <option value="">{instancesLoaded ? '暂无实例' : '正在读取…'}</option>}
        {targets.map((target) => (
          <option key={target.index} value={target.index}>
            {`#${target.index} · ${target.instance ? `${target.instance.record.name} · ${displayStatusLabel(displayStatus(target.instance))}` : '实例已移除 · 可关闭自动续跑'}${scriptRunByInstance.has(target.index) ? ` · ${scriptRunBadge(scriptRunByInstance.get(target.index)!)}` : ''}`}
          </option>
        ))}
      </select>
      {selectedInstance && <StatusDot status={displayStatus(selectedInstance)} />}
    </label>
  );
}

function TopBar() {
  const { view, navigate } = useNavigation();
  const { runningCount } = useActivity();
  const { activePlanRuns } = usePlanRuns();
  const executing = runningCount + activePlanRuns;
  const { instances } = useSelection();
  const badges = useShellBadges();
  const maxRunning = useMaxRunning();
  const section = sectionForView(view);
  const online = instances.filter(isRunning).length;
  const full = maxRunning !== null && online >= maxRunning;
  return (
    <header className="wl-shell-topbar">
      <div className="wl-shell-heading">
        <h1>{section.label}</h1>
        <p>{section.description}</p>
      </div>
      <div className="wl-shell-status">
        <GameStatus />
        <InstancePicker />
        <span className={`wl-shell-chip ${full ? 'is-warn' : ''}`} title="已开机实例数 / 模拟器同时运行上限">在线 {online}/{maxRunning ?? '—'}</span>
        <span className={`wl-shell-chip ${executing > 0 ? 'is-accent' : ''}`} title={`采集 ${runningCount} 个 · 脚本 ${activePlanRuns} 个（含排队）`}>执行中 {executing}</span>
        <HealthBadge />
        {badges.length > 0 && <div className="wl-shell-badges" role="status" aria-label="待处理事项">
          {badges.map((badge) => (
            <button
              key={badge.id} type="button" className={`wl-shell-badge is-${badge.tone}`} title={badge.detail ?? badge.label}
              onClick={badge.view ? () => navigate(badge.view!) : undefined} disabled={!badge.view}
            >
              <Icon name={badge.tone === 'info' ? 'info' : 'alert'} size={13} />{badge.label}
            </button>
          ))}
        </div>}
      </div>
    </header>
  );
}

function Sidebar() {
  const { view, openSection } = useNavigation();
  const badges = useShellBadges();
  const tones = sectionTones(badges);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const active = sectionForView(view).key;
  return (
    <aside className={`wl-shell-sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="wl-shell-brand">
        <span className="wl-shell-brand-mark" aria-hidden="true"><img src={appIcon} alt="" draggable={false} /></span>
        <div className="wl-shell-brand-text"><strong>万龙助手</strong><small>多账号自动化工作台</small></div>
      </div>
      <nav className="wl-shell-nav" aria-label="主导航">
        {NAVIGATION.map((section) => {
          const tone = tones[section.key];
          return (
            <button
              key={section.key} type="button" className="wl-shell-nav-item" aria-current={section.key === active ? 'page' : undefined}
              onClick={() => openSection(section.key)} title={section.label}
            >
              <Icon name={section.icon} size={17} />
              <span className="wl-shell-nav-label">{section.label}</span>
              {tone && <span className={`wl-shell-dot is-${tone}`} role="img" aria-label="有待处理事项" />}
            </button>
          );
        })}
      </nav>
      <div className="wl-shell-sidebar-foot">
        <SidebarUpdate collapsed={collapsed} />
        <button
          type="button" className="icon-btn" onClick={() => { const next = !collapsed; setCollapsed(next); storeCollapsed(next); }}
          aria-label={collapsed ? '展开导航' : '收起导航'} title={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed}
        >
          <Icon name={collapsed ? 'list' : 'back'} />
        </button>
      </div>
    </aside>
  );
}

function GameGate() {
  const { gamesLoaded, gamesError, reloadGames } = useSelection();
  return (
    <div className="wl-shell-empty">
      {gamesLoaded ? <Icon name="package" size={28} /> : <Spinner size={22} />}
      <h2>{gamesError ? '游戏模块加载失败' : gamesLoaded ? '游戏模块不可用' : '正在载入万龙觉醒模块'}</h2>
      <p>{gamesError || (gamesLoaded ? '请重新启动万龙助手。' : '正在连接本机模拟器数据。')}</p>
      {gamesError && <button className="btn" onClick={() => void reloadGames()}>重试</button>}
    </div>
  );
}

function Page({ viewKey, visible }: { viewKey: ViewKey; visible: boolean }) {
  const { game } = useSelection();
  const entry = VIEW_REGISTRY[viewKey];
  const View = entry.component;
  return (
    <div className="wl-shell-page" hidden={!visible} data-view={viewKey}>
      {entry.needsGame && !game ? <GameGate /> : <View visible={visible} />}
    </div>
  );
}

function Workspace() {
  const { view, navigate } = useNavigation();
  const section = sectionForView(view);
  const content = useRef<HTMLElement>(null);
  const [kept, setKept] = useState<ViewKey[]>([]);
  // The pages share one scroll container: remember where each page was left.
  const scrollTops = useRef(new Map<ViewKey, number>());
  const shown = useRef(view);

  useEffect(() => {
    if (VIEW_REGISTRY[view].keepAlive) setKept((current) => current.includes(view) ? current : [...current, view]);
  }, [view]);

  // Before paint, so a kept-alive page never flashes at another page's offset.
  useLayoutEffect(() => {
    shown.current = view;
    if (content.current) content.current.scrollTop = restoredScrollTop(view, scrollTops.current);
  }, [view]);

  // Render a kept-alive page on its very first visit too (the state catches up in the effect).
  const keptViews = VIEW_REGISTRY[view].keepAlive && !kept.includes(view) ? [...kept, view] : kept;

  return (
    <div className="wl-shell-workspace">
      <TopBar />
      {section.views.length > 1 && (
        <nav className="wl-shell-subnav" aria-label={`${section.label}页面`}>
          {section.views.map((item) => (
            <button key={item.key} type="button" aria-current={view === item.key ? 'page' : undefined} onClick={() => navigate(item.key)}>
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <main
        className="wl-shell-content" ref={content}
        onScroll={(event) => { scrollTops.current.set(shown.current, event.currentTarget.scrollTop); }}
      >
        {keptViews.map((key) => <Page key={key} viewKey={key} visible={key === view} />)}
        {!VIEW_REGISTRY[view].keepAlive && <Page key={view} viewKey={view} visible />}
      </main>
    </div>
  );
}

function BadgeSources() {
  return <>{BADGE_SOURCES.map((Source, i) => <Source key={i} />)}</>;
}

export function App() {
  return (
    <NavigationProvider>
      <ActivityProvider>
        <SelectionProvider>
          <PlanRunsProvider>
            <TemplateFlowProvider>
              <PlanImportProvider>
                <BadgesProvider>
                  <BadgeSources />
                  <div className="wl-shell">
                    <Sidebar />
                    <Workspace />
                  </div>
                </BadgesProvider>
              </PlanImportProvider>
            </TemplateFlowProvider>
          </PlanRunsProvider>
        </SelectionProvider>
      </ActivityProvider>
    </NavigationProvider>
  );
}
