import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import { AdvisorView } from '../automation/AdvisorView';
import type { ViewProps } from '../types';

/** AI 处理: advisor configuration, manual consults and history; template proposals open the template library. */
export function AiView(_props: ViewProps) {
  const { game, index } = useSelection();
  const { openTemplateProposal } = useTemplateFlow();
  if (!game) return null;
  return <AdvisorView gameId={game.id} gameName={game.name} index={index} onOpenTemplateProposal={openTemplateProposal} />;
}
