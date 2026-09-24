/**
 * Mount points for settings that other modules own. Each one says where the setting lives today and links there;
 * the owning module replaces its entry in `cards.ts` with its own card component (one line, no other edit).
 */
import { useEffect, useState } from 'react';
import { avdm } from '../../api';
import { Card } from '../../components/Card';
import { useNavigation } from '../../state/navigation';
import type { ViewKey } from '../../navigation';

function SlotCard({ title, icon, lines, link }: {
  title: string;
  icon: 'alert' | 'terminal' | 'chip' | 'download' | 'package';
  lines: string[];
  link?: { label: string; view: ViewKey };
}) {
  const { navigate } = useNavigation();
  return (
    <Card title={title} icon={icon} extra={link && <button type="button" className="btn sm" onClick={() => navigate(link.view)}>{link.label}</button>}>
      {lines.map((line) => <p key={line} className="settings-muted">{line}</p>)}
    </Card>
  );
}

/** 通知与推送 (alerts module). */
export function NotificationsSlotCard() {
  return (
    <SlotCard
      title="通知与推送" icon="alert"
      lines={['本机通知与 Telegram 推送目前按实例在「数据统计」页配置；推送里的时间一律是北京时间。', 'Bot Token 用系统钥匙串加密保存，界面与日志里只显示是否已设置。']}
      link={{ label: '前往数据统计', view: 'stats' }}
    />
  );
}

/** 机器人 (bot module). */
export function BotSlotCard() {
  return (
    <SlotCard
      title="机器人" icon="terminal"
      lines={['Telegram 机器人（查看状态、截图）的开关、Chat ID 与授权用户 ID 在「数据统计」页的通知设置里。', '暂停、恢复、重新拉起等控制类动作默认关闭，需要显式开启。']}
      link={{ label: '前往数据统计', view: 'stats' }}
    />
  );
}

/** AI (advisor module). */
export function AiSlotCard() {
  return (
    <SlotCard
      title="AI 处理" icon="chip"
      lines={['视觉大模型接口、限频与冷却、处理记录都在「AI 处理」页。', '自动点击关闭弹窗与模板自学习默认关闭；关着时只记录建议。']}
      link={{ label: '前往 AI 处理', view: 'ai' }}
    />
  );
}

/** 版本与更新 (app-update module). */
export function UpdateSlotCard() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    avdm.appInfo().then((info) => { if (active) setVersion(info.version); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return (
    <SlotCard
      title="版本与更新" icon="download"
      lines={[`当前版本：${version ?? '读取中…'}`, '新版本发布在 GitHub Release（TgolMsk/AndroidAutomation），安装包为 Wanlong-Assistant-<版本>-mac-arm64.dmg。']}
    />
  );
}

/** 导入旧版数据 (legacy import module). */
export function LegacyImportSlotCard() {
  return (
    <SlotCard
      title="导入旧版数据" icon="package"
      lines={['原万龙面板的脚本与任务计划：在「脚本与模板 → 脚本」页使用「导入旧版」。', '导入的自动化一律默认关闭；凭据类配置需确认后才会加密保存。']}
      link={{ label: '前往脚本', view: 'scripts' }}
    />
  );
}
