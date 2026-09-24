import { useActivity } from '../../state/activity';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import type { ViewProps } from '../types';
import { TemplateEditor } from './TemplateEditor';

/** 模板库: template sets of the selected instance, captures, crops, 透明底, match tests, quick picks and imports. */
export function TemplatesView(_props: ViewProps) {
  const { game, index } = useSelection();
  const { refreshSchedules } = useActivity();
  const flow = useTemplateFlow();
  if (!game) return null;
  // Template edits switch the instance's auto-resume off in the main process and invalidate the gather probe.
  return (
    <TemplateEditor
      gameId={game.id} index={index} proposal={flow.proposal}
      onChanged={(directory) => { flow.noteTemplateChanged(game.id, index, directory); void refreshSchedules(); }}
      scriptInsert={flow.scriptInsert} onScriptTemplateSaved={flow.finishScriptTemplate} onCancelScriptInsert={flow.cancelScriptTemplate}
    />
  );
}
