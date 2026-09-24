import { useEffect, useMemo, useState } from 'react';
import {
  ABSOLUTE_LEVEL_POLICY_DEFAULT, GATHER_RESOURCE_ORDER, defaultGatherConfig, defaultLevelPolicy, describeLevelPolicy,
  exportGatherConfig, formatSeconds, formatStorage, gatherConfigTypeIssues, hasBlockingIssue, importGatherConfig, validateGatherConfig,
  type AllianceTerritory, type GatherConfig, type GatherResourceType, type ResourceEntry,
} from '@avdm/automation/wanlong/pure';
import type { AutomationSettings } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { useToast } from '../../components/Toasts';
import { ConfigField, ConfigSection, IssueList, NumberInput } from './ConfigField';
import {
  configOriginOf, draftOf, originText, parseBackoffText, savedMessage, saveTargetText, schedulerMismatch, schedulerSyncPatch,
  storageWarnings, type GatherConfigOrigin,
} from './config-model';
import { useGatherQueues } from './queue-store';
import { GATHER_RESOURCE_META } from './resources';
import { GatherSwitch, ResourceBadge } from './widgets';

export interface GatherConfigViewProps {
  gameId: string;
  /** The instance being configured (the drawer's instance; the form never follows the global selection). */
  index: number;
  /** Name of the account bound to this AVD (identity-checked), or null: where 「保存」 writes. */
  boundAccount: string | null;
  /** Auto scheduling is on: saving a config switches it off (a changed policy needs a fresh probe). */
  autoOn: boolean;
  /** Called after a successful save (refresh badges and queues). */
  onSaved?(index: number): void;
  /** Unsaved edits exist: the drawer guards its close with it. */
  onDirtyChange?(dirty: boolean): void;
}

/** Backoff list text box: keeps the raw text while typing (so 「30, 」 is not eaten) and reports the parsed list. */
function BackoffInput({ value, onChange }: { value: number[]; onChange(next: number[]): void }) {
  const [text, setText] = useState(() => value.join(', '));
  useEffect(() => {
    setText((current) => (parseBackoffText(current).join(',') === value.join(',') ? current : value.join(', ')));
  }, [value]);
  return (
    <input type="text" className="gather-text-input" style={{ width: 320 }} value={text} placeholder="30, 60, 120, 240, 300" aria-label="退避序列（秒）"
      onChange={(event) => { setText(event.target.value); onChange(parseBackoffText(event.target.value)); }} />
  );
}

/**
 * 采集配置 (original GatherConfigView, the embedded drawer form): every field of gather-config.schema.json v2 with
 * what it does and what it costs, per-path validation issues, the scheduler-config mismatch banner with one-click
 * sync, reset to defaults, import / export and a sticky save bar.
 *
 * ★ The most important sentence of the page (repeated in the level section): the levels here are search FLOORS.
 *   The game returns points of level >= the searched value; searching 5 and getting 7 is normal and better.
 */
export function GatherConfigView({ gameId, index, boundAccount, autoOn, onSaved, onDirtyChange }: GatherConfigViewProps) {
  const toast = useToast();
  const queues = useGatherQueues(gameId);
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cfg, setCfg] = useState<GatherConfig>(() => defaultGatherConfig());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [ioOpen, setIoOpen] = useState(false);
  const [ioText, setIoText] = useState('');
  const [ioError, setIoError] = useState<string | null>(null);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let alive = true;
    setSettings(null);
    setLoadError(null);
    setDirty(false);
    avdm.getAutomationSettings(gameId, index).then((value) => {
      if (!alive) return;
      setSettings(value);
      setCfg(draftOf(value));
    }, (error: unknown) => {
      if (!alive) return;
      setLoadError(errMsg(error));
      setCfg(defaultGatherConfig());
    });
    return () => { alive = false; };
  }, [gameId, index]);

  const origin: GatherConfigOrigin = settings ? configOriginOf(settings, boundAccount) : 'default';
  const warnings = storageWarnings(settings);
  /**
   * Saving is the repair for an unreadable or index-inherited copy, and moves an instance copy still in effect into the
   * bound account, so it is allowed without edits.
   */
  const needsSave = Boolean(loadError) || warnings.length > 0 || Boolean(settings?.configReplaced) || origin === 'instance-unmoved';
  const issues = useMemo(() => validateGatherConfig(cfg), [cfg]);
  const blocked = hasBlockingIssue(issues);
  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const warnCount = issues.length - errorCount;
  const mismatch = useMemo(() => schedulerMismatch(cfg, queues.config), [cfg, queues.config]);

  /** The single edit entry point: every change marks the form dirty. */
  function patch(fn: (draft: GatherConfig) => void): void {
    setCfg((previous) => {
      const next = structuredClone(previous);
      fn(next);
      return next;
    });
    setDirty(true);
  }

  function patchResource(type: GatherResourceType, fn: (entry: ResourceEntry) => void): void {
    patch((draft) => {
      const entry = draft.resources.find((item) => item.type === type);
      if (entry) fn(entry);
    });
  }

  async function save(config: GatherConfig = cfg): Promise<void> {
    const problems = validateGatherConfig(config);
    if (hasBlockingIssue(problems)) {
      toast.push({ kind: 'error', title: `还有 ${problems.filter((issue) => issue.level === 'error').length} 处配置错误，修好之后才能保存。` });
      return;
    }
    setSaving(true);
    try {
      const saved = await avdm.saveAutomationSettings(gameId, index, { config: config as unknown as Record<string, unknown> });
      setSettings(saved);
      setCfg(draftOf(saved));
      setLoadError(null);
      setDirty(false);
      toast.push({ kind: 'success', title: '采集配置已保存', detail: savedMessage(saved, index, autoOn) });
      onSaved?.(index);
    } catch (error) {
      // Never swallowed: the Chinese reason (including the main process's validation) is shown as is.
      toast.error('保存采集配置失败', errMsg(error));
    } finally {
      setSaving(false);
    }
  }

  async function syncScheduler(): Promise<void> {
    setSyncing(true);
    try {
      const error = await queues.saveConfig(schedulerSyncPatch(cfg));
      if (error) toast.error('同步到调度器失败', error);
      else toast.push({ kind: 'success', title: '已把这几项同步给调度器，立即生效。' });
    } finally {
      setSyncing(false);
    }
  }

  function openIo(): void {
    setIoText(exportGatherConfig(cfg));
    setIoError(null);
    setIoOpen(true);
  }

  function applyImport(): void {
    try {
      const imported = importGatherConfig(ioText);
      // Values of the wrong type were replaced by defaults while importing: say which, never silently.
      const replaced = gatherConfigTypeIssues(JSON.parse(ioText) as unknown);
      setCfg(imported);
      setDirty(true);
      setIoOpen(false);
      setIoError(null);
      if (replaced.length > 0) {
        toast.push({
          kind: 'warn', title: `已导入，但有 ${replaced.length} 处值不认识，已换成默认值`,
          detail: `${replaced.slice(0, 4).map((issue) => issue.message.replace(/。$/, '')).join('；')}${replaced.length > 4 ? ' 等' : ''}。检查无误后点「保存」落盘。`,
        });
      } else {
        toast.push({ kind: 'success', title: '已导入，检查无误后点「保存」落盘。' });
      }
    } catch (error) {
      setIoError(errMsg(error));
    }
  }

  async function copyExport(): Promise<void> {
    try { await avdm.appCopyText(ioText); toast.push({ kind: 'success', title: '已复制到剪贴板' }); }
    catch (error) { toast.error('复制失败', errMsg(error)); }
  }

  const lp = cfg.levelPolicy;
  const enabledResources = cfg.resources.filter((item) => item.enabled);

  if (!settings && !loadError) return <p className="gather-micro"><Spinner size={12} /> 正在读取采集配置…</p>;

  return (
    <div className="gather-cfg">
      {loadError && (
        <div className="notice bad" role="alert">
          <Icon name="alert" />
          <div>读取已保存的配置失败：{loadError}。下面显示的是默认配置；核对后点「保存」会用它覆盖已保存的那份。</div>
        </div>
      )}
      {warnings.map((text) => (
        <div key={text} className="notice bad" role="alert">
          <Icon name="alert" />
          <div>{text}</div>
        </div>
      ))}
      {settings?.configReplaced && (
        <div className="notice warn" role="status">
          <Icon name="alert" />
          <div>这份配置是这个序号上已被删除的旧实例留下的（实例 #{index} 已重建），采集不会按序号沿用它、在重新保存之前会拒绝开跑。核对后点「保存」才算这个实例自己的配置。</div>
        </div>
      )}
      {origin === 'instance-unmoved' && (
        <div className="notice info" role="status">
          <Icon name="info" />
          <div>{originText(origin, settings ?? {}, index, boundAccount)}。核对后点一次「保存」，以后就跟着账号走。</div>
        </div>
      )}
      <p className="gather-micro">{saveTargetText(boundAccount, index)}</p>

      {/* ── 总开关 ── */}
      <ConfigSection title="总开关"
        desc={<span>关掉之后调度器完全不会为这个实例安排采集任务，已经在途的队伍不受影响（游戏会自己把它们带回来）。当前配置来源：<b>{originText(origin, settings ?? {}, index, boundAccount)}</b>。</span>}
        extra={<>
          {errorCount > 0 && <span className="wl-ui-tag is-danger">{errorCount} 处错误</span>}
          {warnCount > 0 && <span className="wl-ui-tag is-warning">{warnCount} 处提醒</span>}
          {errorCount === 0 && warnCount === 0 && <span className="wl-ui-tag is-success">配置校验通过</span>}
        </>}>
        <ConfigField name="启用自动采集" path="enabled" issues={issues}
          hint="打开后，调度器会按下面的策略自动搜点、派兵、记录 ETA 并在队列释放时再派。"
          cost="打开就是真的会派兵占用行军队列。先把下面的阈值配好再开。">
          <GatherSwitch checked={cfg.enabled} label="启用自动采集" onChange={(on) => patch((d) => { d.enabled = on; })} />
          <span className="gather-label">{cfg.enabled ? '已启用' : '已停用'}</span>
        </ConfigField>
      </ConfigSection>

      {/* ── 资源类型 ── */}
      <ConfigSection title="资源类型"
        desc={<span>勾选要采的资源，并给每种分配队列数与优先级。有空队列时，调度器按优先级从小到大找第一个「还欠队列」的资源去派。当前已启用 {enabledResources.length} 种，合计分配 {enabledResources.reduce((sum, item) => sum + item.queues, 0)} 个队列。</span>}>
        <div className="gather-res-grid">
          {GATHER_RESOURCE_ORDER.map((type) => {
            const meta = GATHER_RESOURCE_META[type];
            const entry = cfg.resources.find((item) => item.type === type);
            if (!entry) return null;
            return (
              <div key={type} className={`gather-res-card${entry.enabled ? ' is-on' : ''}`}>
                <div className="gather-res-card-head">
                  <ResourceBadge type={type} size={34} />
                  <div className="gather-res-card-name"><span className="gather-field-name">{meta.resource}</span><span className="gather-micro">搜索面板分类「{meta.category}」</span></div>
                  <GatherSwitch checked={entry.enabled} size="sm" label={`采集${meta.resource}`} onChange={(on) => patchResource(type, (r) => { r.enabled = on; })} />
                </div>
                <label className="gather-res-card-row" title="数字越小越先派。有空队列时优先满足优先级高、且还没派满队列数的资源。">
                  <span className="gather-label">优先级</span>
                  <NumberInput value={entry.priority} min={1} max={4} emptyAs={entry.priority} width={80} disabled={!entry.enabled}
                    label={`${meta.resource}的优先级`} onChange={(v) => patchResource(type, (r) => { r.priority = v; })} />
                </label>
                <label className="gather-res-card-row" title="这种资源最多同时占用几个行军队列。填 0 等于不采（即使开关是开的）。">
                  <span className="gather-label">分配队列</span>
                  <NumberInput value={entry.queues} min={0} max={5} emptyAs={entry.queues} width={80} disabled={!entry.enabled}
                    label={`${meta.resource}的分配队列`} onChange={(v) => patchResource(type, (r) => { r.queues = v; })} />
                </label>
              </div>
            );
          })}
        </div>
        <IssueList issues={issues.filter((issue) => issue.path === 'resources' || issue.path.startsWith('resources.'))} />
      </ConfigSection>

      {/* ── 等级下限 ── */}
      <ConfigSection title="等级策略（搜索下限）" desc={(
        <div className="notice info"><Icon name="info" /><div>
          <strong>这里配的是「搜索下限」，不是目标等级。</strong>
          游戏的匹配规则是「返回等级<b>大于等于</b>搜索值的资源点」，不是精确匹配。真机实测：把搜索值调到 1，连续搜 6 次返回的点是 8、7、7、7、7、8 ——
          一次都没等于搜索值。所以搜 5 跳到 7 级点是<b>正常且更划算</b>的结果，不是失败；游戏也<b>不提供等级上界</b>，想避开不要的点只能靠下面的储量 / 行军时长 / 采集者 / 联盟四个维度。
        </div></div>
      )}>
        <ConfigField name="下限的算法" path="levelPolicy.mode" issues={issues}
          hint="相对：跟着游戏进程自动走（等级上限从 8 涨到 10 时不用改配置）。绝对：锁死一个值。">
          <div className="segmented" role="radiogroup" aria-label="下限的算法">
            {([['relative', '相对上限（推荐）'], ['absolute', '绝对值']] as const).map(([mode, label]) => (
              <button key={mode} type="button" role="radio" aria-checked={lp.mode === mode} className={lp.mode === mode ? 'active' : ''}
                onClick={() => { if (lp.mode !== mode) patch((d) => {
                  const hardCap = d.levelPolicy.maxLevelHardCap;
                  d.levelPolicy = mode === 'absolute' ? { ...ABSOLUTE_LEVEL_POLICY_DEFAULT, maxLevelHardCap: hardCap } : { ...defaultLevelPolicy(), maxLevelHardCap: hardCap };
                }); }}>{label}</button>
            ))}
          </div>
        </ConfigField>

        {lp.mode === 'relative' ? (<>
          <ConfigField name="相对上限的偏移" path="levelPolicy.offset" issues={issues}
            hint="搜索下限 = 动态探测到的等级上限 + 这个偏移。用户默认规则是上限 −1。"
            cost="偏移越接近 0，候选点越少、越容易搜不到而反复重搜（每次重搜要多截几张图）；偏移越负，候选点越多、越快派出去，但可能采到低级点。">
            <NumberInput value={lp.offset} min={-5} max={0} emptyAs={lp.offset} label="相对上限的偏移"
              onChange={(v) => patch((d) => { if (d.levelPolicy.mode === 'relative') d.levelPolicy.offset = v; })} />
            <span className="gather-label">级</span>
          </ConfigField>
          <ConfigField name="探测失败时假定的上限" path="levelPolicy.assumedMaxLevel" issues={issues}
            hint="正常情况下上限是把搜索滑杆推到最右读出来的。读不到时用这个值兜底，实测当前版本是 8。">
            <NumberInput value={lp.assumedMaxLevel} min={1} max={15} emptyAs={lp.assumedMaxLevel} label="探测失败时假定的上限"
              onChange={(v) => patch((d) => { if (d.levelPolicy.mode === 'relative') d.levelPolicy.assumedMaxLevel = v; })} />
          </ConfigField>
        </>) : (<>
          <ConfigField name="固定搜索下限" path="levelPolicy.level" issues={issues}
            hint="配 6 会搜到 6 级及以上的点，7、8 级都算合格。"
            cost="配得越高，附近符合的点越少，越容易一直搜不到而进入冷却；配得越低，派兵越快但收益偏低。">
            <NumberInput value={lp.level} min={1} max={15} emptyAs={lp.level} label="固定搜索下限"
              onChange={(v) => patch((d) => { if (d.levelPolicy.mode === 'absolute') d.levelPolicy.level = v; })} />
            <span className="gather-label">级及以上</span>
          </ConfigField>
          <ConfigField name="允许放宽下限重试" path="levelPolicy.allowRelax" issues={issues} hint="关掉则固定下限搜不到就放弃本轮，不放宽。">
            <GatherSwitch checked={lp.allowRelax} label="允许放宽下限重试"
              onChange={(on) => patch((d) => { if (d.levelPolicy.mode === 'absolute') d.levelPolicy.allowRelax = on; })} />
          </ConfigField>
        </>)}

        <ConfigField name="上限硬顶" path="levelPolicy.maxLevelHardCap" issues={issues}
          hint="探测读到超过这个值一律判为识别错误。这是防误识别的护栏，不是资源点的等级上界。">
          <NumberInput value={lp.maxLevelHardCap} min={1} max={30} emptyAs={lp.maxLevelHardCap} label="上限硬顶"
            onChange={(v) => patch((d) => { d.levelPolicy.maxLevelHardCap = v; })} />
        </ConfigField>

        <ConfigField name="下限可放宽到的最低值" path="levelPolicy.minLevel" issues={issues}
          hint="连续搜不到可用点时，下限会按下面的「每次放宽级数」逐步降低，降到这里为止；再失败就本轮放弃并进入冷却。"
          cost="设得越低越不容易空手而归，但也更可能采到收益很低的点。">
          <NumberInput value={lp.minLevel} min={1} max={15} emptyAs={lp.minLevel} label="下限可放宽到的最低值"
            onChange={(v) => patch((d) => { d.levelPolicy.minLevel = v; })} />
        </ConfigField>
        <div className="gather-field-cost">{describeLevelPolicy(lp, null)}</div>
      </ConfigSection>

      {/* ── 筛选阈值 ── */}
      <ConfigSection title="资源点筛选阈值" desc="搜到一个点之后，用这几条判断要不要采。任何一条不满足都会退出去重搜（重搜会多花几百毫秒到一秒）。">
        <ConfigField name="最低储量" path="thresholds.minStorage" issues={issues}
          hint={<span>读资源点卡片上的「储量」（实测能读到 1,260,000 这种数）。低于这个值直接换点。当前设定：<b>{formatStorage(cfg.thresholds.minStorage)}</b>，填 0 表示不限制。</span>}
          cost="设得高，采一趟的收益高，但符合的点变少、更容易反复重搜；设得低，很快就能派出去但可能采一个小坑。">
          <NumberInput value={cfg.thresholds.minStorage} min={0} step={50000} emptyAs={0} width={180} label="最低储量"
            onChange={(v) => patch((d) => { d.thresholds.minStorage = v; })} />
        </ConfigField>
        <ConfigField name="最长单程行军" path="thresholds.maxTravelSeconds" issues={issues}
          hint={<span>首选的距离约束。这个数在「创建部队」页能从行军按钮上<b>直接读到</b>（实测显示 00:01:04），精确且必然可见，比读地图上的「18 km」可靠得多。当前设定：<b>{formatSeconds(cfg.thresholds.maxTravelSeconds)}</b>，填 0 表示不限制。</span>}
          cost="设得小，队伍来回快、单位时间产量高，但附近符合的点少；设得大，能采远处的好点，但一趟往返会占住队列很久。">
          <NumberInput value={cfg.thresholds.maxTravelSeconds} min={0} step={30} emptyAs={0} width={180} label="最长单程行军"
            onChange={(v) => patch((d) => { d.thresholds.maxTravelSeconds = v; })} />
          <span className="gather-label">秒</span>
        </ConfigField>
        <ConfigField name="最远距离（可选）" path="thresholds.maxDistanceKm" issues={issues}
          hint="读卡片右下角的「18 km」。这个标签贴在地图标记上、背景不稳定，识别可靠性明显低于上面的行军秒数，默认 0（不启用）。"
          cost="启用后多一道筛选，但一旦这个数字识别错了，会莫名其妙地把好点筛掉。除非确有需要，保持 0。">
          <NumberInput value={cfg.thresholds.maxDistanceKm} min={0} emptyAs={0} width={180} label="最远距离"
            onChange={(v) => patch((d) => { d.thresholds.maxDistanceKm = v; })} />
          <span className="gather-label">km</span>
        </ConfigField>
        <ConfigField name="必须「采集者 无」" path="thresholds.requireGathererNone" issues={issues}
          hint="卡片上「采集者」一栏必须是「无」，否则说明这个点已经被别人占了。"
          cost="关掉等于允许去抢已占用的点，实际结果就是派兵失败白跑一趟。除非在调试，不要关。">
          <GatherSwitch checked={cfg.thresholds.requireGathererNone} label="必须采集者为无"
            onChange={(on) => patch((d) => { d.thresholds.requireGathererNone = on; })} />
        </ConfigField>
        <ConfigField name="所属联盟策略" path="thresholds.allianceTerritory" issues={issues}
          hint={<span>卡片的「所属联盟」实测<b>不只有「无」</b>，还会出现联盟缩写，表示这个点在某个联盟的领地里。本方领地通常有采集加成；敌对领地则可能被打掉部队和资源。</span>}
          cost="默认「不筛」：收点最快、可选目标最多。改成筛选会漏掉大量可采点，且需要额外识别联盟字段。">
          <select value={cfg.thresholds.allianceTerritory} aria-label="所属联盟策略"
            onChange={(event) => patch((d) => { d.thresholds.allianceTerritory = event.target.value as AllianceTerritory; })}>
            <option value="any">不筛联盟 —— 任何领地都采（默认）</option>
            <option value="own-and-neutral">本方 + 中立</option>
            <option value="own-only">只采本方联盟领地（通常有加成）</option>
          </select>
        </ConfigField>
        <ConfigField name="本方联盟缩写" path="thresholds.ownAllianceTag" issues={issues}
          hint="上面不选「不筛」时需要它来判断哪块是本方领地。留空时引擎会自动降级为「只接受所属联盟＝无（中立点）」并在这里告警 —— 方向是安全的（少采而不是采错），但会漏掉本方领地上的加成点。"
          cost="填了还要为它裁一张本方联盟标签的模板（按账号一张）。换联盟之后必须重裁，否则会把别人的领地认成自己的。">
          <input type="text" className="gather-text-input" style={{ width: 180 }} maxLength={8} placeholder="留空 = 只接受中立点" aria-label="本方联盟缩写"
            value={cfg.thresholds.ownAllianceTag} onChange={(event) => patch((d) => { d.thresholds.ownAllianceTag = event.target.value; })} />
        </ConfigField>
        <ConfigField name="优先一趟采空" path="thresholds.preferLoadCoversStorage" issues={issues}
          hint="打开后，如果「创建部队」页显示的负载量小于卡片储量（一趟拉不完），就退出去重搜一个更小的点。"
          cost="默认关：勾了下面的「自动采集至清空」之后游戏会自己续采，没必要为此多重搜几次。">
          <GatherSwitch checked={cfg.thresholds.preferLoadCoversStorage} label="优先一趟采空"
            onChange={(on) => patch((d) => { d.thresholds.preferLoadCoversStorage = on; })} />
        </ConfigField>
      </ConfigSection>

      {/* ── 游戏内设置项 ── */}
      <ConfigSection title="游戏内设置项" desc="这一节改的是游戏里的勾选框，不是面板自己的开关。引擎走「读实际态 → 比对 → 只在不一致时点一下 → 复验」的对账流程，绝不盲点。">
        <ConfigField name="自动采集至清空" path="autoGatherUntilEmpty" issues={issues}
          hint="资源点卡片上的勾选框。勾上之后队伍会一直采到这个点清空为止，不需要面板反复派兵。"
          cost="开着能显著减少派兵次数（也就少了很多次截图与操作）；关掉则每趟采满就回，队列周转更快但面板要更频繁地干活。">
          <GatherSwitch checked={cfg.autoGatherUntilEmpty} label="自动采集至清空" onChange={(on) => patch((d) => { d.autoGatherUntilEmpty = on; })} />
        </ConfigField>
      </ConfigSection>

      {/* ── 队列分配 ── */}
      <ConfigSection title="队列与派兵前置" desc="派兵的硬前置只有一个：行军队列有空位（「部队管理」右上角的 N/M）。指挥官耐力只用于打架，不影响采集，不做拦截。">
        <ConfigField name="预留队列数" path="queuePlan.reserveQueues" issues={issues}
          hint="留给打野、集结这些别的玩法，自动采集不会去占。可用队列 = 队列上限 − 已用 − 预留。"
          cost="留得多，别的玩法随时有队伍可用；留得少，采集吞吐更高。">
          <NumberInput value={cfg.queuePlan.reserveQueues} min={0} max={5} emptyAs={0} label="预留队列数"
            onChange={(v) => patch((d) => { d.queuePlan.reserveQueues = v; })} />
        </ConfigField>
        <ConfigField name="自动采集最多占用的队列数" path="queuePlan.maxConcurrentGather" issues={issues}
          hint="上面各资源分配的队列之和不应超过这个值，超出的部分不会生效。">
          <NumberInput value={cfg.queuePlan.maxConcurrentGather} min={1} max={5} emptyAs={1} label="自动采集最多占用的队列数"
            onChange={(v) => patch((d) => { d.queuePlan.maxConcurrentGather = v; })} />
        </ConfigField>
        <ConfigField name="避免两队派同一个点" path="queuePlan.avoidDuplicateTarget" issues={issues}
          hint="用「部队管理」面板每行的坐标做去重；新搜到的点如果和在途目标坐标相同就重搜。"
          cost="关掉会省下读坐标的那一点识别开销，但两队撞同一个点，后到的那队会白跑。">
          <GatherSwitch checked={cfg.queuePlan.avoidDuplicateTarget} label="避免两队派同一个点"
            onChange={(on) => patch((d) => { d.queuePlan.avoidDuplicateTarget = on; })} />
        </ConfigField>
      </ConfigSection>

      {/* ── 搜索重试 ── */}
      <ConfigSection title="搜索与放宽重试" desc={<span>
        搜到的点被占用 / 储量不够 / 太远 / 联盟不符 / 与在途目标重复，都算一次失败。连续失败到上限后，按下面的级数<b>放宽搜索下限</b>——注意「放宽」是让更多点符合条件，
        不等于「退而求其次采低级点」，放宽后照样可能采到高级点。<b>等级高于下限不算失败，不会计数。</b>
      </span>}>
        <ConfigField name="同一下限下最多重搜次数" path="searchRetry.occupiedRetryLimit" issues={issues}
          cost="次数多，坚持在高等级上找好点，代价是每次重搜都要多截几张图（游戏在前台时单张约 750ms）；次数少，很快就放宽下限，派得快但收益可能低。">
          <NumberInput value={cfg.searchRetry.occupiedRetryLimit} min={1} max={20} emptyAs={1} label="同一下限下最多重搜次数"
            onChange={(v) => patch((d) => { d.searchRetry.occupiedRetryLimit = v; })} />
          <span className="gather-label">次</span>
        </ConfigField>
        <ConfigField name="每次放宽几级" path="searchRetry.floorRelaxStep" issues={issues} hint="schema v1 里这项叫 levelDownStep，名字有误导已更名。">
          <NumberInput value={cfg.searchRetry.floorRelaxStep} min={1} max={3} emptyAs={1} label="每次放宽几级"
            onChange={(v) => patch((d) => { d.searchRetry.floorRelaxStep = v; })} />
          <span className="gather-label">级</span>
        </ConfigField>
        <ConfigField name="两次搜索之间的间隔" path="searchRetry.researchDelayMs" issues={issues}
          hint="给地图跳转和卡片弹出动画留时间。" cost="太小会截到动画中间帧、模板匹配失败，反而要多搜几次；太大就是白等。">
          <NumberInput value={cfg.searchRetry.researchDelayMs} min={0} step={100} emptyAs={0} width={160} label="两次搜索之间的间隔"
            onChange={(v) => patch((d) => { d.searchRetry.researchDelayMs = v; })} />
          <span className="gather-label">毫秒</span>
        </ConfigField>
        <ConfigField name="动态探测等级上限" path="searchRetry.probeMaxLevel" issues={issues}
          hint="把搜索滑杆推到最右读数得到上限（实测当前 8，后期版本会到 10）。关掉则一直用上面的「假定上限」。"
          cost="开着每隔一段时间多花几张截图，换来的是版本更新后不用手改配置。">
          <GatherSwitch checked={cfg.searchRetry.probeMaxLevel} label="动态探测等级上限" onChange={(on) => patch((d) => { d.searchRetry.probeMaxLevel = on; })} />
        </ConfigField>
        <ConfigField name="重新探测上限的间隔" path="searchRetry.probeIntervalMin" issues={issues}
          hint="上限随游戏进程增长，变化极慢，默认 12 小时探一次，其余时间用缓存值。">
          <NumberInput value={cfg.searchRetry.probeIntervalMin} min={1} emptyAs={1} width={160} label="重新探测上限的间隔"
            onChange={(v) => patch((d) => { d.searchRetry.probeIntervalMin = v; })} />
          <span className="gather-label">分钟</span>
        </ConfigField>
      </ConfigSection>

      {/* ── 调度冗余 ── */}
      <ConfigSection title="调度冗余量" desc={<span>
        用户明确要求：<b>重复采集不必卡死时间，留冗余，宁晚勿早</b>。唤醒时刻 = 队列释放时刻 + 唤醒冗余；队列释放时刻 = 采集完成 + 单程行军
        （采集完队伍会自动回城，行军耗时在派兵时就从行军按钮上读到了，不用猜）。
      </span>}>
        {mismatch.length > 0 && (
          <div className="notice warn gather-mismatch" role="status">
            <Icon name="alert" />
            <div>
              <strong>这几项与调度器当前运行的值不一致</strong>
              <div>调度器自己也保存了一份运行时配置，真正决定什么时候唤醒的是<b>它那一份</b>。下面这些项两边对不上，同步一下免得改了半天不生效：</div>
              {mismatch.map((diff) => <div key={diff.key} className="gather-micro">· {diff.label}：本页 <b>{diff.here}</b>，调度器 <b>{diff.there}</b></div>)}
              <button type="button" className="btn xs primary" disabled={syncing || queues.status?.owner === false} onClick={() => void syncScheduler()}
                title={queues.status?.owner === false ? '另一个万龙助手进程正在管理调度，本窗口不能改调度器配置。' : undefined}>
                {syncing && <Spinner size={12} />}把本页的值同步给调度器
              </button>
            </div>
          </div>
        )}
        <ConfigField name="唤醒冗余" path="schedule.slackSeconds" issues={issues}
          hint={<span>当前 {formatSeconds(cfg.schedule.slackSeconds)}。</span>}
          cost="调小提高效率，但更容易撞上「队伍还没回来」——白开一次面板（截图约 750ms）之后还得退避重排，反而更慢。调大就是多空转一会儿。">
          <NumberInput value={cfg.schedule.slackSeconds} min={0} max={900} step={10} emptyAs={0} width={160} label="唤醒冗余"
            onChange={(v) => patch((d) => { d.schedule.slackSeconds = v; })} />
          <span className="gather-label">秒</span>
        </ConfigField>
        <ConfigField name="队列仍未空时的退避序列" path="schedule.retryBackoffSeconds" issues={issues}
          hint="逗号分隔的秒数，逐项取用，用完之后一直用最后一项。派兵成功后计数清零。"
          cost="序列爬得太慢会一直空转重试；爬得太快则队伍刚好回来时你还在睡。">
          <BackoffInput value={cfg.schedule.retryBackoffSeconds} onChange={(list) => patch((d) => { d.schedule.retryBackoffSeconds = list; })} />
        </ConfigField>
        <ConfigField name="退避上限" path="schedule.maxBackoffSeconds" issues={issues}>
          <NumberInput value={cfg.schedule.maxBackoffSeconds} min={30} step={30} emptyAs={30} width={160} label="退避上限"
            onChange={(v) => patch((d) => { d.schedule.maxBackoffSeconds = v; })} />
          <span className="gather-label">秒</span>
        </ConfigField>
        <ConfigField name="兜底校准间隔" path="schedule.calibrateIntervalMin" issues={issues}
          hint="距上次读「部队管理」面板超过这个时长就强制重采一次，纠正本地递推的漂移（机器休眠会让定时器滞后）。总览页上超过这个时长的行会灰化并标「待校准」。"
          cost="调小更准，但每次校准都要真的开一次面板（几张截图）；调大省开销，但倒计时可能与实际有偏差。">
          <NumberInput value={cfg.schedule.calibrateIntervalMin} min={1} emptyAs={1} width={160} label="兜底校准间隔"
            onChange={(v) => patch((d) => { d.schedule.calibrateIntervalMin = v; })} />
          <span className="gather-label">分钟</span>
        </ConfigField>
        <ConfigField name="多实例错峰抖动" path="schedule.jitterSeconds" issues={issues}
          hint="唤醒时刻上再加一个 0 到该值之间的随机量。"
          cost="多开时很有用：所有账号同一秒醒来会一起抢 adb，互相拖慢。单开可以设 0。">
          <NumberInput value={cfg.schedule.jitterSeconds} min={0} emptyAs={0} width={160} label="多实例错峰抖动"
            onChange={(v) => patch((d) => { d.schedule.jitterSeconds = v; })} />
          <span className="gather-label">秒</span>
        </ConfigField>
        <ConfigField name="每小时派兵次数上限" path="schedule.maxDispatchesPerHour" issues={issues} hint="熔断保护：识别出错导致疯狂重试时兜底。填 0 表示不限制。">
          <NumberInput value={cfg.schedule.maxDispatchesPerHour} min={0} emptyAs={0} width={160} label="每小时派兵次数上限"
            onChange={(v) => patch((d) => { d.schedule.maxDispatchesPerHour = v; })} />
          <span className="gather-label">次</span>
        </ConfigField>
        <ConfigField name="放弃后的冷却" path="schedule.giveUpCooldownMin" issues={issues} hint="下限已经放宽到最低值仍然搜不到可用点时，隔这么久再试一轮。">
          <NumberInput value={cfg.schedule.giveUpCooldownMin} min={1} emptyAs={1} width={160} label="放弃后的冷却"
            onChange={(v) => patch((d) => { d.schedule.giveUpCooldownMin = v; })} />
          <span className="gather-label">分钟</span>
        </ConfigField>
      </ConfigSection>

      {/* ── 安全与容错 ── */}
      <ConfigSection title="安全与容错" desc="识别不确定时怎么办。默认全是保守档：宁可少采一轮，也不在读不准的情况下乱点。">
        <ConfigField name="对账复验失败即中止" path="safety.abortOnReconcileFail" issues={issues}
          hint="改完游戏内设置项后会再读一次确认。确认不通过就中止本轮并报错，不再继续点。" cost="关掉可能让勾选框被反复点开点关。建议保持开启。">
          <GatherSwitch checked={cfg.safety.abortOnReconcileFail} label="对账复验失败即中止" onChange={(on) => patch((d) => { d.safety.abortOnReconcileFail = on; })} />
        </ConfigField>
        <ConfigField name="卡片等级识别失败时" path="safety.onUnknownLevel" issues={issues}
          hint={<span>「继续」的理由是：既然游戏只会返回等级 <b>≥</b> 搜索下限的点，读不出等级时也可以认为它满足下限，接着走后面的储量 / 联盟 / 行军时长校验。</span>}
          cost="选「中止」最保守但会更频繁地空转 —— 当前模板库只有 7、8 两个等级字形，选它几乎每轮都会中止；选「继续」代价只是日志里缺等级信息，故取它作默认。">
          <select value={cfg.safety.onUnknownLevel} aria-label="卡片等级识别失败时"
            onChange={(event) => patch((d) => { d.safety.onUnknownLevel = event.target.value as 'abort' | 'acceptCard'; })}>
            <option value="abort">中止本轮（最保守）</option>
            <option value="acceptCard">视为满足下限，继续后续校验（默认）</option>
          </select>
        </ConfigField>
        <ConfigField name="储量识别失败时" path="safety.onUnknownStorage" issues={issues} cost="选「换点」会多搜几次；选「接受」可能采到一个几乎空的点。">
          <select value={cfg.safety.onUnknownStorage} aria-label="储量识别失败时"
            onChange={(event) => patch((d) => { d.safety.onUnknownStorage = event.target.value as 'skipPoint' | 'accept'; })}>
            <option value="skipPoint">当作不达标，换点（保守，默认）</option>
            <option value="accept">接受这个点</option>
          </select>
        </ConfigField>
        <ConfigField name="倒计时识别失败时的保守 ETA" path="safety.unknownEtaFallbackSeconds" issues={issues}
          hint="读不出「采集中 HH:MM:SS」时，按这个值重排唤醒。总览页上这样的行会显示「倒计时不可用」而不是当成空闲。"
          cost="宁晚勿早：设小了会一次次白跑去看队伍回来没有。">
          <NumberInput value={cfg.safety.unknownEtaFallbackSeconds} min={60} step={60} emptyAs={60} width={160} label="倒计时识别失败时的保守 ETA"
            onChange={(v) => patch((d) => { d.safety.unknownEtaFallbackSeconds = v; })} />
          <span className="gather-label">秒</span>
        </ConfigField>
        <ConfigField name="单轮派兵截图数上限" path="safety.maxCapturesPerCycle" issues={issues}
          hint="游戏在前台时单张截图实测约 750ms。超过上限说明流程卡在某一步了，中止并报错。默认 60：实测一次顺利派兵要 17 帧、一次换点要 6~7 帧，给少了重试策略跑不满就被熔断。">
          <NumberInput value={cfg.safety.maxCapturesPerCycle} min={6} emptyAs={6} width={160} label="单轮派兵截图数上限"
            onChange={(v) => patch((d) => { d.safety.maxCapturesPerCycle = v; })} />
          <span className="gather-label">张</span>
        </ConfigField>
        <ConfigField name="滑动重试次数" path="safety.swipeRetry" issues={issues}
          hint="adb 的滑动指令会偶发被系统拒绝（SecurityException: INJECT_EVENTS），实测重试一次就好。" cost="设 0 等于把这种偶发失败直接变成整轮失败。">
          <NumberInput value={cfg.safety.swipeRetry} min={0} emptyAs={0} width={160} label="滑动重试次数"
            onChange={(v) => patch((d) => { d.safety.swipeRetry = v; })} />
          <span className="gather-label">次</span>
        </ConfigField>
        <ConfigField name="截图留痕策略" path="safety.shotPolicy" issues={issues}
          hint="记录在配置里的留痕偏好。采集失败现场实际按「设置 → 面板设置」里的全局截图留痕策略保存。"
          cost="「每步都留」排障最方便，但磁盘涨得快；「从不」最省，出问题时无从查起。">
          <select value={cfg.safety.shotPolicy} aria-label="截图留痕策略"
            onChange={(event) => patch((d) => { d.safety.shotPolicy = event.target.value as 'never' | 'onFail' | 'always'; })}>
            <option value="never">从不留痕</option>
            <option value="onFail">仅失败时留痕（默认）</option>
            <option value="always">每一步都留痕</option>
          </select>
        </ConfigField>
      </ConfigSection>

      {/* ── 吸底操作条 ── */}
      <div className="gather-actions">
        <span className="gather-actions-msg">
          {dirty ? '有未保存的修改' : `已同步 · ${originText(origin, settings ?? {}, index, boundAccount)}`}
          {blocked && <span className="gather-actions-err">　{errorCount} 处错误未修复</span>}
          {dirty && autoOn && <span className="gather-actions-warn">　保存后会关闭这个实例的自动采集（改了策略要重新探测）</span>}
        </span>
        <div className="gather-inline">
          <button type="button" className="btn sm" onClick={openIo}><Icon name="download" />导出 / 导入</button>
          <button type="button" className="btn sm" onClick={() => setResetting(true)}><Icon name="restart" />恢复默认</button>
          <button type="button" className="btn sm primary" disabled={saving || blocked || (!dirty && !needsSave)} onClick={() => void save()}>
            {saving ? <Spinner size={12} /> : <Icon name="check" />}保存
          </button>
        </div>
      </div>

      {resetting && (
        <ConfirmDialog title="恢复默认配置？" confirmLabel="恢复默认" message="当前页面上的修改会被丢弃，恢复成默认值。恢复后仍需点「保存」才会落盘。"
          onClose={() => setResetting(false)} onConfirm={() => { setCfg(defaultGatherConfig()); setDirty(true); }} />
      )}
      {ioOpen && (
        <Modal title="导出 / 导入采集配置" onClose={() => setIoOpen(false)} width={720}
          footer={<>
            <button type="button" className="btn" onClick={() => void copyExport()}><Icon name="copy" />复制</button>
            <button type="button" className="btn" onClick={() => setIoOpen(false)}>关闭</button>
            <button type="button" className="btn primary" onClick={applyImport}><Icon name="download" />导入这段 JSON</button>
          </>}>
          <p className="hint block">下面是当前页面上的配置。可以整段复制走做备份，也可以粘一段进来再点「导入」—— 导入只改页面，还要再点「保存」才会落盘。缺失的字段会自动补默认值。</p>
          <textarea className="gather-io-text" rows={16} spellCheck={false} value={ioText} aria-label="采集配置 JSON"
            onChange={(event) => { setIoText(event.target.value); setIoError(null); }} />
          {ioError && <div className="gather-field-err" role="alert">导入失败：{ioError}</div>}
        </Modal>
      )}
    </div>
  );
}
