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
  if (!game) return null;
  return (
    <PlanPanel
      key={game.id} gameId={game.id} index={index} visible={visible} mode="scripts"
      onCreateTemplate={flow.startScriptTemplate} templateResult={flow.scriptResult} onTemplateResultHandled={flow.clearScriptResult}
    />
  );
}
