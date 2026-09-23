import type { TemplateSet } from '@avdm/automation';
import type { MonitorPorts } from './types';

/** IDs are the old panel's reserved IDs. They become active only after the user authors samples. */
export const RESERVED_ALERT_TEMPLATES = {
  kickedDialog: 'tpl_dlg_kicked',
  loginScreen: 'tpl_login_screen',
  maintenanceDialog: 'tpl_dlg_maintenance',
  updateDialog: 'tpl_dlg_update',
} as const;

const CANDIDATES = [
  { id: RESERVED_ALERT_TEMPLATES.kickedDialog, kind: 'suspectedKicked', reason: '两次画面均匹配「账号在其他设备登录」提示。' },
  { id: RESERVED_ALERT_TEMPLATES.loginScreen, kind: 'suspectedKicked', reason: '采集失败后连续两次停留在登录界面，疑似账号已退出。' },
  { id: RESERVED_ALERT_TEMPLATES.maintenanceDialog, kind: 'maintenanceRequired', reason: '两次画面均匹配服务器维护提示。' },
  { id: RESERVED_ALERT_TEMPLATES.updateDialog, kind: 'updateRequired', reason: '两次画面均匹配强制更新提示。' },
] as const;

export interface SpecificScene {
  kind: (typeof CANDIDATES)[number]['kind'];
  message: string;
  templateId: string;
  score: number;
  threshold: number;
  screenshot: Uint8Array;
}

export interface SceneProbePorts extends Pick<MonitorPorts, 'testTemplate' | 'sleep'> {}

/** Two independent, fresh screenshots are required; a single OpenCV match cannot raise an alert. */
export async function probeSpecificScene(
  gameId: string,
  index: number,
  set: TemplateSet | null,
  ports: SceneProbePorts,
): Promise<SpecificScene | null> {
  if (!set) return null;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (const candidate of CANDIDATES) {
    const definition = set.templates.find((item) => item.id === candidate.id);
    if (!definition) continue;
    const threshold = Math.max(0.92, definition.threshold ?? 0.85);
    try {
      const first = await ports.testTemplate(gameId, index, candidate.id);
      if (!first.match.found || first.match.score < threshold) continue;
      await sleep(1_000);
      const second = await ports.testTemplate(gameId, index, candidate.id);
      if (!second.match.found || second.match.score < threshold) continue;
      return {
        kind: candidate.kind,
        message: candidate.reason,
        templateId: candidate.id,
        score: Math.min(first.match.score, second.match.score),
        threshold,
        screenshot: second.preview.png,
      };
    } catch {
      // An unavailable or incompatible optional template must never fail a gather cycle.
    }
  }
  return null;
}
