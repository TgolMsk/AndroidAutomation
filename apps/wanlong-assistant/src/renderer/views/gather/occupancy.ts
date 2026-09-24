/**
 * Script occupancy of an instance as the gather UI shows it (plans module × gather). Pure.
 *
 * Scripts pre-empt gathering (DECISIONS A.4, original plans iron rule 1): before a plan round or a manual script run
 * takes the instance, the planner calls `scheduler.suspendForScript()` — the scheduler cancels its wake, lets the
 * in-flight sample / dispatch finish (or aborts it after the grace time) and stays away until the script ends, then
 * re-reads the queue. While that happens the card and the table row say so instead of looking idle, and the actions
 * the main process would refuse (立即采样 / 采集一轮 / saving the config, which needs the instance lease) are disabled
 * with that reason. Sources are the plans module's pushed state (`usePlanRuns`), never a guess from queue fields.
 */
import type { ScriptRunSnapshot } from '../../../main/plans/types';
import type { PlanRun } from '../../../shared/plan';
import { scriptRunBadge } from '../../state/plan-runs';

export interface ScriptOccupancy {
  /** The live script run holding (or about to hold) the instance: a plan round or a manual run. */
  running: Pick<ScriptRunSnapshot, 'runId' | 'scriptName' | 'status' | 'source'> | null;
  /** Plan rounds queued for this instance that do not hold it yet. */
  queued: number;
}

export interface OccupancyLine {
  text: string;
  /** Short consequence for gathering next to the tag; null when there is none worth saying. */
  note: string | null;
  tip: string;
  tone: 'accent' | 'info' | 'warning';
}

/** The instance's script occupancy; null when no script runs or waits for it. */
export function scriptOccupancyOf(
  index: number, scriptRun: ScriptRunSnapshot | undefined, planRuns: readonly Pick<PlanRun, 'runId' | 'instanceIndex' | 'status'>[],
): ScriptOccupancy | null {
  const running = scriptRun && scriptRun.instanceIndex === index ? scriptRun : null;
  const queued = planRuns.filter((run) => run.instanceIndex === index && run.status === 'queued' && run.runId !== running?.runId).length;
  if (!running && queued === 0) return null;
  return {
    running: running ? { runId: running.runId, scriptName: running.scriptName, status: running.status, source: running.source } : null,
    queued,
  };
}

function sourceText(source: ScriptRunSnapshot['source']): string {
  return source === 'plan' ? '计划任务' : '临时运行';
}

/** One line for the card / the status cell: what holds the instance and what that means for gathering. */
export function describeScriptOccupancy(occupancy: ScriptOccupancy | null, auto: boolean): OccupancyLine | null {
  if (!occupancy) return null;
  const { running, queued } = occupancy;
  const waiting = queued > 0 ? `；后面还有 ${queued} 个计划任务排队` : '';
  if (running) {
    const name = `「${running.scriptName}」（${sourceText(running.source)}）`;
    return {
      text: `${scriptRunBadge(running)}：${running.scriptName}`,
      tone: running.status === 'paused' ? 'warning' : 'accent',
      note: auto ? '自动采集已为脚本让路' : '脚本占用期间不能采样',
      tip: auto
        ? `脚本优先：自动采集已为${name}让路，这段时间不采样、不派兵；脚本结束后调度器会先重读一次队列再接着排${waiting}。`
        : `${name}正占用这个实例，这段时间立即采样、手动采集和保存采集配置都会被拒绝${waiting}。`,
    };
  }
  return {
    text: `${queued} 个计划任务排队中`,
    tone: 'info',
    note: auto ? '轮到时自动采集会先让路' : null,
    tip: auto
      ? '轮到它们时会先请自动采集让路（等在飞的采样 / 派遣收尾，超过让路时限就中断它），脚本跑完后自动采集接着排。'
      : '轮到它们时会占用这个实例执行脚本。',
  };
}

/** Why a device action is refused while a script holds the instance; null when none holds it. */
export function scriptHoldReason(occupancy: ScriptOccupancy | null): string | null {
  if (!occupancy?.running) return null;
  return `脚本「${occupancy.running.scriptName}」正在这个实例上运行（脚本优先），等它结束再操作。`;
}

/**
 * Why saving the gather config is refused right now: saving takes the instance lease briefly and a script run holds it
 * until it ends (the main process would answer 「实例 #N 正在运行脚本计划」). null when no script holds the instance.
 */
export function configSaveBlockedReason(occupancy: ScriptOccupancy | null): string | null {
  if (!occupancy?.running) return null;
  return `脚本「${occupancy.running.scriptName}」正在这个实例上运行（脚本优先，占着实例直到结束），保存采集配置要等它结束。`;
}
