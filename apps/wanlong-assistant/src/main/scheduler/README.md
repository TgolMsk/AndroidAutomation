# ETA 调度器（万龙觉醒自动采集）

移植自 wanlong-panel `src/main/scheduler/`（`index.ts` / `timers.ts` / `store.ts` / `ipc.ts`）与 `src/main/game/gatherRunner.ts` 的接线部分。
纯逻辑（队列模型、排期、疲劳换算、面板采样、数字 OCR）在 `packages/automation/src/wanlong/scheduler/`，
这里只有主进程服务：锁、定时器、落盘、视觉工作线程、钩子。

```
EtaScheduler (service.ts)        排期 / 唤醒 / 退避 / 健康探针 / 让路 / 暂停；不认识 ADB，只调 EtaSchedulerPorts
  ├─ InstanceLocks (instance-lock.ts)   进程内 FIFO + 跨进程租约 run/automation-instance-<i>.lock，AsyncLocalStorage 可重入
  ├─ WakeTimers (timers.ts)             每实例一个唤醒；unref；超过 2^31 分段
  └─ SchedulerStore (store.ts)          automation/games/wanlong/scheduler/{config.json, instances/<i>.json}
AutomationHost (automation/host.ts)     实现 EtaSchedulerPorts；QueueFreeHook = 采集一轮 (gatherForScheduler)
  └─ WanlongGatherRunner (automation/gather-runner.ts)
       └─ VisionWorkerPool (vision-pool.ts) ── vision-worker.ts（每实例一个常驻 worker，模板只编译一次）
ShotStore (shots.ts)                    automation/wanlong/shots/inst<N>-<label>-<时刻>.jpg（0600，14 天 / 300 张）
ScheduleCompat (compat.ts)              旧 AutomationSchedule 视图（渲染进程 / 账号 / 监控 / 机器人仍在读）
```

## 行为（与原版一致）

- **两段式唤醒**：到点先只读采样（开面板 → 读每行状态与倒计时 → 关面板），只有 `hasFreeSlot === true` 才交给 `QueueFreeHook` 跑 G0–G16 一轮。
  `null`（N/M 读不出）当作没空位。
- **唤醒时刻**：`freeAt = 采样时刻 + 剩余（疲劳期换算）+ 单程行军`，唤醒 = `freeAt + slack + jitter`，地板 `max(30s, minSampleIntervalMs)`。
  另有「队列有空位 / 状态未知 → 尽快」「疲劳期边界 +30s」「周期校准」「健康探针」四类候选。
- **退避阶梯** `[30, 60, 120, 240, 300]` 秒；队列满、读不出、派完仍有空位、失败都走它。
- **不是失败**：`queueFull` / `noResourceWanted` / `giveUp` / `staminaLow` / `circuitBroken` 清零失败计数；
  `circuitBroken` 与 `giveUp` 以 `QueueFreeResult.notBefore`（熔断 10 分钟 / 放弃冷却）作为下次唤醒的下限。
- **健康探针**：默认 3 分钟一帧，不开面板，在实例锁内跑；不算采样结果，不推进退避。
- **冷启动**（DECISIONS C）：采样第 2 轮认不出界面、采集 G0 前台不是游戏时，用 monkey 拉起游戏包（只允许插件自己的包名），
  然后「只看不点」地等到可识别界面；采样就地加 180 s 预算。实例本身没运行时不开机。
- **派兵记账**：每一趟都记（`noteDispatches`，行军按钮没读出也按兜底值记），然后强制重读一次面板。
- **暂停 = `setAuto(false)`**：中止在飞的采样 / 采集，取消唤醒，落盘，推 `scheduler-changed`。暂停之后没有任何路径会再 rearm。

## 门槛与安全

- 视觉工作线程每次输入都经过主进程：**探针门槛之前**只允许白名单恢复动作（`closePopup` 点关闭 ×1、`probeBack` 盲按 BACK ×1、
  `exitCancel` 点「取消」×2、`ensureGame` monkey 拉起），其余输入一律拒绝；**门槛之后**（恰好一个已知场景锚点、分数 ≥ 0.90 且领先 0.05，
  游戏在前台，`record.createdAt` 未变）才放开。每次输入前主进程都复核前台包名。
- 实例锁同时是跨进程租约：登录、脚本计划、另一个助手进程占着实例时，调度器在 150 ms 内得到 `CONCURRENCY_LIMIT` 并让路，不算失败。
- 调度器本身也有一把「单写者」租约 `automation/games/wanlong/eta-scheduler.lock`：第二个进程只读（`readOnly: true`），不排期。
- 连续 8 次真失败（可配 `maxConsecutiveFailures`）自动暂停并调用 `onScheduleStop` 告警 —— 本仓库原有的安全阀，原版没有。

## 给后续模块的接口

服务实例在 `AutomationHost.eta`，锁在 `AutomationHost.locks`。在 `src/main/index.ts` 各自的段落里注册：

```ts
// ── alerts / freeze ──
automation.eta.setHooks({
  onSampleResult: async (index, ok, message, { signal }) => { /* 锁内、被 await；可调 exclusive() 重启实例 */ },
  onFrameCaptured: (index, raw) => freezeGuard.feed(index, raw),          // 锁内、同步、不得抛
  onCaptureFailed: (index, error) => freezeGuard.captureFailed(index, error),
  onHealthProbe: async (index, raw, { foreground, running, signal }) => { /* 顶号探针 / 卡死判定 */ },
  onHealthProbeFailed: async (index, error, { signal }) => { /* 截图都截不到 */ },
  onUnrecognizedFrame: async (index, raw, { signal }) => true | 'recovered' | 'updated' | false,  // 顶号 / AI / 更新
  onMarchGone: (index, gone, at) => stats.record(...),                     // 一趟采集完成（参考指标）
  onAutoChanged: (index, enabled, at, reason) => stats.record(...),        // ★ 暂停 / 恢复事件的唯一来源（只在真的翻转时）
  onNeedsAttention: (index, { code, message }) => alerts.raise(...),       // GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED，已暂停
  pauseOf: (index) => alerts.pauseInfo(index),                             // 队列视图里的暂停原因
  log: (level, message) => { ... },
});
// ── accounts / AI / kicked ──
automation.setPorts({
  accountIdOf, ensureAccountReady, externalBusy, accountGatherConfig,
  probeKicked: async (index, raw) => KickedProbeResult | null,             // 失败现场那一帧；模板缺失必须 return null
  adviseUnknownScreen: async (index, raw, attempt, signal) => boolean,     // 采集 G0 盲按 BACK 之前
});
```

`AutomationHostHooks`（构造参数）另有 `onCycleResult(index, fact, source)`（`GatherCycleFact`：outcome / step（`'G0'` = 恢复阶梯用尽）/
errorCode / dispatched / captures / shotPath / kicked，**在失败的调度轮往上抛之前**报；「这一轮压根没跑起来」也补报一次；取消的轮次不报）
与 `onDispatched(index, records, at)`（每趟派兵：资源 / 坐标 / 等级 / 搜索下限 / 储量 / 行军秒数）。

`EtaScheduler` 公共方法：

| 方法 | 说明 |
|---|---|
| `exclusive(i, what, fn({signal}), signal?)` | 借出实例锁（机器人截图、读资源统计、卡死重启、AI 点击）。在钩子里调用时重入；外部占用 / 脚本在跑时抛 `CONCURRENCY_LIMIT`（`what` 进中文提示）。★ `fn` 里绝不能 `setAuto(true)` |
| `suspendForScript(i, graceMs, reason)` | 脚本优先：先等在飞的链路 `graceMs`，再中止并等锁排空（≤5 s）。返回幂等的 `release()`：换新 AbortController，15 s 后「脚本执行结束，重读队列校验」。从不抛 |
| `setAuto(i, enabled, reason?)` | 代数计数 + 就绪门槛（实例在跑、身份、模板、配置、账号）+ 首次只读采样。关闭永远成功且优先。★ 只能从 IPC / 锁外调用 |
| `sampleNow(i)` | 面板「立即刷新」，受 `minSampleIntervalMs` 节流，不派兵 |
| `noteDispatch(es)(i, notes, {signal, resample})` | 派兵记账（行军秒数 / 坐标 / 资源），默认之后强制重采一次 |
| `forget(i)` / `cancelWake(i)` / `listWakes()` | 清空记账 / 只取消本次唤醒 / 所有待唤醒 |
| `getConfig()` / `saveConfig(patch)` | 全局 `SchedulerConfig`（原版字段与默认值，`SCHEDULER_CONFIG_RANGE` 夹值） |
| `list()` / `getState(i)` / `isAuto(i)` / `isOperating(i)` | 队列视图 `SchedulerQueueState` |
| `setHooks(partial)` / `setQueueFreeHook(fn)` | 合并钩子（传 `undefined` 移除一个）；采集交接 |

`AutomationHost` 还提供 `recognizeScreen(i, raw, signal)`（用缓存模板判断是否已知界面，给卡死恢复等主界面用）与
`invalidateTemplates()`（AI 自学模板之后让所有 worker 丢弃编译缓存；普通模板编辑靠 manifest 指纹自动失效）。

### IPC 与事件

`src/shared/ipc/scheduler.ts`：`schedulerStates / schedulerState / schedulerSample / schedulerSetAuto / schedulerConfig /
saveSchedulerConfig / schedulerWakes / schedulerCancelWake / schedulerForget`；事件 `scheduler-changed`（`SchedulerQueueState`）与
`scheduler-config-changed`。旧的 `setAutomationSchedule` / `automationSchedules` / `automation-schedule` 继续可用（经 `ScheduleCompat`）。
渲染进程可用 `@avdm/automation/wanlong/pure` 的 `deriveMarchView` / `formatDuration` / `summarizeQueues` 每秒本地递推倒计时，零 ADB。

### 错误码

`SchedulerError(code, message, detail)`：`CONCURRENCY_LIMIT`（让路，不算失败）、`RUN_ABORTED` / `CANCELLED`（中止）、
`GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED`（需要人处理：暂停、不计失败）、`STEP_FAILED`（`detail.step`）、`PROBE_REJECTED`、
`DEVICE_NOT_READY`、`TEMPLATE_NOT_FOUND`、`TIMEOUT`。

## 与原版的差异

- 旧版 `AutomationScheduler`（按上一轮结果排下一轮）已删除；`automation/scheduler/wanlong/<i>.json` 在启动时迁移（只继承开关），
  原文件改名为 `.migrated`。脚本计划与自动采集不再互斥，改为 `suspendForScript` 抢占（由脚本计划模块调用）。
- 健康探针候选以「上次探针时刻」为准（原版在每次采样后都会把探针往后推，队列很少变化时相当于没有探针）。
- `templateSetId` 只做校验（配置了就必须与模板集 id 一致），不做自动挑选；模板集按实例在「模板」页选择。
- 视觉工作线程常驻；hook（AI 问询、等游戏更新）期间暂停作业超时，单次最多 30 分钟，作为「游戏更新时延长一轮超时」的实现。
- 连续失败安全暂停（8 次）是本仓库保留的额外保护。

## 验证

```
pnpm --filter @avdm/automation exec vitest run test/wanlong-eta-model.test.ts test/wanlong-troop-sampler.test.ts test/wanlong-number-text.test.ts
pnpm --filter @avdm/wanlong-assistant exec vitest run test/eta-scheduler.test.ts test/eta-store.test.ts test/gather-runner.test.ts test/automation-host.test.ts
WL_FRAMES_DIR=… WL_TEMPLATE_DIR=… pnpm --filter @avdm/automation exec vitest run test/wanlong-replay.test.ts   # 真机帧回放（没有就跳过）
pnpm build:wanlong && packages/cli/node_modules/.bin/tsx apps/wanlong-assistant/scripts/live-sample.ts 0 [--sample]
```
