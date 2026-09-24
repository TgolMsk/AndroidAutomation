import { useSelection } from '../../state/selection';
import { InsightsPanel } from '../automation/InsightsPanel';
import type { ViewProps } from '../types';

/** 数据统计: daily Beijing-date buckets, alerts and notification settings. */
export function StatsView(_props: ViewProps) {
  const { game, index } = useSelection();
  if (!game) return null;
  return <InsightsPanel gameId={game.id} index={index} />;
}
