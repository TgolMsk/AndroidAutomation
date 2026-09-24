import { useEffect, useState } from 'react';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/StatusBadge';
import { useSelection } from '../../state/selection';

type AppInfo = Awaited<ReturnType<typeof avdm.appInfo>>;

const PLATFORM: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** App version, platform and the loaded game module. */
export function AboutCard() {
  const { game, games, gamesLoaded, gamesError, reloadGames } = useSelection();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState<string>();

  useEffect(() => {
    let active = true;
    avdm.appInfo().then((value) => { if (active) setInfo(value); })
      .catch((error: unknown) => { if (active) setInfoError(errMsg(error)); });
    return () => { active = false; };
  }, []);

  return (
    <Card title="应用信息" icon="info">
      {infoError && <p className="settings-error" role="alert">读取失败：{infoError}</p>}
      {!info && !infoError ? <p className="settings-muted"><Spinner size={12} /> 正在读取…</p> : info && (
        <dl className="settings-facts">
          <div><dt>版本</dt><dd className="mono">{info.version}</dd></div>
          <div><dt>系统</dt><dd>{PLATFORM[info.platform] ?? info.platform} · {info.arch}</dd></div>
        </dl>
      )}
      {gamesError && <p className="settings-error" role="alert">游戏模块加载失败：{gamesError}<button className="btn xs" onClick={() => void reloadGames()}>重试</button></p>}
      {!gamesLoaded ? <p className="settings-muted"><Spinner size={12} /> 正在读取游戏模块…</p> : games.map((item) => (
        <dl key={item.id} className="settings-facts">
          <div><dt>游戏</dt><dd>{item.name}{item.id === game?.id ? '（当前）' : ''}</dd></div>
          <div><dt>模块版本</dt><dd className="mono">v{item.version}</dd></div>
          <div className="settings-wide"><dt>包名</dt><dd className="mono">{item.packageName}</dd></div>
        </dl>
      ))}
    </Card>
  );
}
