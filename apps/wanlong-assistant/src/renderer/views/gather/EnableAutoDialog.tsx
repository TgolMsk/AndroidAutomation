import { useEffect, useState } from 'react';
import type { AutomationProbeReport } from '../../../shared/ipc';
import { avdm, errMsg } from '../../api';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Spinner } from '../../components/StatusBadge';
import { collectOutcome, mapLimited, type BatchOutcome } from './batch';
import { setQueueAuto } from './queue-store';

/**
 * Probes run at most this many at a time (each is a capture plus a vision worker); enabling uses the same cap (each
 * enable runs a first panel sample, possibly cold-starting the game).
 */
const PROBE_CONCURRENCY = 2;
/** Below this the OCR of countdowns and levels becomes unreliable (templates are 2560×1440). */
export const MIN_RELIABLE_WIDTH = 1920;
export const MIN_RELIABLE_HEIGHT = 1080;

type Verdict =
  | { kind: 'probing' }
  | { kind: 'ready'; report: AutomationProbeReport }
  | { kind: 'blocked'; reason: string; report?: AutomationProbeReport };

/** The fresh read-only probe verdict of one instance, as the dialog shows it. Pure (tested). */
export function probeVerdict(report: AutomationProbeReport, packageName: string): { ready: boolean; reason: string } {
  if (report.foregroundPackage !== packageName) {
    return { ready: false, reason: `前台不是游戏（${report.foregroundPackage ?? '未检测到'}）。${report.launchReason}` };
  }
  if (!report.launchReady) return { ready: false, reason: report.launchReason };
  const low = report.deviceWidth > 0 && (Math.max(report.deviceWidth, report.deviceHeight) < MIN_RELIABLE_WIDTH ||
    Math.min(report.deviceWidth, report.deviceHeight) < MIN_RELIABLE_HEIGHT);
  return {
    ready: true,
    reason: low ? `${report.launchReason}。注意：画面 ${report.deviceWidth}×${report.deviceHeight} 低于 1920×1080，倒计时与等级读数可能不可靠。` : report.launchReason,
  };
}

/**
 * Confirm enabling auto gathering (original batch 「全部开启自动采集」 confirm + the old per-instance 「我已核对探针结果」
 * checkbox): every target gets a FRESH read-only probe first and its verdict is shown; instances that pass are
 * ticked. Enabling hands the confirmed probe back (`probeCapturedAt`): main accepts that recent pass as its
 * first-enable gate (same AVD and template set, no edit since, ≤ 5 min), so the verdict shown is the one enforced and
 * nothing is probed twice. A ticked blocked instance has no pass to hand back: main probes again (or uses a pass it
 * confirmed earlier in this session, and may then cold-start the game).
 */
export function EnableAutoDialog({ gameId, packageName, targets, skipped, onClose, onDone }: {
  gameId: string;
  packageName: string;
  targets: ReadonlyArray<{ index: number; name: string }>;
  /** Skip lines from `batchTargets` (shown so the user sees who is left out). */
  skipped: readonly string[];
  onClose(): void;
  onDone(outcome: BatchOutcome): void;
}) {
  const [verdicts, setVerdicts] = useState<Record<number, Verdict>>(() => Object.fromEntries(targets.map((t) => [t.index, { kind: 'probing' }])));
  const [chosen, setChosen] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const probing = Object.values(verdicts).some((verdict) => verdict.kind === 'probing');
  const key = targets.map((t) => t.index).join(',');

  useEffect(() => {
    let alive = true;
    void mapLimited(key.split(',').filter(Boolean).map(Number), PROBE_CONCURRENCY, async (index) => {
      let verdict: Verdict;
      try {
        const report = await avdm.probeAutomation(gameId, index);
        const judged = probeVerdict(report, packageName);
        verdict = judged.ready ? { kind: 'ready', report } : { kind: 'blocked', reason: judged.reason, report };
      } catch (error) {
        verdict = { kind: 'blocked', reason: errMsg(error) };
      }
      if (!alive) return;
      setVerdicts((current) => ({ ...current, [index]: verdict }));
      setChosen((current) => (index in current ? current : { ...current, [index]: verdict.kind === 'ready' }));
    });
    return () => { alive = false; };
  }, [gameId, packageName, key]);

  const selected = targets.filter((t) => chosen[t.index]).map((t) => t.index);

  async function confirm(): Promise<void> {
    if (busy || selected.length === 0) return;
    setBusy(true);
    try {
      const results = await mapLimited(selected, PROBE_CONCURRENCY, async (index) => {
        const verdict = verdicts[index];
        const opts = verdict?.kind === 'ready' ? { probeCapturedAt: verdict.report.capturedAt } : undefined;
        return { index, reason: await setQueueAuto(gameId, index, true, opts) };
      });
      onDone(collectOutcome(results));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={targets.length === 1 ? `开启实例 #${targets[0]!.index} 的自动采集？` : `开启 ${targets.length} 个实例的自动采集？`}
      subtitle="每个实例先做一次只读探测（只截图、不点击），通过的才默认勾选" onClose={onClose} busy={busy} width={640}
      footer={<>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn primary" onClick={() => void confirm()} disabled={busy || probing || selected.length === 0}>
          {busy && <Spinner size={12} />}{probing ? '正在探测…' : `开启 ${selected.length} 个`}
        </button>
      </>}>
      <p className="confirm-message">
        将对勾选的实例打开自动调度：每个实例会先读一次「部队管理」面板，之后队列一有空位就真的会派出采集队。
        {skipped.length > 0 && ` 跳过：${skipped.join('；')}。`}
      </p>
      <ul className="gather-verdicts">
        {targets.map((target) => {
          const verdict = verdicts[target.index] ?? { kind: 'probing' };
          return (
            <li key={target.index} className={`gather-verdict is-${verdict.kind}`}>
              <label className="check">
                <input type="checkbox" checked={chosen[target.index] === true} disabled={busy || verdict.kind === 'probing'}
                  onChange={(event) => setChosen((current) => ({ ...current, [target.index]: event.target.checked }))} />
                <strong>#{target.index} {target.name}</strong>
              </label>
              <span className="gather-verdict-text">
                {verdict.kind === 'probing' && <><Spinner size={12} /> 正在只读探测…</>}
                {verdict.kind === 'ready' && <><Icon name="check" size={14} /> 可以开启：{probeVerdict(verdict.report, packageName).reason}</>}
                {verdict.kind === 'blocked' && <><Icon name="alert" size={14} /> 暂不能开启：{verdict.reason}</>}
              </span>
            </li>
          );
        })}
      </ul>
      {Object.values(verdicts).some((verdict) => verdict.kind === 'blocked') && (
        <p className="hint block">没通过的实例默认不勾：先把游戏停在城内或世界地图再重试。若本窗口此前已为它确认过探针，勾上后会直接开启（必要时冷启动游戏）；否则开启时会再做一次只读探测，不通过就拒绝并说明原因。</p>
      )}
    </Modal>
  );
}
