/**
 * 「版本与更新」 settings card (ported from wanlong-panel `features/update/UpdateCard.tsx`), mounted as the `update`
 * entry of `cards.ts`. Only a frame: the state lives in `views/update/update-store.ts` and the body is the shared
 * `UpdatePanel` (the sidebar popover shows the same body in compact form). The long explanations stay here; the
 * popover is too narrow for them. The update feed is ref-counted and the sidebar entry keeps it open anyway, so the
 * card does not pause it while the settings page is hidden.
 */
import { Card } from '../../components/Card';
import { CheckUpdateButton, UpdatePanel, UpdatePhaseTag } from '../update/UpdatePanel';
import { useUpdateFeed, useUpdateStore } from '../update/update-store';

export function UpdateCard() {
  useUpdateFeed();
  const { state } = useUpdateStore();
  return (
    <Card title={<>版本与更新{state && <UpdatePhaseTag state={state} />}</>} icon="download" extra={<CheckUpdateButton />}>
      <UpdatePanel />
    </Card>
  );
}
