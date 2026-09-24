import { avdm } from '../../api';
import { useNavigation } from '../../state/navigation';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import { PlanPanel } from '../automation/PlanPanel';
import type { ViewProps } from '../types';

/**
 * 脚本: the script library and editor. Kept alive by the shell so an unsaved draft survives the round trip to
 * the template library (「从画面截取并添加」 → save template → back here with the step inserted).
 */
export function ScriptsView({ visible }: ViewProps) {
  const { game, index } = useSelection();
  const flow = useTemplateFlow();
  const { navigate } = useNavigation();
  const { refreshPlanRuns } = usePlanRuns();
  if (!game) return null;
  // A manual run of the saved script on the current instance; the 执行监控 page shows its progress and logs.
  const tryRun = async (scriptId: string): Promise<void> => {
    if (index === null) throw new Error('请先在顶部选择实例');
    await avdm.scriptRun(game.id, index, scriptId);
    await refreshPlanRuns();
    navigate('runs');
  };
  return (
    <PlanPanel
      key={game.id} gameId={game.id} index={index} visible={visible} mode="scripts"
      onCreateTemplate={flow.startScriptTemplate} templateResult={flow.scriptResult} onTemplateResultHandled={flow.clearScriptResult}
      onTryRun={tryRun}
    />
  );
}
