import { useState } from 'react';
import type { GameAccount } from '../../../main/automation/accounts/types';
import { legacyPlanChoices } from '../../../main/plans/legacy';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { usePlanImport } from '../../state/plan-import';
import { legacyPlanForAccount, withLegacyPlanFile } from '../automation/plan-legacy-import';
import { mergeImportedPlan } from './plans-model';

/**
 * Explicit import of a wanlong-panel `plans.json` onto one account (the scripts come first, on the 脚本 page; the
 * shared session remembers where each was saved). Imported tasks are appended and sanitized like the original
 * loader (a broken daily trigger becomes 「仅手动」, limits are clamped); a new plan starts disabled.
 */
export function LegacyPlanImport({ gameId, accounts, onImported }: { gameId: string; accounts: GameAccount[]; onImported(): void }) {
  const toast = useToast();
  const { legacy, updateLegacy } = usePlanImport();
  const [target, setTarget] = useState('');
  const [withConfig, setWithConfig] = useState(true);
  const [busy, setBusy] = useState(false);
  const choices = legacy.planFile ? safeChoices(legacy.planFile) : [];
  const targetId = target && accounts.some((account) => account.id === target) ? target : accounts[0]?.id ?? '';

  const load = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      legacyPlanChoices(data); // Throws on a file that is not a legacy plans.json, before anything changes.
      updateLegacy((current) => withLegacyPlanFile(current, data));
    } catch (cause) { toast.error('无法读取旧计划', errMsg(cause)); }
  };

  const importPlan = async (): Promise<void> => {
    if (!targetId || busy) return;
    setBusy(true);
    try {
      // Read the library afresh: the scripts may have just been imported on the 脚本 page.
      const available = (await avdm.scriptList(gameId)).map((item) => item.id);
      const imported = legacyPlanForAccount(legacy, targetId, available);
      const current = await avdm.planGet(gameId, targetId);
      const merged = mergeImportedPlan(current, imported.plan);
      await avdm.planSave(gameId, merged.plan);
      if (withConfig) {
        // The total switch is never touched by an import: only the timing knobs of the old file.
        const { enabled: _ignored, ...knobs } = imported.config;
        if (Object.keys(knobs).length) await avdm.planSaveConfig(gameId, knobs);
      }
      const message = `已导入 ${merged.added} 条任务到「${accounts.find((a) => a.id === targetId)?.name ?? '账号'}」。${imported.warnings.join(' ')}`;
      updateLegacy((current) => ({ ...current, message }));
      toast.push({ kind: 'success', title: '旧计划已导入', detail: current.enabled
        ? '账号计划已经打开，导入的任务一律先不勾选，核对后再逐条启用。'
        : '账号计划开关保持关闭，核对后再打开。' });
      onImported();
    } catch (cause) { toast.error('导入旧计划失败', errMsg(cause)); }
    finally { setBusy(false); }
  };

  return (
    <details className="plans-legacy">
      <summary><Icon name="download" size={14} /> 导入旧版计划（万龙面板的 plans.json）</summary>
      <div className="plans-legacy-body">
        <p className="plans-hint">先在「脚本」页导入旧脚本，再在这里选择旧 plans.json、旧账号和要导入到的账号。导入只增不改，旧的运行次数不导入。</p>
        <div className="plans-legacy-row">
          <label className="btn sm">选择 plans.json
            <input type="file" accept=".json,application/json" hidden onChange={(e) => { void load(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
          </label>
          {choices.length > 0 && <>
            <label className="plans-inline">旧账号
              <select value={legacy.planAccountId} onChange={(e) => { const planAccountId = e.target.value; updateLegacy((current) => ({ ...current, planAccountId })); }}>
                {choices.map((choice) => <option key={choice.accountId} value={choice.accountId}>{choice.accountId} · {choice.tasks} 项</option>)}
              </select>
            </label>
            <label className="plans-inline">导入到
              <select value={targetId} onChange={(e) => setTarget(e.target.value)}>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label className="plans-inline"><input type="checkbox" checked={withConfig} onChange={(e) => setWithConfig(e.target.checked)} />同时导入旧计划设置</label>
            <button type="button" className="btn sm primary" disabled={!targetId || busy} onClick={() => void importPlan()}>
              {busy && <Spinner size={12} />}导入
            </button>
          </>}
        </div>
        {!accounts.length && legacy.planFile !== null && <p className="plans-inline-error">还没有账号：先在「账号管理」新建账号，再导入。</p>}
        {legacy.message && <p className="plans-hint" role="status">{legacy.message}</p>}
      </div>
    </details>
  );
}

function safeChoices(file: unknown): Array<{ accountId: string; tasks: number }> {
  try { return legacyPlanChoices(file); } catch { return []; }
}
