import { useActivity } from '../../state/activity';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import { TemplatePanel } from '../automation/TemplatePanel';
import type { ViewProps } from '../types';

/** 模板库: template sets of the selected instance, captures, crops and match tests. */
export function TemplatesView(_props: ViewProps) {
  const { game, index } = useSelection();
  const { refreshSchedules } = useActivity();
  const flow = useTemplateFlow();
  if (!game) return null;
  // Template edits switch the instance's auto-resume off in the main process; refresh what the shell shows.
  return (
    <TemplatePanel
      gameId={game.id} index={index} proposal={flow.proposal}
      onChanged={() => void refreshSchedules()}
      scriptInsert={flow.scriptInsert} onScriptTemplateSaved={flow.finishScriptTemplate} onCancelScriptInsert={flow.cancelScriptTemplate}
    />
  );
}
