import { Card } from '../../components/Card';
import { HealthBadge } from '../../components/HealthBadge';
import { SemanticTag } from '../../components/SemanticTag';
import { healthBadgeText, useAppHealth } from '../../hooks/useAppHealth';

/** 环境自检 laid out in full: the emulator doctor checks plus the assistant's own (templates, OpenCV, disk …). */
export function HealthCard() {
  const { report } = useAppHealth();
  const text = healthBadgeText(report);
  return (
    <Card title="环境自检" icon="gauge" extra={<SemanticTag tone={text.tone}>{text.label}</SemanticTag>}>
      <p className="settings-muted">启动后自动检查一次；模拟器、SDK 的问题请在「AVD 多开管理器」里处理，助手自身的问题按每项的提示处理。</p>
      <HealthBadge compact={false} />
    </Card>
  );
}
