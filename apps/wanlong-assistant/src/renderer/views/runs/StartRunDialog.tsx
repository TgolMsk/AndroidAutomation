import { useEffect, useMemo, useState } from 'react';
import type { InstanceState } from '@avdm/core';
import type { ScriptParamDef, ScriptParamValue } from '@avdm/automation/script';
import type { GameAccount } from '../../../main/automation/accounts/types';
import type { ImeStatus, ScriptDef, ScriptMeta, ScriptRunSnapshot, ShotPolicy } from '../../../main/plans/types';
import { avdm, errMsg } from '../../api';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { isRunning } from '../../format';
import { coerceParam, defaultParams, instanceBlockReason, SHOT_POLICY_OPTIONS } from './run-rows';

export interface StartRunDialogProps {
  gameId: string;
  instances: InstanceState[];
  /** Instance index → name of the script occupying it. */
  busy: ReadonlyMap<number, string>;
  initialIndex: number | null;
  onStarted: (snapshot: ScriptRunSnapshot) => void;
  onClose: () => void;
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

function usesUnicodeText(script: ScriptDef | null): boolean {
  if (!script) return false;
  const walk = (steps: ScriptDef['steps']): boolean => steps.some((step) =>
    (step.kind === 'text' && NON_ASCII.test(step.text)) ||
    (step.kind === 'if' && (walk(step.then) || walk(step.else ?? []))) ||
    (step.kind === 'loop' && walk(step.steps)));
  return walk(script.steps);
}

function ParamField({ param, value, onChange }: { param: ScriptParamDef; value: ScriptParamValue | undefined; onChange: (value: ScriptParamValue | undefined) => void }) {
  const id = `runs-param-${param.key}`;
  if (param.type === 'boolean') {
    return (
      <label className="check runs-param-check"><input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />{param.label}</label>
    );
  }
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{param.label}</span>
      {param.type === 'enum'
        ? <select id={id} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
          <option value="" disabled>请选择</option>
          {(param.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        : <input id={id} type={param.type === 'number' ? 'number' : 'text'} value={value === undefined ? '' : String(value)}
          onChange={(event) => onChange(coerceParam(param, event.target.value))} />}
      {param.note && <span className="hint">{param.note}</span>}
    </label>
  );
}

/** 启动执行 (wanlong-panel StartRunModal): any script on one instance, optional account, shot policy and params. */
export function StartRunDialog({ gameId, instances, busy, initialIndex, onStarted, onClose }: StartRunDialogProps) {
  const toast = useToast();
  const [scripts, setScripts] = useState<ScriptMeta[]>([]);
  const [accounts, setAccounts] = useState<GameAccount[]>([]);
  const [index, setIndex] = useState<number | null>(initialIndex);
  const [scriptId, setScriptId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [shotPolicy, setShotPolicy] = useState<ShotPolicy>('onFail');
  const [minutes, setMinutes] = useState('60');
  const [def, setDef] = useState<ScriptDef | null>(null);
  const [defError, setDefError] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, ScriptParamValue>>({});
  const [ime, setIme] = useState<ImeStatus | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([avdm.scriptList(gameId), avdm.accountList(gameId)]).then(([list, accountList]) => {
      if (!active) return;
      setScripts(list.filter((item) => item.version !== '0'));
      setAccounts(accountList);
    }, (error: unknown) => { if (active) setLoadError(errMsg(error)); });
    return () => { active = false; };
  }, [gameId]);

  // The full definition drives the param form (ScriptParamDef) and the summary line.
  useEffect(() => {
    if (!scriptId) { setDef(null); setParams({}); return; }
    let active = true;
    setDefError(null);
    void avdm.scriptGet(gameId, scriptId).then((script) => {
      if (!active) return;
      setDef(script);
      setParams(defaultParams(script.params));
    }, (error: unknown) => { if (active) { setDef(null); setDefError(errMsg(error)); } });
    return () => { active = false; };
  }, [gameId, scriptId]);

  // Picking an account brings its bound instance and default script along (original behaviour).
  useEffect(() => {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    if (account.binding) setIndex(account.binding.index);
    const preferred = (account as GameAccount & { defaultScriptId?: string }).defaultScriptId;
    if (preferred && !scriptId) setScriptId(preferred);
  }, [accountId, accounts, scriptId]);

  const selected = instances.find((instance) => instance.record.index === index);
  const selectedRunning = selected ? isRunning(selected) : false;
  useEffect(() => {
    setIme(null);
    if (index === null || !selectedRunning) return;
    let active = true;
    void avdm.imeStatus(index).then((status) => { if (active) setIme(status); }, () => undefined);
    return () => { active = false; };
  }, [index, selectedRunning]);

  const options = useMemo(() => instances.map((instance) => {
    const i = instance.record.index;
    const reason = instanceBlockReason(isRunning(instance), busy.get(i) ?? null);
    return { index: i, label: `#${i} · ${instance.record.name}${reason ? `（${reason}）` : ''}`, disabled: reason !== null };
  }), [instances, busy]);

  const minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue >= 0 && minutesValue <= 720;
  const indexBlock = index === null ? '请选择实例' : options.find((option) => option.index === index)?.disabled ? '所选实例不可用' : null;
  const reason = indexBlock ?? (!scriptId ? '请选择脚本' : !def ? '正在读取脚本' : !minutesValid ? '运行时长上限应为 0–720 分钟' : null);
  const needsIme = usesUnicodeText(def);

  async function start(): Promise<void> {
    if (reason || busyAction || index === null) return;
    setBusyAction('start');
    try {
      const snapshot = await avdm.scriptRun(gameId, index, scriptId, {
        accountId: accountId || undefined, params, shotPolicy, maxRunMinutes: minutesValue,
      });
      toast.push({ kind: 'success', title: '已启动执行', detail: `${snapshot.scriptName} → 实例 #${snapshot.instanceIndex}` });
      onStarted(snapshot);
      onClose();
    } catch (error) {
      toast.error('启动执行失败', errMsg(error));
    } finally { setBusyAction(null); }
  }

  async function setupIme(): Promise<void> {
    if (index === null || busyAction) return;
    setBusyAction('ime');
    try {
      const status = await avdm.imeSetup(index);
      if (status) { setIme(status); toast.push({ kind: 'success', title: 'ADBKeyboard 已启用', detail: status.message }); }
    } catch (error) {
      toast.error('安装输入法失败', errMsg(error));
    } finally { setBusyAction(null); }
  }

  return (
    <Modal title="启动执行" subtitle="在所选实例上立即运行一个脚本（编写与调试用），不需要账号或计划。" width={640} busy={busyAction === 'start'} onClose={onClose}
      footer={<>
        {reason && <span className="runs-dialog-reason">{reason}</span>}
        <button className="btn" onClick={onClose} disabled={busyAction === 'start'}>取消</button>
        <button className="btn primary" onClick={() => void start()} disabled={!!reason || busyAction !== null}>
          {busyAction === 'start' && <Spinner size={12} />}启动
        </button>
      </>}>
      {loadError && <p className="notice bad" role="alert">读取脚本或账号失败：{loadError}</p>}
      <div className="form-grid">
        <label className="field">
          <span className="field-label">目标实例</span>
          <select value={index ?? ''} onChange={(event) => setIndex(event.target.value === '' ? null : Number(event.target.value))}>
            <option value="" disabled>选择一个已开机的实例</option>
            {options.map((option) => <option key={option.index} value={option.index} disabled={option.disabled}>{option.label}</option>)}
          </select>
          {options.length === 0 && <span className="hint">没有实例。请先到「模拟器实例」创建并启动一个。</span>}
        </label>
        <label className="field">
          <span className="field-label">脚本</span>
          <select value={scriptId} onChange={(event) => setScriptId(event.target.value)}>
            <option value="" disabled>选择脚本</option>
            {scripts.map((script) => <option key={script.id} value={script.id}>{script.builtin ? '［示例］' : ''}{script.name}  v{script.version}（{script.stepCount} 步）</option>)}
          </select>
          {scripts.length === 0 && !loadError && <span className="hint">还没有脚本。到「脚本」页新建一个。</span>}
        </label>
        <label className="field">
          <span className="field-label">账号（可选，用于日志归档与参数取值）</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">不绑定账号</option>
            {accounts.map((account) => <option key={account.id} value={account.id} disabled={!account.enabled}>
              {account.name}{account.binding ? `（绑定实例 #${account.binding.index}）` : '（未绑定）'}{account.enabled ? '' : '（已停用）'}
            </option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">截图留痕策略</span>
          <select value={shotPolicy} onChange={(event) => setShotPolicy(event.target.value as ShotPolicy)}>
            {SHOT_POLICY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">运行时长上限（分钟，0 = 不限）</span>
          <input type="number" min={0} max={720} value={minutes} onChange={(event) => setMinutes(event.target.value.replace(/[^\d]/g, ''))} />
          <span className="hint">暂停的时间也计入。循环模式的脚本会一直跑到手动停止或到达上限。</span>
        </label>
      </div>

      {defError && <p className="notice bad runs-dialog-gap" role="alert">{defError}</p>}
      {def && (def.params?.length ?? 0) > 0 && (
        <fieldset className="runs-params">
          <legend>脚本参数</legend>
          <div className="form-grid">
            {def.params!.map((param) => (
              <ParamField key={param.key} param={param} value={params[param.key]}
                onChange={(value) => setParams((current) => {
                  const next = { ...current };
                  if (value === undefined) delete next[param.key]; else next[param.key] = value;
                  return next;
                })} />
            ))}
          </div>
        </fieldset>
      )}
      {def && (
        <p className="runs-muted runs-dialog-gap">
          脚本参考分辨率 {def.refWidth}x{def.refHeight}
          {def.packageName ? `｜目标应用 ${def.packageName}` : ''}
          {def.templateSetId ? `｜模板集 ${def.templateSetId}` : ''}
          {def.loop ? `｜挂机模式（每 ${Math.round((def.loopIntervalMs ?? 0) / 1000)} 秒重来一轮）` : ''}
        </p>
      )}
      {index !== null && selectedRunning && (
        <div className={`runs-ime ${ime?.available ? 'is-ready' : needsIme ? 'is-needed' : ''}`}>
          <span>中文输入：{ime ? ime.message : '正在检查…'}</span>
          {ime && !ime.available && (
            <button className="btn xs" onClick={() => void setupIme()} disabled={busyAction !== null}>
              {busyAction === 'ime' && <Spinner size={12} />}安装输入法
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
