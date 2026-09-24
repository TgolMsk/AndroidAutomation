/**
 * 「AI 处理」 settings card (the `ai` entry of `cards.ts`). The configuration itself lives on the AI page (original:
 * the settings page only points there); this card shows what is switched on right now and links to it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AdvisorStatus } from '../../../shared/ai';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { SemanticTag } from '../../components/SemanticTag';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useNavigation } from '../../state/navigation';
import { statusLine } from '../ai/ai-view-model';
import type { SettingsCardProps } from './cards';

export function AiSettingsCard({ visible }: SettingsCardProps) {
  const { navigate } = useNavigation();
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setStatus(await avdm.advisorStatus()); setError(null); }
    catch (cause) { setError(errMsg(cause)); }
  }, []);
  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);
  useAvdmEvent('ai-config-changed', () => { if (visible) void refresh(); });

  const tag = !status ? null : !status.configured
    ? <SemanticTag tone="danger">未配置</SemanticTag>
    : !status.enabled ? <SemanticTag tone="warning">已关闭</SemanticTag>
      : status.autoActions ? <SemanticTag tone="success">自动处理中</SemanticTag> : <SemanticTag tone="info">只记录建议</SemanticTag>;

  return (
    <Card title={<>AI 处理{tag}</>} icon="chip" extra={<button type="button" className="btn sm" onClick={() => navigate('ai')}>前往 AI 处理</button>}>
      {error ? <p className="settings-muted" role="alert">AI 顾问状态读取失败：{error}</p> : <p className="settings-muted">{statusLine(status)}</p>}
      <p className="settings-muted">视觉模型接口、每小时次数与同实例冷却、「自动处理」与模板自学开关、处理记录都在「AI 处理」页。截图只发送到你填写的接口，API Key 只存本机。</p>
    </Card>
  );
}
