import { useState, type ReactNode } from 'react';
import type { PlanConfig } from '../../../shared/plan';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { CONFIG_BOUNDS, configDraftOf, configPatchOf, type PlanConfigDraft } from './plans-model';

/** 「计划设置」 (original settings modal): preemption grace, catch-up, queue wait, retries, AI assist, script cap. */
export function PlanConfigDialog({ config, busy, onClose, onSave }: {
  config: PlanConfig;
  busy: boolean;
  onClose(): void;
  onSave(patch: Partial<PlanConfig>): void;
}) {
  const [draft, setDraft] = useState<PlanConfigDraft>(() => configDraftOf(config));
  const number = (key: Exclude<keyof PlanConfigDraft, 'aiAssist'>, unit: string, label: string) => {
    const [min, max] = CONFIG_BOUNDS[key];
    return (
      <span className="plans-inline">
        <input type="number" min={min} max={max} step={1} value={draft[key]} disabled={busy} aria-label={label}
          onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value || 0) })} />
        {unit}
      </span>
    );
  };
  return (
    <Modal title="计划设置" onClose={onClose} busy={busy} width={560}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => onSave(configPatchOf(draft))}>{busy && <Spinner size={12} />}保存</button>
      </>}>
      <div className="plans-form">
        <Field label="抢占宽限" hint="到点要跑脚本、而采集调度器正在动这个实例时，先等它自然收尾这么久；还不让开就打断它。0 表示立刻打断。">
          {number('preemptGraceSec', '秒', '抢占宽限（秒）')}
        </Field>
        <Field label="补跑窗口" hint="面板关了一会儿、实例刚开机时，错过的「每天」时刻在这个时长内还补跑一次；超过就直接等下一次。按间隔的任务过期只补一次，不受它影响。">
          {number('catchUpMin', '分钟', '补跑窗口（分钟）')}
        </Field>
        <Field label="排队等待上限" hint="排进队列后一直轮不到（实例忙），等超过这个时长就跳过这一轮，不会越攒越多。">
          {number('queueWaitMin', '分钟', '排队等待上限（分钟）')}
        </Field>
        <Field label="失败重试" hint="脚本执行失败后再试几次，以及两次之间隔多久。重试会先把实例让出来（采集与其它任务可以先用），到点重新排队，从脚本第一步重新执行；涉及提交、购买等动作的脚本建议设为 0 次。被时间上限停掉、被安全检查拦下或需要人处理的不会重试。">
          <span className="plans-inline-group">
            {number('retry', '次', '失败重试次数')}
            {number('retryDelaySec', '秒后', '重试间隔（秒）')}
          </span>
        </Field>
        <Field label="同时运行脚本上限" hint="所有实例合计同时跑几个脚本（采集不算）。撞上上限的计划任务会稍后自动重试，不算失败。不建议超过 4 个。">
          {number('maxConcurrentScripts', '个', '同时运行脚本上限')}
        </Field>
        <Field label="脚本执行期间允许 AI 介入" hint="某一步重试耗尽时，先让视觉大模型看一眼当前画面（多半是活动弹窗挡路），它关掉了就重试这一步。需要「AI 处理」页里已经配好接口并允许 AI 自动处理。">
          <label className="plans-inline">
            <input type="checkbox" checked={draft.aiAssist} disabled={busy} onChange={(e) => setDraft({ ...draft, aiAssist: e.target.checked })} />
            允许
          </label>
        </Field>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="plans-field">
      <span className="plans-field-label">{label}</span>
      {children}
      <span className="plans-hint">{hint}</span>
    </div>
  );
}
