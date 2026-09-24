/**
 * 「AI 处理」 (original features/ai/AiView + AiSettingsCard), top to bottom:
 *   1. The master switch: saved the moment it is clicked (the form below never carries `enabled`, so saving the form
 *      cannot silently flip it back). Next to it「接口配置」with a badge: red = not complete, amber = off.
 *   2. The interface configuration, folded by default: presets, restore defaults, test (kind + the model's own reply),
 *      clear key (confirmed), execution and limits (自动处理 / 局部放大精定位 / 自学模板), and the risk policy.
 *   3. Manual read-only analysis of the current screen (this repository's addition, template candidates).
 *   4. The records table (Beijing time, source, outcome, judgement, risk, time, new template, message), 20 per page.
 * Pushes (`ai-consulted` / `ai-config-changed`) are subscribed here, so they keep arriving with the form folded.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AI_OUTCOME_LABEL, AI_OUTCOME_TONE, AI_PRESETS, aiContextLabel,
  type AdvisorConfigView, type AdvisorRecord, type AdvisorStatus, type AdvisorTestResult,
} from '../../../shared/ai';
import { avdm, errMsg } from '../../api';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { SemanticTag } from '../../components/SemanticTag';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { beijingTime } from '../../format';
import { useAvdmEvent } from '../../hooks/useAvdmEvent';
import { useSelection } from '../../state/selection';
import { useTemplateFlow } from '../../state/template-flow';
import type { ViewProps } from '../types';
import {
  AI_FORM_RANGE, AI_PAGE_SIZE, adviceSummary, applyPreset, configBadge, defaultDraft, draftDirty, draftFromView, draftProblems,
  latencyLabel, mergeRecord, pageCount, pageOf, patchFromDraft, presetLabel, riskPolicyText, riskSummary, statusLine, testTitle,
  type AiDraft,
} from './ai-view-model';
import './AiView.css';

type Busy = 'load' | 'toggle' | 'save' | 'test' | 'clear-key' | 'consult' | null;
type Confirm = 'clear-key' | 'auto-actions' | null;

function Switch({ checked, label, disabled, busy, onChange }: {
  checked: boolean; label: string; disabled?: boolean; busy?: boolean; onChange: (next: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ai-switch"
      disabled={disabled} onClick={() => onChange(!checked)}>
      {busy ? <Spinner size={12} /> : <span />}
    </button>
  );
}

function NumberField({ label, hint, value, range, step, onChange }: {
  label: string; hint?: string; value: number; range: readonly [number, number]; step?: number; onChange: (value: number) => void;
}) {
  return (
    <label className="ai-field">
      <span>{label}</span>
      <input type="number" min={range[0]} max={range[1]} step={step ?? 1} value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function AiView(_props: ViewProps) {
  const toast = useToast();
  const { game, index } = useSelection();
  const { openTemplateProposal } = useTemplateFlow();
  const [config, setConfig] = useState<AdvisorConfigView | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [history, setHistory] = useState<AdvisorRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>('load');
  const [configOpen, setConfigOpen] = useState(false);
  const [testResult, setTestResult] = useState<AdvisorTestResult | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preset, setPreset] = useState('');

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const [nextConfig, nextStatus, nextHistory] = await Promise.all([avdm.advisorConfig(), avdm.advisorStatus(), avdm.advisorHistory(50)]);
      setConfig(nextConfig);
      setDraft(draftFromView(nextConfig));
      setStatus(nextStatus);
      setHistory(nextHistory);
      setError(null);
    } catch (cause) { setError(errMsg(cause)); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await avdm.advisorStatus()); } catch { /* the next push or refresh retries */ }
  }, []);

  useAvdmEvent('ai-consulted', (record) => {
    setHistory((items) => mergeRecord(items, record));
    void refreshStatus();
  });
  const latest = useRef({ config, draft });
  latest.current = { config, draft };
  useAvdmEvent('ai-config-changed', (view) => {
    // A draft being edited stays; an untouched form follows the saved config.
    const { config: previous, draft: current } = latest.current;
    if (!current || !previous || !draftDirty(current, previous)) setDraft(draftFromView(view));
    setConfig(view);
    void refreshStatus();
  });

  const dirty = Boolean(config && draft && draftDirty(draft, config));
  const problems = draft ? draftProblems(draft) : [];
  const badge = configBadge(status, config);
  const pages = pageCount(history.length);
  const visibleRecords = useMemo(() => pageOf(history, page), [history, page]);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);

  async function run(label: Busy, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(label);
    try { await work(); } finally { setBusy(null); }
  }

  const toggleEnabled = (next: boolean) => void run('toggle', async () => {
    try {
      const view = await avdm.saveAdvisorConfig({ enabled: next });
      setConfig(view);
      await refreshStatus();
      toast.push({ kind: 'success', title: next ? 'AI 顾问已启用' : 'AI 顾问已关闭', detail: next ? undefined : '认不出界面时照旧只走 BACK 兜底。' });
    } catch (cause) { toast.error(`${next ? '启用' : '关闭'} AI 顾问失败`, errMsg(cause)); }
  });

  /** Save the form; returns false when it could not be saved. */
  async function saveDraft(): Promise<boolean> {
    if (!draft) return false;
    if (problems.length) {
      toast.push({ kind: 'warn', title: '表单里还有没填对的项', detail: problems.join('；') });
      return false;
    }
    try {
      const view = await avdm.saveAdvisorConfig(patchFromDraft(draft));
      setConfig(view);
      setDraft(draftFromView(view));
      setPreset('');
      await refreshStatus();
      toast.push({ kind: 'success', title: 'AI 顾问设置已保存' });
      return true;
    } catch (cause) {
      toast.error('AI 顾问设置保存失败', errMsg(cause));
      return false;
    }
  }

  const save = () => void run('save', async () => { await saveDraft(); });

  // The test uses the saved config: unsaved edits are saved first (original AiSettingsCard).
  const test = () => void run('test', async () => {
    if (dirty && !(await saveDraft())) return;
    setTestResult(null);
    try {
      const result = await avdm.testAdvisor();
      setTestResult(result);
      await refreshStatus();
      if (result.ok) toast.push({ kind: 'success', title: '模型能看图，可以启用 AI 顾问。' });
      else toast.push({ kind: 'error', title: '测试未通过', detail: result.message });
    } catch (cause) { toast.error('无法测试视觉接口', errMsg(cause)); }
  });

  const clearKey = async (): Promise<void> => {
    setBusy('clear-key');
    try {
      const view = await avdm.saveAdvisorConfig({ enabled: false, apiKey: '' });
      setConfig(view);
      setDraft((current) => (current ? { ...current, apiKey: '' } : draftFromView(view)));
      await refreshStatus();
      toast.push({ kind: 'success', title: '已清除保存的 API Key', detail: 'AI 顾问已同时关闭。' });
    } catch (cause) {
      toast.error('清除 Key 失败', errMsg(cause));
      throw cause;
    } finally { setBusy(null); }
  };

  const consult = () => void run('consult', async () => {
    if (!game || index === null) return;
    try {
      const record = await avdm.consultAdvisor(game.id, index);
      setHistory((items) => mergeRecord(items, record));
      setSelectedId(record.id);
      setPage(0);
      await refreshStatus();
      toast.push({ kind: record.outcome === 'blocked' ? 'warn' : 'info', title: AI_OUTCOME_LABEL[record.outcome], detail: record.message });
    } catch (cause) { toast.error('无法分析当前画面', errMsg(cause)); }
  });

  const setField = <K extends keyof AiDraft>(key: K, value: AiDraft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));
  const configured = status?.configured ?? false;
  const enabled = config?.enabled ?? false;

  return (
    <section className="ai-view" aria-label="AI 处理">
      {error && <div className="ai-error" role="alert"><Icon name="alert" />AI 顾问设置没能读到：{error}<button className="btn xs" type="button" onClick={() => void load()}>重试</button></div>}
      {busy === 'load' && !config && <div className="ai-loading" aria-label="正在加载 AI 顾问" />}

      {config && <>
        <Card
          padding="sm"
          title={<span className="ai-master">
            <span>AI 顾问总开关</span>
            <Switch checked={enabled} label="AI 顾问总开关" busy={busy === 'toggle'} disabled={busy !== null || (!configured && !enabled)} onChange={toggleEnabled} />
            <span className={`ai-master-state ${enabled ? 'is-on' : ''}`}>{enabled ? '已启用' : '已关闭'}</span>
          </span>}
          icon="chip"
          extra={<>
            <button type="button" className="btn sm" onClick={() => void load()} disabled={busy !== null} aria-label="刷新 AI 顾问状态"><Icon name="refresh" size={14} />刷新</button>
            <button type="button" className="btn sm ai-config-toggle" onClick={() => setConfigOpen((open) => !open)} aria-expanded={configOpen} title={badge.text}>
              <Icon name="settings" size={14} />接口配置
              {badge.tone && <span className={`ai-badge is-${badge.tone}`} aria-label={badge.text} />}
            </button>
          </>}
        >
          <p className="ai-status-line" aria-live="polite">
            {statusLine(status)}
            {!configured && ' · 先点右边「接口配置」把地址、Key、模型名填好才能启用。'}
          </p>
          <p className="ai-muted">只有采集 / 采样 / 脚本认不出界面时才会问；
            {config.autoActions ? '「自动处理」已开启：低风险的关闭、取消与经过复核的确认会真的去点，点完必须复验。' : '「自动处理」未开启：只记录建议，不会点击设备。'}
          </p>
          {status?.loadWarning && <p className="notice warn" role="status">{status.loadWarning}</p>}
        </Card>

        {configOpen && draft && <Card title="接口配置" icon="settings" extra={<>
          <button type="button" className="btn sm" disabled={busy !== null} onClick={() => {
            setDraft((current) => ({ ...defaultDraft(), apiKey: current?.apiKey ?? '' }));
            toast.push({ kind: 'info', title: '已填入默认值', detail: '记得点「保存」才会生效（Key 保持不变）。' });
          }}>恢复默认值</button>
          <button type="button" className="btn sm" disabled={busy !== null || problems.length > 0} onClick={test}>
            {busy === 'test' ? <Spinner size={12} /> : <Icon name="search" size={14} />}测试连接与视觉能力
          </button>
          <button type="button" className="btn sm primary" disabled={busy !== null || !dirty} onClick={save}>
            {busy === 'save' ? <Spinner size={12} /> : <Icon name="check" size={14} />}保存
          </button>
        </>}>
          <div className="notice info ai-policy" role="note">
            <strong>{config.autoActions ? '按点击后果评估风险，低风险确认可自动执行，确认前会重新看图复核' : '只看不点：认不出界面时 AI 只给建议'}</strong>
            <span>{riskPolicyText(draft.autoActions, draft.autoHarvest)}</span>
          </div>

          {testResult && <div className={`ai-test ${testResult.ok ? 'is-ok' : 'is-failed'}`} role="status">
            <strong>{testTitle(testResult)}</strong>
            <span>{testResult.message}{testResult.reply ? `（模型原话：${testResult.reply}）` : ''}</span>
            <button type="button" className="icon-btn small" aria-label="关闭测试结果" onClick={() => setTestResult(null)}><Icon name="close" size={14} /></button>
          </div>}

          <div className="ai-form">
            <label className="ai-field is-wide">
              <span>快速填入平台预设</span>
              <select value={preset} onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value !== '') setDraft((current) => (current ? applyPreset(current, Number(event.target.value)) : current));
              }}>
                <option value="">选一个平台…</option>
                {AI_PRESETS.map((item, i) => <option key={item.label} value={i}>{presetLabel(i)}</option>)}
              </select>
              <small>只是把接口地址和一个示例模型名填进下面两个框，模型名以平台最新文档为准。</small>
            </label>
            <label className="ai-field is-wide">
              <span>接口地址（OpenAI 兼容，填到 /v1 这一层）</span>
              <input value={draft.baseUrl} onChange={(event) => setField('baseUrl', event.target.value)} spellCheck={false} autoComplete="off"
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
              <small>助手会自己拼 /chat/completions。只接受 HTTPS；本机模型可以用 http://localhost。</small>
            </label>
            <label className="ai-field is-wide">
              <span>API Key</span>
              <input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setField('apiKey', event.target.value)}
                placeholder={config.apiKeySet ? `已配置 ${config.apiKeyMasked}（留空表示不修改）` : '例如 sk-…（在模型平台的「API Key 管理」里创建）'} />
              <small>等同于密码：只存本机配置文件（仅本人可读），界面上永远只显示后 4 位，不写进日志或错误信息。</small>
            </label>
            <div className="ai-key-row">
              <span className="ai-muted">当前：{config.apiKeySet ? `已配置 ${config.apiKeyMasked}` : '未配置'}</span>
              <button type="button" className="btn xs danger-ghost" disabled={!config.apiKeySet || busy !== null} onClick={() => setConfirm('clear-key')}>清除 Key</button>
            </div>
            <label className="ai-field is-wide">
              <span>模型名</span>
              <input value={draft.model} onChange={(event) => setField('model', event.target.value)} spellCheck={false} autoComplete="off" placeholder="qwen3.8-flash" />
              <small>必须是支持图片输入的模型（名字里通常带 vl / vision / v，百炼的 qwen3.8-flash 也支持）。填完点「测试连接与视觉能力」。</small>
            </label>

            <h3 className="ai-form-divider">执行与限额</h3>
            <NumberField label="每小时最多问几次" hint="所有实例合计；0 = 不限。识别出错反复认不出界面时它是防止烧钱的熔断。"
              value={draft.maxCallsPerHour} range={AI_FORM_RANGE.maxCallsPerHour} onChange={(v) => setField('maxCallsPerHour', v)} />
            <NumberField label="同一实例冷却（秒）" hint="点击前的复核不受冷却限制，但照样计入次数。"
              value={draft.cooldownSeconds} range={AI_FORM_RANGE.cooldownSeconds} onChange={(v) => setField('cooldownSeconds', v)} />
            <NumberField label="请求超时（秒）" value={draft.timeoutSeconds} range={AI_FORM_RANGE.timeoutSeconds} onChange={(v) => setField('timeoutSeconds', v)} />
            <NumberField label="发送截图宽度（px）" hint="越大越准也越贵，1280 够看清按钮。" step={64}
              value={draft.imageWidth} range={AI_FORM_RANGE.imageWidth} onChange={(v) => setField('imageWidth', v)} />
            <NumberField label="最低置信度" hint="模型自报置信度低于它的建议不执行（确认动作至少 0.85）。" step={0.05}
              value={draft.minConfidence} range={AI_FORM_RANGE.minConfidence} onChange={(v) => setField('minConfidence', v)} />
            <div className="ai-toggles">
              <div className="ai-toggle">
                <Switch checked={draft.autoActions} label="自动处理" onChange={(next) => (next ? setConfirm('auto-actions') : setField('autoActions', false))} />
                <div><strong>自动处理</strong><small>开启后会按风险评估真的点击设备（关闭 / 取消 / 复核过的确认）。默认关闭。</small></div>
              </div>
              <div className="ai-toggle">
                <Switch checked={draft.refine} label="局部放大精定位" onChange={(next) => setField('refine', next)} />
                <div><strong>局部放大精定位</strong><small>关闭 / 取消建议多问一次，点得更准、裁的模板更贴合；「自动处理」关着时自动链路不多问（只记录建议），手动分析照常精定位。</small></div>
              </div>
              <div className="ai-toggle">
                <Switch checked={draft.autoHarvest} label="自学模板" onChange={(next) => setField('autoHarvest', next)} />
                <div><strong>自学模板</strong><small>点掉弹窗并回到已知界面后，把关闭按钮存进模板库；只在「自动处理」开启时生效。关掉后只点不学。</small></div>
              </div>
            </div>
          </div>
          <p className="ai-form-foot">
            {problems.length > 0 ? <span className="ai-problems">{problems.join('；')}</span>
              : dirty ? '有未保存的修改；测试会先保存。' : '配置已保存。'}
          </p>
        </Card>}

        <Card title="分析当前画面" icon="search" padding="sm" extra={
          <button type="button" className="btn sm primary" onClick={consult}
            disabled={busy !== null || !enabled || !configured || !game || index === null}>
            {busy === 'consult' ? <Spinner size={12} /> : <Icon name="search" size={14} />}只读分析
          </button>
        }>
          <p className="ai-muted">{!game || index === null ? '先在顶部选择一个实例。' : !enabled
            ? '启用 AI 顾问后，可以对当前实例做一次只读分析（不会点击设备）。'
            : `目标：${game.name} · 实例 #${index}。发送前会核对前台应用；安全的关闭建议可以送进模板编辑器，由你重新截图核对后保存。`}</p>
        </Card>

        <Card title="处理记录" icon="log" padding="sm" extra={status && <SemanticTag tone="info">
          最近一小时 {status.callsLastHour} 次 · 累计 {status.consultCount} 次 · 自学模板 {status.harvestedCount} 张
        </SemanticTag>}>
          {history.length === 0 ? <p className="ai-empty">还没有记录。只有在采集 / 采样 / 脚本认不出界面、且 AI 顾问已启用时才会问询。</p> : <>
            <div className="ai-table-wrap">
              <table className="ai-table">
                <thead><tr>
                  <th>时间</th><th>实例</th><th>来源</th><th>结果</th><th>模型判断</th><th>风险评估</th><th>耗时</th><th>新模板</th><th>说明</th>
                </tr></thead>
                <tbody>{visibleRecords.map((record) => {
                  const risk = riskSummary(record.advice);
                  const open = record.id === selectedId;
                  return <Fragment key={record.id}>
                    <tr className={open ? 'is-selected' : ''} tabIndex={0} aria-expanded={open} title="点击查看详情"
                      onClick={() => setSelectedId(open ? null : record.id)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        setSelectedId(open ? null : record.id);
                      }}>
                      <td className="mono">{beijingTime(record.at, 'full')}</td>
                      <td>{record.index === null ? '—' : `#${record.index}`}</td>
                      <td>{aiContextLabel(record.context)}</td>
                      <td><SemanticTag tone={AI_OUTCOME_TONE[record.outcome]}>{AI_OUTCOME_LABEL[record.outcome]}</SemanticTag>{record.requiresAttention && <span className="ai-attention">需要人处理</span>}</td>
                      <td className="ai-cell-wide">{adviceSummary(record.advice)}</td>
                      <td title={risk.detail}>{record.advice ? <><SemanticTag tone={risk.tone}>{risk.label}</SemanticTag> {risk.text}</> : <span className="ai-muted">{risk.text}</span>}</td>
                      <td className="mono">{latencyLabel(record.latencyMs)}</td>
                      <td>{record.harvestedTemplateId ? <code>{record.harvestedTemplateId}</code> : '—'}</td>
                      <td className="ai-cell-message" title={record.message}>{record.message}</td>
                    </tr>
                    {open && <tr className="ai-detail-row"><td colSpan={9}>
                      <div className="ai-detail">
                        <p>{record.message}</p>
                        {record.advice && <dl>
                          <div><dt>本地闸门</dt><dd>{record.advice.reviewReason}</dd></div>
                          <div><dt>按钮原文</dt><dd>{record.advice.risk.buttonText || '—'}</dd></div>
                          <div><dt>依据正文</dt><dd>{record.advice.risk.dialogText || '—'}</dd></div>
                          <div><dt>点击后果</dt><dd>{record.advice.risk.consequence || '—'}</dd></div>
                          <div><dt>风险理由</dt><dd>{record.advice.risk.reason || '—'}</dd></div>
                          {record.advice.risk.hazards.length > 0 && <div><dt>潜在后果</dt><dd>{record.advice.risk.hazards.join('；')}</dd></div>}
                          <div><dt>模型</dt><dd>{record.advice.model || '—'}{record.advice.refined ? ' · 已精修' : ''}{record.advice.riskRechecked ? ' · 点击前已复核' : ''}</dd></div>
                        </dl>}
                        {record.templateProposal && <div className="ai-proposal">
                          <span>关闭按钮模板候选：打开编辑器后重新截屏并核对裁剪范围，保存前不会写入模板库。</span>
                          <button type="button" className="btn sm" onClick={(event) => { event.stopPropagation(); openTemplateProposal(record.templateProposal!); }}>
                            <Icon name="edit" size={14} />送入模板编辑器
                          </button>
                        </div>}
                      </div>
                    </td></tr>}
                  </Fragment>;
                })}</tbody>
              </table>
            </div>
            {pages > 1 && <nav className="ai-pager" aria-label="处理记录分页">
              <button type="button" className="btn xs" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>上一页</button>
              <span>第 {Math.min(page, pages - 1) + 1} / {pages} 页 · 每页 {AI_PAGE_SIZE} 条</span>
              <button type="button" className="btn xs" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>下一页</button>
            </nav>}
          </>}
        </Card>
      </>}

      {confirm === 'clear-key' && <ConfirmDialog
        title="清除已保存的 API Key？"
        message="清掉之后 AI 顾问会立刻停止工作（总开关同时关闭），需要重新填写 Key 才能再用。"
        confirmLabel="清除" danger
        onConfirm={clearKey}
        onClose={() => setConfirm(null)}
      />}
      {confirm === 'auto-actions' && <ConfirmDialog
        title="开启「自动处理」？"
        message={<>
          <p>开启后，采集、采样或脚本认不出界面时，AI 会按风险评估<strong>真的点击设备</strong>：低风险的关闭、取消，以及两次判断一致、置信度至少 85% 的确认。</p>
          <p>购买、消耗资源、删除、账号变更等高风险或风险不明的情况会暂停实例、交给你处理。截图会发送到你填写的 AI 接口。</p>
          <p>保存配置后生效。</p>
        </>}
        confirmLabel="开启"
        onConfirm={() => { setField('autoActions', true); }}
        onClose={() => setConfirm(null)}
      />}
    </section>
  );
}
