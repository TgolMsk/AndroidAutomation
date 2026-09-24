import { useNavigation } from '../../state/navigation';
import { useSelection } from '../../state/selection';
import { PlanPanel } from '../automation/PlanPanel';
import type { ViewProps } from '../types';

/** 任务计划: per-account tasks with Beijing-time triggers, the plan switch and recent plan runs. */
export function PlansView({ visible }: ViewProps) {
  const { game, index } = useSelection();
  const { navigate } = useNavigation();
  if (!game) return null;
  return <PlanPanel key={game.id} gameId={game.id} index={index} visible={visible} mode="plans" onOpenScripts={() => navigate('scripts')} />;
}
