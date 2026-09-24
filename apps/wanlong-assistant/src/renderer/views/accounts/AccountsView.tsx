import { useSelection } from '../../state/selection';
import { AccountPanel } from '../automation/AccountPanel';
import type { ViewProps } from '../types';

/** 账号管理: accounts, instance binding and the guided login for the selected instance. */
export function AccountsView(_props: ViewProps) {
  const { game, index, selectedInstance } = useSelection();
  if (!game) return null;
  return <AccountPanel gameId={game.id} index={index} instance={selectedInstance} />;
}
