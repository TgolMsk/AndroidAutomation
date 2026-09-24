# 自动采集界面（gather UI）

Port of wanlong-panel `src/renderer/src/features/gather/**` plus the 自动采集 column / 批量采集 menu of
`views/InstancesView.tsx`. Plain React + `gather.css` (prefix `gather-*`, design tokens only). The instance table
itself lives in `../instances/`.

## Files

| File | Original | Role |
|---|---|---|
| `GatherOverviewView.tsx` | `GatherOverviewView.tsx` | 采集总览 / 群控倒计时: KPIs, paused-instance alert, one card per instance, config + run drawers |
| `InstanceMarchCard.tsx` | `InstanceMarchCard.tsx` | card: online dot, account, `QueueBadge`, diagnostics badge, march rows, auto switch, 恢复 / 立即采样 / 配置 / 运行 |
| `MarchRow.tsx` | `MarchRow.tsx` | one march with resource badge, phase, coordinate, troop count, estimate badges, 「!」 hint, progress bar (stripes when unknown) |
| `InstanceDiagnosticsBadge.tsx`, `diagnostics.ts` | same | count badge → drawer; pure `collectDiagnostics` / `worstLevel` / `attentionCount` |
| `InstanceGatherControls.tsx` | same | the instance table's 自动采集 cell (`describeGatherStatus` is the pure status line) |
| `GatherConfigDrawer.tsx`, `GatherConfigView.tsx`, `ConfigField.tsx` | same | the full config form in a drawer with an unsaved-changes guard |
| `config-model.ts`, `useGatherConfigBadges.ts` | `configStorage.ts`, `useGatherConfigBadges.ts` | origin / save target texts, `describeGatherConfigBadge`, scheduler-config mismatch |
| `queue-store.ts` | `marchStore.ts` | module store (`useSyncExternalStore`) over `schedulerStates` + `scheduler-changed` |
| `present.ts` | `present.ts` | `presentMarch`, `summarizeQueues`, `formatShort` / `formatAgo` / `formatClock` (Beijing) |
| `batch.ts`, `useGatherControls.tsx` | `useInstanceGather.ts` + InstancesView `batchTargets` | skip rules, `describeBatchOutcome`, shared toggle / sample / resume / batch handlers |
| `EnableAutoDialog.tsx` | batch 「全部开启」 confirm + the old 「我已核对探针结果」 checkbox | fresh read-only probe verdict per instance before enabling |
| `InstanceRunDrawer.tsx` | (former single-instance gather page) | template set, read-only probe, 采集一轮 / 停止本轮, recent runs |
| `pause-port.ts`, `PauseDetails.tsx` | `features/alerts` (pauses, resume, PauseBanner) | ★ the only place pauses are read — see below |
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

A copy that cannot be read never locks the page (original `loadGatherConfig`: fall back to defaults and say so):
`getAutomationSettings` returns `accountConfigError` (the bound account's JSON is corrupt; `config` is empty, the
form shows defaults) or `settingsError` (the instance file is unreadable / incompatible; a salvage keeps the template
set it still names). The form shows the reason and allows 「保存」 without edits; saving rewrites the account copy and
rebuilds the instance file (the broken one is kept as `<i>.json.corrupt`). Runs stay strict and refuse with the reason.

## Pause port (to be replaced by the alerts module)

`pauseInfoOf(state)` reads `SchedulerQueueState.pause` (filled by the alerts module's `pauseOf` hook) and, until
that exists, shows the scheduler's own safety pause (auto off after 8 consecutive failures) as 「连续失败熔断」.
`resumeInstance()` is `schedulerSetAuto(true)` today. Point both at the alerts IPC and replace `PauseDetails` with the
full PauseBanner; no caller changes. Rules kept: paused ≠ `!auto`; resume only through its own confirmation.
Known gaps until then (see the header of `pause-port.ts`): a resume after an app restart needs a passing probe, and
needsAttention / readiness pauses are not shown as paused.

## Deliberate differences

- Times on cards and tooltips are Beijing time (DECISIONS A.8), the original used the host clock.
- An unbound instance is not a config problem (its own config applies); the original flagged it.
- Enabling auto always shows a fresh probe verdict; the main process still enforces its own probe gate.
- Esc closes only the topmost layer (shell `escape-layers.ts`, used by Drawer / Modal / Menu), as antd did.
