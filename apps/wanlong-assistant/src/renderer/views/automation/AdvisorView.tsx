import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdvisorConfigPatch, AdvisorConfigView, AdvisorRecord, AdvisorStatus, AdvisorTemplateProposal, AdvisorTestResult } from '../../../main/automation/advisor/types';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import './AdvisorView.css';

const ACTION_LABEL = {
  tap_close: '建议关闭', tap_cancel: '建议取消', tap_confirm: '建议确认', back: '建议返回', none: '无需操作',
} as const;
const OUTCOME_LABEL: Record<AdvisorRecord['outcome'], string> = {
  skipped: '未问询', failed: '请求失败', unparsable: '无法解析', advised: '等待人工核对',
  blocked: '风险已拦截', no_action: '无需操作', test_passed: '测试通过',
};
const RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险', unknown: '风险不明' } as const;
const SCREEN_LABEL = {
  gameplay: '游戏画面', popup: '覆盖弹窗', dialog: '对话框', login: '登录界面', network: '网络提示',
  maintenance: '维护公告', update: '更新', loading: '加载中', other: '其它界面', unknown: '未知界面',
} as const;

function atLabel(at: number): string { return new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

interface Draft {
  baseUrl: string; model: string; apiKey: string; timeoutMs: number;
  maxCallsPerHour: number; cooldownSeconds: number; imageWidth: number; minConfidence: number;
}

function draftOf(config: AdvisorConfigView): Draft {
  return { baseUrl: config.baseUrl, model: config.model, apiKey: '', timeoutMs: config.timeoutMs,
    maxCallsPerHour: config.maxCallsPerHour, cooldownSeconds: config.cooldownSeconds,
    imageWidth: config.imageWidth, minConfidence: config.minConfidence };
}

export interface AdvisorViewProps {
  gameId: string;
  index: number | null;
  gameName: string;
  onOpenTemplateProposal: (proposal: AdvisorTemplateProposal) => void;
}

/** A manual, read-only advisor; the only write is a local settings/history update. */
export function AdvisorView({ gameId, index, gameName, onOpenTemplateProposal }: AdvisorViewProps) {
  const toast = useToast();
  const [config, setConfig] = useState<AdvisorConfigView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<AdvisorStatus | null>(null);
  const [history, setHistory] = useState<AdvisorRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AdvisorTestResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'toggle' | 'test' | 'consult' | 'clear-key' | null>('load');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    try {
      const [nextConfig, nextStatus, nextHistory] = await Promise.all([
        avdm.advisorConfig(), avdm.advisorStatus(), avdm.advisorHistory(50),
      ]);
      setConfig(nextConfig);
      setDraft(draftOf(nextConfig));
      setStatus(nextStatus);
      setHistory(nextHistory);
      setSelectedId((previous) => previous && nextHistory.some((item) => item.id === previous) ? previous : nextHistory[0]?.id ?? null);
      setError(null);
    } catch (cause) { setError(errMsg(cause)); }
    finally { setBusy(null); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => history.find((record) => record.id === selectedId) ?? null, [history, selectedId]);
  const dirty = Boolean(config && draft && (
    draft.baseUrl !== config.baseUrl || draft.model !== config.model || draft.apiKey !== '' ||
    draft.timeoutMs !== config.timeoutMs || draft.maxCallsPerHour !== config.maxCallsPerHour ||
    draft.cooldownSeconds !== config.cooldownSeconds || draft.imageWidth !== config.imageWidth ||
    draft.minConfidence !== config.minConfidence
  ));

  async function refreshActivity(): Promise<void> {
    const [nextStatus, nextHistory] = await Promise.all([avdm.advisorStatus(), avdm.advisorHistory(50)]);
    setStatus(nextStatus); setHistory(nextHistory);
  }

  async function save(): Promise<void> {
    if (!draft || busy) return;
    setBusy('save');
    try {
      const patch: AdvisorConfigPatch = {
        baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), timeoutMs: draft.timeoutMs,
        maxCallsPerHour: draft.maxCallsPerHour, cooldownSeconds: draft.cooldownSeconds,
        imageWidth: draft.imageWidth, minConfidence: draft.minConfidence,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      };
      const next = await avdm.saveAdvisorConfig(patch);
      setConfig(next); setDraft(draftOf(next)); setStatus(await avdm.advisorStatus());
      toast.push({ kind: 'success', title: 'AI 接口配置已保存' });
    } catch (cause) { toast.error('无法保存 AI 接口配置', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function clearKey(): Promise<void> {
    if (busy || dirty || !config?.apiKeySet) return;
    setBusy('clear-key');
    try {
      const next = await avdm.saveAdvisorConfig({ enabled: false, apiKey: '' });
      setConfig(next); setDraft(draftOf(next)); setStatus(await avdm.advisorStatus());
      toast.push({ kind: 'success', title: 'API Key 已清除，顾问已关闭' });
    } catch (cause) { toast.error('无法清除 API Key', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function toggle(): Promise<void> {
    if (busy || !config) return;
    setBusy('toggle');
    try {
      const next = await avdm.saveAdvisorConfig({ enabled: !config.enabled });
      setConfig(next); setStatus(await avdm.advisorStatus());
      toast.push({ kind: 'success', title: next.enabled ? 'AI 顾问已启用' : 'AI 顾问已关闭' });
    } catch (cause) { toast.error('无法更改 AI 顾问状态', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function test(): Promise<void> {
    if (busy || dirty) return;
    setBusy('test'); setTestResult(null);
    try {
      const result = await avdm.testAdvisor();
      setTestResult(result); await refreshActivity();
      toast.push({ kind: result.ok ? 'success' : 'warn', title: result.ok ? '视觉接口测试通过' : '视觉接口测试未通过', detail: result.message });
    } catch (cause) { toast.error('无法测试视觉接口', errMsg(cause)); }
    finally { setBusy(null); }
  }

  async function consult(): Promise<void> {
    if (busy || index === null || !gameId) return;
    setBusy('consult');
    try {
      const record = await avdm.consultAdvisor(gameId, index);
      await refreshActivity(); setSelectedId(record.id);
      toast.push({ kind: record.outcome === 'advised' ? 'info' : record.outcome === 'blocked' ? 'warn' : 'info',
        title: record.outcome === 'advised' ? '已生成只读建议' : OUTCOME_LABEL[record.outcome], detail: record.message });
    } catch (cause) { toast.error('无法分析当前画面', errMsg(cause)); }
    finally { setBusy(null); }
  }

  return (
    <section className="advisor-view" aria-labelledby="advisor-heading">
      <header className="advisor-hero">
        <div className="advisor-hero-symbol"><Icon name="chip" size={22} /></div>
        <div className="advisor-hero-copy"><h2 id="advisor-heading">AI 顾问</h2><p>读取当前游戏画面，给出结构化建议与风险判断。所有点击和模板保存都由你决定。</p></div>
        <button className="btn" type="button" onClick={() => void load()} disabled={busy !== null} aria-label="刷新 AI 顾问状态"><Icon name="refresh" />刷新</button>
      </header>

      {error && <div className="advisor-error" role="alert"><Icon name="alert" />{error}<button className="btn xs" type="button" onClick={() => void load()}>重试</button></div>}
      {busy === 'load' && !config && <div className="advisor-loading" aria-label="正在加载 AI 顾问" />}
      {config && <>
        <div className="advisor-status-bar">
          <div><span className={`advisor-indicator ${config.enabled ? 'is-on' : ''}`} /><strong>{config.enabled ? '已启用' : '默认关闭'}</strong><span>{status?.configured ? `${status.model} · 最近一小时 ${status.callsLastHour}/${status.maxCallsPerHour} 次` : '先完成接口配置与视觉测试'}</span></div>
          <button className="btn" type="button" onClick={() => setSettingsOpen((value) => !value)} aria-expanded={settingsOpen}><Icon name="settings" />接口与限额</button>
          <button className={`btn ${config.enabled ? '' : 'primary'}`} type="button" onClick={() => void toggle()} disabled={busy !== null || (!status?.configured && !config.enabled)}>{busy === 'toggle' ? <Spinner size={14} /> : <Icon name={config.enabled ? 'stop' : 'play'} />}{config.enabled ? '关闭顾问' : '启用顾问'}</button>
        </div>

        {settingsOpen && draft && <section className="advisor-settings" aria-label="AI 接口配置">
          <div className="advisor-section-head"><h3>接口配置</h3><p>支持 OpenAI 兼容视觉接口。截图只会发送到你填入的地址；Key 仅保存在本机私有配置中。</p></div>
          <div className="advisor-fields">
            <label><span>接口根地址</span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://provider.example/v1" spellCheck={false} /></label>
            <label><span>视觉模型</span><input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="支持图片输入的模型 ID" spellCheck={false} /></label>
            <label><span>API Key</span><input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={config.apiKeySet ? `已设置 ${config.apiKeyMasked} · 留空保持` : '输入服务商的 API Key'} /></label>
            <label><span>请求超时 · 秒</span><input type="number" min={5} max={180} value={draft.timeoutMs / 1000} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) * 1000 })} /></label>
            <label><span>每小时最多请求</span><input type="number" min={1} max={500} value={draft.maxCallsPerHour} onChange={(event) => setDraft({ ...draft, maxCallsPerHour: Number(event.target.value) })} /></label>
            <label><span>同实例冷却 · 秒</span><input type="number" min={0} max={3600} value={draft.cooldownSeconds} onChange={(event) => setDraft({ ...draft, cooldownSeconds: Number(event.target.value) })} /></label>
            <label><span>图片最大宽度 · px</span><input type="number" min={640} max={2560} value={draft.imageWidth} onChange={(event) => setDraft({ ...draft, imageWidth: Number(event.target.value) })} /></label>
            <label><span>最低置信度</span><input type="number" min={0} max={1} step={.05} value={draft.minConfidence} onChange={(event) => setDraft({ ...draft, minConfidence: Number(event.target.value) })} /></label>
          </div>
          <div className="advisor-settings-actions">
            <span>{dirty ? '配置尚未保存；测试将使用已保存的配置。' : config.apiKeySet ? 'API Key 已保存在本机；界面只显示末四位。' : '尚未设置 API Key。'}</span>
            {config.apiKeySet && <button className="btn" type="button" onClick={() => void clearKey()} disabled={busy !== null || dirty}>清除 Key</button>}
            <button className="btn" type="button" onClick={() => void test()} disabled={busy !== null || dirty || !status?.configured}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="search" />}测试视觉能力</button>
            <button className="btn primary" type="button" onClick={() => void save()} disabled={busy !== null || !dirty}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" />}保存配置</button>
          </div>
          {testResult && <p className={`advisor-test-result ${testResult.ok ? 'is-ok' : 'is-failed'}`} role="status">{testResult.message}</p>}
        </section>}

        <section className="advisor-consult" aria-label="只读画面分析">
          <div><h3>分析当前画面</h3><p>{index === null ? '先在自动化工作台选择一个实例。' : `目标：${gameName} · 实例 #${index}。顾问会在发送前核对前台应用。`}</p></div>
          <button className="btn primary" type="button" onClick={() => void consult()} disabled={busy !== null || !config.enabled || !status?.configured || index === null || !gameId}>{busy === 'consult' ? <Spinner size={14} /> : <Icon name="search" />}只读分析</button>
        </section>

        <div className="advisor-history-layout">
          <section className="advisor-history" aria-labelledby="advisor-history-title">
            <div className="advisor-section-head"><h3 id="advisor-history-title">分析记录</h3><p>最近 {history.length} 条 · 不保存游戏截图</p></div>
            {history.length === 0 ? <p className="advisor-empty">还没有分析记录。完成接口配置后，可对选中的实例进行一次只读分析。</p> :
              <div className="advisor-history-list">{history.map((record) => <button key={record.id} type="button" className={`advisor-history-item ${record.id === selectedId ? 'is-selected' : ''}`} onClick={() => setSelectedId(record.id)} aria-current={record.id === selectedId ? 'true' : undefined}>
                <span className={`advisor-outcome is-${record.outcome}`}>{OUTCOME_LABEL[record.outcome]}</span>
                <strong>{record.context === 'vision-test' ? '视觉能力测试' : `${record.gameId} · #${record.index}`}</strong>
                <small>{atLabel(record.at)} · {record.latencyMs > 0 ? `${(record.latencyMs / 1000).toFixed(1)} 秒` : '本地拦截'}</small>
              </button>)}</div>}
          </section>
          <section className="advisor-detail" aria-label="分析详情">
            {!selected ? <div className="advisor-empty">选择一条记录查看模型建议和本地风险判断。</div> : <>
              <div className="advisor-detail-head"><span className={`advisor-outcome is-${selected.outcome}`}>{OUTCOME_LABEL[selected.outcome]}</span><span>{atLabel(selected.at)}</span></div>
              <h3>{selected.advice ? ACTION_LABEL[selected.advice.action] : '分析结果'}</h3>
              <p className="advisor-detail-message">{selected.message}</p>
              {selected.advice && <>
                <dl className="advisor-facts"><div><dt>界面</dt><dd>{SCREEN_LABEL[selected.advice.screen]}</dd></div><div><dt>置信度</dt><dd>{Math.round(selected.advice.confidence * 100)}%</dd></div><div><dt>风险</dt><dd className={`risk-${selected.advice.risk.level}`}>{RISK_LABEL[selected.advice.risk.level]}</dd></div><div><dt>模型</dt><dd>{selected.advice.model}</dd></div></dl>
                <div className="advisor-risk-note"><strong>{selected.advice.reviewReason}</strong><span>{selected.advice.risk.consequence || selected.advice.risk.reason}</span>{selected.advice.risk.hazards.length > 0 && <span>潜在后果：{selected.advice.risk.hazards.join('；')}</span>}</div>
                {selected.advice.target && <p className="advisor-target mono">建议范围 x {selected.advice.target.x} · y {selected.advice.target.y} · {selected.advice.target.w}×{selected.advice.target.h} px</p>}
              </>}
              {selected.templateProposal && <div className="advisor-template-action"><div><strong>关闭按钮模板候选</strong><p>打开编辑器后，重新截屏并核对裁剪范围；保存前不会写入模板库。</p></div><button className="btn" type="button" onClick={() => onOpenTemplateProposal(selected.templateProposal!)}><Icon name="edit" />送入模板编辑器</button></div>}
            </>}
          </section>
        </div>
      </>}
    </section>
  );
}
