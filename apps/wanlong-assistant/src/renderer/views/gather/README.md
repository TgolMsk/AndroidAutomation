# 自动采集界面（gather UI）

Port of wanlong-panel `src/renderer/src/features/gather/**` plus the 自动采集 column / 批量采集 menu of
`views/InstancesView.tsx`. Plain React + `gather.css` (prefix `gather-*`, design tokens only). The instance table
itself lives in `../instances/`.

## Files

| File | Original | Role |
|---|---|---|
| `GatherOverviewView.tsx` | `GatherOverviewView.tsx` | 采集总览 / 群控倒计时: KPIs, the alerts module's paused-instances strip, one card per instance, config + run drawers |
| `InstanceMarchCard.tsx` | `InstanceMarchCard.tsx` | card: online dot, account, `QueueBadge`, diagnostics badge, script occupancy note, march rows, auto switch, 恢复 / 立即采样 / 配置 / 运行 |
| `MarchRow.tsx` | `MarchRow.tsx` | one march with resource badge, phase, coordinate, troop count, estimate badges, 「!」 hint, progress bar (stripes when unknown) |
| `InstanceDiagnosticsBadge.tsx`, `diagnostics.ts` | same | count badge → drawer with the alerts module's `PauseBanner`; pure `collectDiagnostics` / `worstLevel` / `attentionCount` |
| `InstanceGatherControls.tsx` | same | the instance table's 自动采集 cell (`describeGatherStatus` is the pure status line) |
| `GatherConfigDrawer.tsx`, `GatherConfigView.tsx`, `ConfigField.tsx` | same | the full config form in a drawer with an unsaved-changes guard |
| `config-model.ts`, `useGatherConfigBadges.ts` | `configStorage.ts`, `useGatherConfigBadges.ts` | origin / save target texts, `describeGatherConfigBadge`, scheduler-config mismatch |
| `queue-store.ts` | `marchStore.ts` | module store (`useSyncExternalStore`) over `schedulerStates` + `scheduler-changed` |
| `present.ts` | `present.ts` | `presentMarch`, `summarizeQueues`, `formatShort` / `formatAgo` / `formatClock` (Beijing) |
| `batch.ts`, `useGatherControls.tsx` | `useInstanceGather.ts` + InstancesView `batchTargets` | skip rules, `describeBatchOutcome`, shared toggle / sample / resume / batch handlers |
| `EnableAutoDialog.tsx` | batch 「全部开启」 confirm + the old 「我已核对探针结果」 checkbox | fresh read-only probe verdict per instance before enabling |
| `InstanceRunDrawer.tsx` | (former single-instance gather page) | template set, read-only probe, 采集一轮 / 停止本轮, recent runs |
| `occupancy.ts` | (plans × gather, new) | pure: a script run holding / plan rounds waiting for an instance → pre-emption note and the refused actions |
| `resources.ts`, `widgets.tsx` | `types.ts`, `ResourceBadge.tsx` | glyph + token colour badges (no game art), switch, queue badge, hint bubble |

## Where the config lives (DECISIONS B「调度器」)

The gather config follows the account bound to the AVD (`Account.scriptParams.gather.configJson`, identity-checked);
an instance without an account uses its own settings file `automation/wanlong/<i>.json`, stamped with the AVD's
`createdAt`. `configReplaced` flags a copy left by a deleted AVD at the same index: the page shows it for review, but
runs refuse it (`AUTOMATION_NOT_READY`, a scheduled wake pauses without counting a failure) until it is re-saved —
never inherited by index alone. Binding moves the instance copy into an account that has none and clears it
(original `afterAccountBind`). Saving validates in both the form (`validateGatherConfig`) and
`AutomationHost.saveSettings` (`validateGatherConfigInput`: wrong types, per-resource overrides and ranges are
refused, never replaced or clamped; what is stored is the normalization of exactly the validated document), and
switches an enabled schedule off (a changed policy needs a fresh probe).

Only the config page writes it: the generic `accountSetScriptParams` refuses the `gather` namespace, and a legacy
account import validates the old config the same way (refused → left out with a note; accepted → imported switched
off). A bound account without a config of its own still runs the instance copy; the page then says so
(`instance-unmoved`: 「绑定账号「X」里还没有采集配置，当前生效的是实例 #i 本机设置里的那份」) and 保存 moves it into the
account. Every settings save broadcasts `automation-settings-changed`, so the badges of both pages (the overview is
kept alive) reload whichever page saved.

A copy that cannot be read never locks the page (original `loadGatherConfig`: fall back to defaults and say so):
`getAutomationSettings` returns `accountConfigError` (the bound account's JSON is corrupt; `config` is empty, the
form shows defaults) or `settingsError` (the instance file is unreadable / incompatible; a salvage keeps the template
set it still names). The form shows the reason and allows 「保存」 without edits; saving rewrites the account copy and
rebuilds the instance file (the broken one is kept as `<i>.json.corrupt`). Runs stay strict and refuse with the reason.

## Pauses: the alerts module's records (one source of truth)

Every pause shown here is an alerts pause record (`renderer/state/alerts.ts`: `useAlerts()` / `pauseOf()`, kept live by
`alert-pause-changed`): kicked, offline, consecutive failures, and the scheduler's own pauses — its safety pause after
`maxConsecutiveFailures`, a needs-attention pause (game update / the AI's risk gate, from any chain through
`EtaScheduler.raiseAttention`) and a readiness refusal — which the alerts module records too. The scheduler keeps no
pause of its own (`SchedulerQueueState.pause` only mirrors the record through `pauseOf`), and nothing here derives a
pause from `!auto` or a failure count. The red card frame, the red instance row, the status line, the diagnostics badge
(the full `PauseBanner` with reason, advice, push result, scene shot and, for an AI pause, a link to 「AI 处理」) and the
batch skip rule all read the record. 「恢复」 on a card or row is `resumePause(i)` → `resumeAlertPause`: it clears the
record, the counters and the push cooldown and switches auto on outside the instance lock without a second probe gate
(original alerts:resume); the auto switch stays locked while paused (the main process refuses it too).
`pauseTitle()` adds the stage of a needs-attention pause (「需要人工介入（AI 操作风险评估）」).

## Scripts pre-empt gathering (plans module)

A script run (plan round or manual run) makes the scheduler yield before it takes the instance
(`scheduler.suspendForScript`). `occupancy.ts` turns the plans module's pushed runs (`usePlanRuns`: the live
`scriptRunByInstance` plus queued `PlanRun`s) into a note on the card and a 「为脚本让路」 status line, and disables what
the main process would refuse while a script holds the instance — 立即采样 / 采样 (also skipped by a batch sample),
采集一轮, and saving the config (it needs the instance lease briefly) — with that reason. Queued rounds only get a note.

## Deliberate differences

- Times on cards and tooltips are Beijing time (DECISIONS A.8), the original used the host clock.
- An unbound instance is not a config problem (its own config applies); the original flagged it.
- A bound account without a config shows the instance copy that is still in effect (runs use it too), not the
  original's defaults: a failed bind migration never looks like lost settings, and 保存 finishes the move.
- Enabling auto always shows a fresh probe verdict; the main process still enforces its own probe gate, accepting the
  pass the user confirmed (`probeCapturedAt`, ≤ 5 min, no edit since) instead of probing twice. Probes and enables in
  the dialog run at most two at a time.
- Esc closes only the topmost layer (shell `escape-layers.ts`, used by Drawer / Modal / Menu), as antd did.
