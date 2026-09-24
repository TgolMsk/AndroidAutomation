/**
 * Mount points for settings that other modules own. Each one says only what exists in this build and where it
 * lives, and links there; the owning module replaces its entry in `cards.ts` with its own card component (one
 * line, no other edit) and describes its new switches there.
 */
import { Card } from '../../components/Card';
import { useNavigation } from '../../state/navigation';
import type { ViewKey } from '../../navigation';

function SlotCard({ title, icon, lines, link }: {
  title: string;
  icon: 'alert' | 'terminal' | 'chip' | 'package';
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

/** 机器人 (bot module). */
export function BotSlotCard() {
  return (
    <SlotCard
      title="机器人" icon="terminal"
      lines={['机器人的开关、Chat ID 与授权用户 ID 在上面「通知与推送」卡片的「手机机器人」一节。', '目前只能查看：/status 看实例状态，/shot <编号> 取当前游戏画面。']}
    />
  );
}

/** AI (advisor module). */
export function AiSlotCard() {
  return (
    <SlotCard
      title="AI 处理" icon="chip"
      lines={['视觉模型接口、每小时请求上限与同实例冷却、分析记录都在「AI 处理」页。', '目前 AI 只给建议与风险判断，点击和保存模板都由你决定。']}
      link={{ label: '前往 AI 处理', view: 'ai' }}
    />
  );
}

/** 导入旧版数据 (legacy import module). */
export function LegacyImportSlotCard() {
  return (
    <SlotCard
      title="导入旧版数据" icon="package"
      lines={['原万龙面板的脚本：在「脚本与模板 → 脚本」页用「导入旧脚本 JSON」，导入后逐条校验、不会自动执行。', '原万龙面板的任务计划：在「运行记录 → 任务计划」页用「导入旧 plans.json」映射到当前账号，导入的计划默认关闭。']}
      link={{ label: '前往脚本', view: 'scripts' }}
    />
  );
}
