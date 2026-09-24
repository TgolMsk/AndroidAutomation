import { useEffect, useState } from 'react';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { useNavigation } from '../../state/navigation';
import { useSelection } from '../../state/selection';
import type { ViewProps } from '../types';
import './SettingsView.css';

type AppInfo = Awaited<ReturnType<typeof avdm.appInfo>>;

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** 应用设置: app and game module information, the data directory, and where each feature's settings live. */
export function SettingsView(_props: ViewProps) {
  const toast = useToast();
  const { navigate } = useNavigation();
  const { game, games, gamesLoaded, gamesError, reloadGames } = useSelection();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string>();

  useEffect(() => {
    let active = true;
    avdm.appInfo().then((value) => { if (active) setInfo(value); })
      .catch((error: unknown) => { if (active) setInfoError(errMsg(error)); });
    return () => { active = false; };
  }, []);

  async function reveal(path: string): Promise<void> {
    try { await avdm.revealPath(path); }
    catch (error) { toast.error('无法打开数据目录', errMsg(error)); }
  }

  return (
    <div className="settings-view">
      <section className="settings-card" aria-labelledby="settings-app-title">
        <h2 id="settings-app-title"><Icon name="info" />应用信息</h2>
        {infoError && <p className="settings-error" role="alert">读取失败：{infoError}</p>}
        {!info && !infoError ? <p className="settings-muted"><Spinner size={12} /> 正在读取…</p> : info && <dl className="settings-facts">
          <div><dt>版本</dt><dd className="mono">{info.version}</dd></div>
          <div><dt>系统</dt><dd>{PLATFORM[info.platform] ?? info.platform} · {info.arch}</dd></div>
          <div className="settings-wide"><dt>数据目录</dt><dd><span className="mono" title={info.home}>{info.home}</span><button className="btn xs" onClick={() => void reveal(info.home)}><Icon name="folder" />打开</button></dd></div>
        </dl>}
        <p className="settings-muted">助手的账号、模板、计划、统计等数据都保存在数据目录的 automation 子目录中，与模拟器管理器共用同一数据目录。</p>
      </section>

      <section className="settings-card" aria-labelledby="settings-game-title">
        <h2 id="settings-game-title"><Icon name="package" />游戏模块</h2>
        {gamesError && <p className="settings-error" role="alert">游戏模块加载失败：{gamesError}<button className="btn xs" onClick={() => void reloadGames()}>重试</button></p>}
        {!gamesLoaded ? <p className="settings-muted"><Spinner size={12} /> 正在读取…</p> : games.map((item) => <dl key={item.id} className="settings-facts">
          <div><dt>游戏</dt><dd>{item.name}{item.id === game?.id ? '（当前）' : ''}</dd></div>
          <div><dt>模块版本</dt><dd className="mono">v{item.version}</dd></div>
          <div className="settings-wide"><dt>包名</dt><dd className="mono">{item.packageName}</dd></div>
        </dl>)}
      </section>

      <section className="settings-card" aria-labelledby="settings-links-title">
        <h2 id="settings-links-title"><Icon name="settings" />功能设置</h2>
        <ul className="settings-links">
          <li><div><strong>通知与只读机器人</strong><span>本机通知、Telegram 推送与只读机器人按实例配置。</span></div><button className="btn sm" onClick={() => navigate('stats')}>前往数据统计</button></li>
          <li><div><strong>AI 顾问</strong><span>视觉大模型接口、限频与冷却。</span></div><button className="btn sm" onClick={() => navigate('ai')}>前往 AI 处理</button></li>
          <li><div><strong>任务计划</strong><span>计划总开关、补跑窗口、排队上限与失败重试。</span></div><button className="btn sm" onClick={() => navigate('plans')}>前往任务计划</button></li>
          <li><div><strong>采集配置</strong><span>每个实例的采集资源与自动续跑。</span></div><button className="btn sm" onClick={() => navigate('gatherOverview')}>前往采集总览</button></li>
        </ul>
      </section>
    </div>
  );
}
