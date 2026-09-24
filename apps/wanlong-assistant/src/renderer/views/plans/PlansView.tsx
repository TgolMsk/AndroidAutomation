import { useNavigation } from '../../state/navigation';
import { usePlanRuns } from '../../state/plan-runs';
import { useSelection } from '../../state/selection';
import { PlanPanel } from '../automation/PlanPanel';
import type { ViewProps } from '../types';

/**
 * 任务计划: per-account tasks with Beijing-time triggers, the plan switch and recent plan runs. Kept alive by the
 * shell so an unsaved plan or 调度设置 draft survives a visit to another page (e.g. 「添加任务」 → 脚本).
 */
export function PlansView({ visible }: ViewProps) {
  const { game, index } = useSelection();
  const { navigate } = useNavigation();
  const { refreshPlanRuns } = usePlanRuns();
  if (!game) return null;
  return (
    <PlanPanel
      key={game.id} gameId={game.id} index={index} visible={visible} mode="plans"
      onOpenScripts={() => navigate('scripts')} onChanged={() => void refreshPlanRuns()}
    />
  );
}
