# ETA 调度器（万龙觉醒自动采集）

移植自 wanlong-panel `src/main/scheduler/`（`index.ts` / `timers.ts` / `store.ts` / `ipc.ts`）与 `src/main/game/gatherRunner.ts` 的接线部分。
纯逻辑（队列模型、排期、疲劳换算、面板采样、数字 OCR）在 `packages/automation/src/wanlong/scheduler/`，
这里只有主进程服务：锁、定时器、落盘、视觉工作线程、钩子。

```
EtaScheduler (service.ts)        排期 / 唤醒 / 退避 / 健康探针 / 让路 / 暂停；不认识 ADB，只调 EtaSchedulerPorts
  ├─ InstanceLocks (instance-lock.ts)   进程内 FIFO + 应用外壳的带标签实例租约（run/automation-instance-<i>.lock + owner.json
  │                                     + 占用表 instanceAccess），AsyncLocalStorage 可重入
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
- **不是失败**：`queueFull` / `noResourceWanted` / `giveUp` / `staminaLow` / `circuitBroken` 清零失败计数，运行记录记为成功、
  不发「运行失败」告警（统计里 `circuitBreaks` 单独计）。`circuitBroken` 以 `QueueFreeResult.notBefore = 现在 + 10 分钟` 冷却
  （DECISIONS B），冷却期内**只**不做采样唤醒，健康探针照常按 `healthProbeIntervalMin` 跑；`giveUp` 与原版一样不理会流程自己的
  唤醒时刻，走退避阶梯（≤5 分钟），流程在冷却期内直接返回、不动设备。
- **健康探针**：默认 3 分钟一帧，不开面板，在实例锁内跑；不算采样结果，不推进退避。
- **冷启动**（DECISIONS C）：采样第 2 轮认不出界面、采集 G0 前台不是游戏时，用 monkey 拉起游戏包（只允许插件自己的包名），
  然后「只看不点」地等到可识别界面；采样就地加 180 s 预算。实例本身没运行时不开机。
- **派兵记账**：每一趟都记（`noteDispatches`，行军按钮没读出也按兜底值记），然后强制重读一次面板。
- **暂停 = `setAuto(false)`**：中止在飞的采样 / 采集，取消唤醒，落盘，推 `scheduler-changed`。暂停之后没有任何路径会再 rearm。
  ★ 关闭永远不排在开启后面：`AutomationHost.setSchedule(false)` 不进控制锁，直接作废还在探针 / 首次采样（冷启动可达数分钟）的开启请求。
- **读不注册实例**：`getState(i)` / `ScheduleCompat.get` 只读；`list()` 只列有调度状态的实例（开着自动、采过样、有队伍、有错误或正在操作）；
  关闭一个从没登记过的实例不落盘。
- **退出**：`AutomationHost.dispose()` 先中止所有采集轮（手动轮与调度器共用实例锁），再同时收尾调度器与运行器；
  调度器等锁排空最多 8 s。
- **重启恢复**：开着自动的实例全部重新排期；启动时读不到实例状态就按退避第 1 档重试（绝不留下「auto 开着却没有定时器」）。
  `restore()` 还没读完落盘时到达的 IPC（开关、立即采样、`exclusive`、`suspendForScript`、派兵记账、改配置、重置）先等它（最多 15 s）；
  读盘只填充还没登记的实例，绝不替换已经在用的运行时（它的 AbortController / 锁深度 / 刚采的样）。

## 门槛与安全

- 视觉工作线程每次输入都经过主进程：**探针门槛之前**只允许白名单恢复动作（`closePopup` 点关闭 ×1、`probeBack` 盲按 BACK ×1、
  `exitCancel` 点「取消」×2、`ensureGame` monkey 拉起、`advise` 问一次未知界面顾问（AI / 游戏更新）×2），其余输入一律拒绝；
  **门槛之后**（恰好一个已知场景锚点、分数 ≥ 0.90 且领先 0.05，游戏在前台，`record.createdAt` 未变）才放开。
  **每次输入前**（白名单动作也算）主进程都复核实例身份（`getState` + `record.createdAt`）与前台包名；门槛之后每次截图前也复核前台。
- 采集一轮开跑前的恢复阶梯（冷启动 → 关弹窗 → 顾问 → 盲按 BACK + 取消退出框）跑完仍过不了门槛时，与原版 G0 一样：留一张
  `g0-failed` 现场截图（主进程按 shotPolicy 落盘并在这一帧上跑顶号探针），这一轮记为 `STEP_FAILED`、`step: 'G0'` 的失败轮，
  而不是笼统的「没能启动」。
- **实例锁就是应用外壳的那一套租约**（不是第二套锁系统）：`InstanceLocks` 在进程内 FIFO 之后拿
  `run/automation-instance-<i>.lock`，写 `owner.json` 标签（`读取部队管理面板` / `自动采集派遣` / `运行采集` / `做健康探针` /
  `exclusive(i, what)` 的 `what`），并在持有期间登记到占用表 `instanceAccess`。所以：
  - 本进程的其他写入者（登录向导、脚本、模板 / 配置编辑、`withInstanceLease` 的新链路）占着实例时，调度器**立刻**以
    `CONCURRENCY_LIMIT`「实例 #N 正在<活动>，<本次动作>稍后再试」让路，不算失败；另一个进程占着时 150 ms 租约超时后同样按标签报；
  - 反过来，它们撞上调度器时也会看到「实例 #N 正在读取部队管理面板」这类带名字的提示；
  - 占用表（生命周期确认、更新闸门 `occupancy.anyBusy()`）经 `registerServiceOccupancy(…, { scheduler: automation.locks })`
    的 `scheduler` 来源看到这些持有者（`blocking: true`）；只开着自动续跑、两轮之间没人拿锁时不算忙。
- **设备通道**（DECISIONS C）：宿主拿到的是 `deviceHost`（车道设备），视觉作业的每个 ADB 调用都在该实例的车道上；
  「复核前台 / 身份 → 输入」「复核前台 → 截图」「截图 + 前台 + pidof（健康探针）」「captureReadOnly / probe 的 前台 → 截图 → 前台」
  都以 `deviceLanes.run(i, …)` 整体执行（`AutomationHostOptions.deviceLane`），中间不会插进别的车道任务（预览、顾问、机器人截图）。
  截图最小间隔 `minCaptureIntervalMs`（应用设置）由车道执行。
- 调度器本身也有一把「单写者」租约 `automation/games/wanlong/eta-scheduler.lock`：第二个进程只读（`readOnly: true`）——不排期、
  不迁移、不落盘；`setAuto(true)`、关闭一个开着的实例、`forget`、`saveConfig`、`sampleNow` 都以 `CONCURRENCY_LIMIT` 拒绝。
  ★ 只读进程每 10 s 重试一次租约：真有另一个窗口时它一退出就接管；崩溃 / 强退 / 退出超时留下的租约心跳停了，30 s 后过期、
  随即被接管（重读落盘状态、迁移、给开着自动的实例重新排期）。只读期间「采集总览」的自动续跑卡片会显示原因
  （IPC `schedulerStatus` + 事件 `scheduler-status`）。
- **首次开启要过只读探针**（DECISIONS C）：`AutomationHost.setSchedule(true)`（IPC 的 `setAutomationSchedule` / `schedulerSetAuto`）
  在主进程再跑一次 `probe()`，`launchReady` 才放行（渲染进程另有确认勾选）。通过记录按「实例身份 + 模板集」记在内存里，
  模板或采集配置一改就作废；之后再开启不必重探（游戏没开也会被冷启动）。恢复路径（告警恢复、机器人）直接调 `eta.setAuto(i, true)`，不过探针。
  开启对话框刚确认过的那次探针可以直接算数：`schedulerSetAuto(g, i, true, { probeCapturedAt })` 带回它的 `capturedAt`，
  主进程只认自己 `probe()` 记下的、同一实例身份与模板集、之后没改过模板 / 配置、5 分钟内的通过记录，否则照旧重探。
- **就绪门槛**（原版 `assertInstanceAutomationReady`）= 账号模块的 `AccountManager.readiness()`，经 `AutomationHostHooks.automationReadiness`
  接入：基础实例（`InstanceProvisioner` 记录的那一个）、登录向导进行中、绑定账号未完成登录检查或实例已被替换时拒绝；未绑定账号的实例放行。
  用户开启（`setSchedule`，在探针之前）、恢复路径（`eta.setAuto(i, true)`）、面板立即刷新、每次采样与每轮开跑前都问它，关闭时从不问。
  ★ 定时唤醒被它拒绝不是失败（原版告警铁律 1）：宿主抛 `AUTOMATION_NOT_READY`，ETA 调度器立即 `setAuto(false, '自动续跑已暂停（不计为失败）：…')`、
  失败计数清零、不留唤醒，落盘后经 `onReadinessPause` → `AutomationHostHooks.onSchedulePause` 记一条「不计为失败」提醒；
  门槛本身出错（账号文件读不出）照常按失败退避。`accountIdOf` 用 `AccountManager.accountForInstance`（同时校验 `binding.index` 与
  `binding.instanceCreatedAt`）。
- **采集配置跟随账号**（DECISIONS B）：`accountGatherConfig` = `AccountManager.gatherConfigFor()`（`scriptParams.gather.configJson`）。
  `AutomationHost.settings()` 与每一轮先读账号那份（`configAccount` 标明是谁的），没有账号 / 账号里没有才用实例文件；
  `saveSettings({ config })` 在有绑定账号时写进账号（`saveAccountGatherConfig`），实例文件不动；绑定时账号模块经
  `instanceGatherConfig`（`AutomationHost.instanceGatherConfig()`）把实例上的配置搬进还没有配置的账号。账号里那份损坏时这一轮失败并说明，
  绝不悄悄换用别的配置；采集配置页照样能打开（显示默认配置并带 `accountConfigError`），重新保存一次就把账号里的那份修好。
  实例文件读不出 / 格式不兼容时同理：页面读 `store.inspect()`（带 `settingsError`、保留还能读出的模板集），带 `config` 的保存会重建它
  （坏文件备份为 `<i>.json.corrupt`）；运行路径仍用严格的 `store.get()`。实例文件里的配置是给已删除的旧 AVD 存的（`configReplaced`）时，
  `gatherConfig()` 抛 `AUTOMATION_NOT_READY` 拒绝开跑（定时唤醒按「不计为失败」暂停），重新保存后才生效 —— 绝不按序号沿用。
- **脚本优先**（DECISIONS A.4）：`PlanHostPort.suspendForScript` = `eta.suspendForScript(i, 计划配置 preemptGraceMs（默认 8 s）, reason)`，
  计划运行与临时运行都在拿租约前调用、结束（成功 / 失败 / 跳过）后在 `finally` 里归还；开着自动采集从不阻止脚本。
- **截图留痕**：采集失败现场跟随应用设置 `shotPolicy`（`AutomationHostHooks.shotPolicy`，原版 `saveAlertShot`）：`never` 不存、`onFail` 只存失败现场、
  `always` 连过程留痕也存；不论哪档，失败那一帧都照样交给顶号探针。
- **模板变更立即失效**：宿主订阅自己的 `onTemplatesChanged`（保存 / 删除 / 导入），立刻让所有视觉 worker 丢弃编译缓存；
  worker 里按 manifest 指纹的比对保留为兜底（别的进程 / tplkit 在盘上改了模板集）。
- 连续 8 次真失败（可配 `maxConsecutiveFailures`）自动暂停并调用 `onScheduleStop` 告警 —— 本仓库原有的安全阀，原版没有。
  这次暂停（以及「需要人工处理」暂停）写进队列视图的 `SchedulerQueueState.pause`（`source: 'scheduler'`），`pauseOf` 钩子
  （告警模块的暂停记录）优先；重启后只剩落盘的失败计数时仍按阈值显示安全暂停。界面只读 `pause`，不再自己镜像阈值。

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
  probeUnrecognizedFrame: async (index, raw, { signal }) => boolean,      // 告警模块的顶号探针，排在 onUnrecognizedFrame 之前（true = 已接管）
  onUnrecognizedFrame: async (index, raw, { signal }) => true | 'recovered' | 'updated' | false,  // AI / 更新
  onMarchGone: (index, gone, at) => stats.record(...),                     // 一趟采集完成（参考指标）
  onAutoChanged: (index, enabled, at, reason) => stats.record(...),        // ★ 暂停 / 恢复事件的唯一来源（只在真的翻转时）
  onNeedsAttention: (index, info) => alerts.raiseNeedsAttention(index, info),  // GAME_UPDATE_REQUIRED / AI_RISK_BLOCKED 的唯一出口
                                                                            // eta.raiseAttention(index, info) 的钩子（到点唤醒、AI 在手动一轮 / 刷新 /
                                                                            // 派兵后校准 / 脚本里都走它）：被 await；告警中心先暂停（记录 → setAuto(false)
                                                                            // → 落盘）再后台推送，已暂停的不重复告警；调度器随后再关一次自动调度兜底
                                                                            // （没人接时：调度器先暂停，再走 AutomationHostHooks.onNeedsAttention 兜底告警）
  pauseOf: (index) => alerts.pauseInfo(index),                             // 队列视图里的暂停原因（记录一变告警模块就调 refreshView(i) 重发）
  log: (level, message) => { ... },
});
// ── accounts / AI / kicked ──（账号部分已在组合根接好）
automation.setPorts({
  accountIdOf: async (i) => (await accounts.accountForInstance('wanlong', i))?.id ?? null,
  accountGatherConfig: (i) => accounts.gatherConfigFor('wanlong', i),             // 采集配置跟随账号（DECISIONS B）
  saveAccountGatherConfig: async (id, config) => { await accounts.saveGatherConfig(id, config); },
  externalBusy,                                                            // 排队中的脚本 / 登录向导（持锁的写入者由租约自己报）
  probeKicked: async (index, raw) => KickedProbeResult | null,             // 失败现场那一帧；模板缺失必须 return null
  adviseUnknownScreen: async (index, raw, attempt, signal) => boolean,     // 采集 G0 盲按 BACK 之前
});
// 就绪门槛不是端口，而是构造钩子 automationReadiness: (g, i) => accounts.readiness(g, i)（+ onSchedulePause 记提醒）
```

钩子由视觉工作线程的消息触发时（`onUnrecognizedFrame` 等），在**这次作业自己的异步上下文**里执行（`AsyncResource`），
与常驻 worker 最早在哪里创建无关：锁内的采样 / 采集里，钩子调 `exclusive()` 一定重入。

采集轮的观察者是 `AutomationHostHooks`，用 `automation.setHooks({...})` 在各模块自己的段落里合并注册（也可以走构造参数）：

```ts
// ── alerts / stats ──
automation.setHooks({
  onCycleResult: async (index, fact, source) => alerts.onCycleResult(index, fact),   // 失败的调度轮往上抛之前报
  onDispatched: (index, records, at) => stats.recordDispatches(index, records, at),  // 每趟派兵（轮次失败也报）
  onNeedsAttention: (gameId, index, info) => alerts.raiseNeedsAttention(index, info), // 兜底：scheduler 的 onNeedsAttention 没人接时
});
```

`onCycleResult` 的 `GatherCycleFact`：outcome / step（`'G0'` = 恢复阶梯用尽，含开跑前的阶梯）/ errorCode / dispatched / captures / shotPath / kicked。
**在失败的调度轮往上抛之前**报；「这一轮压根没跑起来」（开跑前的检查、模板、运行器在出结果前就失败）也补报一次
（`step: null`，message 以「采集流程没能启动：」开头）；取消的轮次、让路（`CONCURRENCY_LIMIT`）、被中止与需要人处理
（`GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED`）都不报。`onDispatched(index, records, at)`：资源 / 坐标 / 等级 / 搜索下限 / 储量 / 行军秒数。

`EtaScheduler` 公共方法：

| 方法 | 说明 |
|---|---|
| `exclusive(i, what, fn({signal}), signal?)` | 借出实例锁（机器人截图、读资源统计、卡死重启、AI 点击）。在钩子里调用时重入；外部占用 / 脚本在跑时抛 `CONCURRENCY_LIMIT`（`what` 进中文提示）。★ `fn` 里绝不能 `setAuto(true)` |
| `suspendForScript(i, graceMs, reason)` | 脚本优先：先等在飞的链路 `graceMs`，再中止并等锁排空（≤5 s）。返回幂等的 `release()`：换新 AbortController，15 s 后「脚本执行结束，重读队列校验」。从不抛 |
| `setAuto(i, enabled, reason?)` | 代数计数 + 就绪门槛（实例在跑、身份、模板、配置、账号）+ 首次只读采样。关闭永远成功且优先（只读进程里关闭开着的实例除外）。不含探针门槛：用户开启走 `AutomationHost.setSchedule`，恢复路径直接调它。★ 只能从 IPC / 锁外调用 |
| `sampleNow(i)` | 面板「立即刷新」，受 `minSampleIntervalMs` 节流，不派兵 |
| `noteDispatch(es)(i, notes, {signal, resample})` | 派兵记账（行军秒数 / 坐标 / 资源），默认之后强制重采一次 |
| `forget(i)` / `cancelWake(i)` / `listWakes()` | 清空记账 / 只取消本次唤醒 / 所有待唤醒 |
| `getConfig()` / `saveConfig(patch)` | 全局 `SchedulerConfig`（原版字段与默认值，`SCHEDULER_CONFIG_RANGE` 夹值） |
| `list()` / `getState(i)` / `isAuto(i)` / `isOperating(i)` | 队列视图 `SchedulerQueueState`（读，不登记实例） |
| `refreshView(i)` | 原样重发一次队列视图（`scheduler-changed`），给由钩子派生的字段用：告警模块写入 / 清除暂停记录后调它，`pause` 不滞后。不登记实例 |
| `setHooks(partial)` / `setQueueFreeHook(fn)` | 合并钩子（传 `undefined` 移除一个）；采集交接 |
| `status()` | `{ owner, message, since }`：本进程是否在管调度（只读时附中文原因）；变化时推 `scheduler-status` |

`AutomationHost` 还提供两个只读识别查询，都用该实例常驻 worker 里**已编译的模板**，不碰设备、不拿锁：

- `recognizeScreen(i, raw, signal?)`：这一帧是不是已知界面（`isRecognizableScreen`；AI 点完复验、卡死恢复等主界面）。
- `matchTemplates(i, raw, templateIds, { threshold?, roi?, signal? })`：按 id 匹配界面模板（顶号探针在失败现场那一帧上）；
  模板集里没有的 id 返回 `found: false`、`reason: '模板缺失'`，从不抛。
- `matchTemplatesIn(i, templateDir, raw, templateIds, options)`：同上，但用指定的模板集目录（AI 模块的脚本链路）。
- `checkGameUpdate(i, templateDir, raw, signal?)`：游戏资源更新弹窗 / 下载进度的判定（查询 `update`，由工作线程里的
  `GameUpdateRecovery` 回答；缺更新模板时回答「没有更新」）。AI 模块据此在主进程驱动更新处理，主线程不跑 OpenCV。
- `frameDiff(i, a, b, refW, refH, signal?)` / `targetStable(i, a, b, box, refW, refH, signal?)`：AI 执行器的画面比较
  （查询 `frameDiff`，两帧一起送过去；点采样灰度循环在 worker 里跑，不占主线程）。
- `admittedIdentity(i)`：该实例上正在跑的采样 / 采集作业开跑时核对过的实例身份（`record.createdAt`），没有作业时为 null；
  作业等待钩子时（AI 恢复）主进程侧只为这台 AVD 动手。

★ 它们是「查询」而不是「作业」：正在跑的采样 / 采集作业等待钩子（`onUnrecognizedFrame`、`adviseUnknownScreen`、`probeKicked`）时，
同一个 worker 照样回答（作业此时停在 await 上），而再开一个作业只会得到 `CONCURRENCY_LIMIT`。作业与同时到达的查询共用一次编译。
worker 按目录缓存最多 3 套编译好的模板集（`compiled-cache.ts`，最久未用的先出），所以脚本执行期间 AI 用脚本模板集查询时，
不会把实例自己那套挤掉、让下一次采样重编。
`invalidateTemplates()`：让所有 worker 丢弃编译缓存。经宿主保存 / 删除 / 导入的模板（包括 AI 自学用的 `saveTemplateToSet`）已经
通过 `onTemplatesChanged` 自动调用；绕过宿主写模板的代码才需要手动调它（manifest 指纹比对是最后的兜底）。

### IPC 与事件

`src/shared/ipc/scheduler.ts`：`schedulerStates / schedulerState / schedulerSample / schedulerSetAuto / schedulerConfig /
saveSchedulerConfig / schedulerWakes / schedulerCancelWake / schedulerForget / schedulerStatus`；事件 `scheduler-changed`（`SchedulerQueueState`）、
`scheduler-config-changed` 与 `scheduler-status`（`SchedulerServiceStatus`：本窗口是否在管调度、只读原因）。旧的 `setAutomationSchedule` / `automationSchedules` / `automation-schedule` 继续可用（经 `ScheduleCompat`）。
渲染进程可用 `@avdm/automation/wanlong/pure` 的 `deriveMarchView` / `formatDuration` / `summarizeQueues` 每秒本地递推倒计时，零 ADB。

### 错误码

`SchedulerError(code, message, detail)`：`CONCURRENCY_LIMIT`（让路，不算失败）、`RUN_ABORTED` / `CANCELLED`（中止）、
`GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED`（需要人处理：暂停、不计失败）、`AUTOMATION_NOT_READY`（就绪门槛拒绝：暂停、不计失败、
不报「运行失败」事实）、`STEP_FAILED`（`detail.step`）、`PROBE_REJECTED`、`DEVICE_NOT_READY`、`TEMPLATE_NOT_FOUND`、`TIMEOUT`。

## 与原版的差异

- 旧版 `AutomationScheduler`（按上一轮结果排下一轮）已删除；`automation/scheduler/wanlong/<i>.json` 在启动时迁移（只继承开关），
  原文件改名为 `.migrated`；它的「门槛拒绝就暂停」规则（`SchedulePauseError` / `pauseReasons`）由 `AUTOMATION_NOT_READY` 在 ETA 调度器上实现。
  脚本计划与自动采集不再互斥，改为 `suspendForScript` 抢占（计划模块的计划运行与临时运行都调用）。
- 健康探针候选以「上次探针时刻」为准（原版在每次采样后都会把探针往后推，队列很少变化时相当于没有探针）。
- `templateSetId` 只做校验（配置了就必须与模板集 id 一致），不做自动挑选；模板集按实例在「模板」页选择。
- 视觉工作线程常驻；hook（AI 问询、等游戏更新）期间暂停作业超时，单次最多 30 分钟，作为「游戏更新时延长一轮超时」的实现。
- 连续失败安全暂停（8 次）是本仓库保留的额外保护。
- 首次开启的探针门槛与「通过记录」是本仓库的加固（原版只在开启时校验账号就绪）。
- 单写者调度租约与只读进程的自动接管是本仓库的加固（原版靠单实例锁）。

## 验证

```
pnpm --filter @avdm/automation exec vitest run test/wanlong-eta-model.test.ts test/wanlong-troop-sampler.test.ts test/wanlong-number-text.test.ts
pnpm --filter @avdm/wanlong-assistant exec vitest run test/eta-scheduler.test.ts test/eta-store.test.ts test/gather-runner.test.ts test/automation-host.test.ts test/vision-pool-context.test.ts test/scheduler-integration.test.ts test/account-readiness.test.ts
WL_FRAMES_DIR=… WL_TEMPLATE_DIR=… pnpm --filter @avdm/automation exec vitest run test/wanlong-replay.test.ts   # 真机帧回放（没有就跳过）
pnpm build:wanlong && packages/cli/node_modules/.bin/tsx apps/wanlong-assistant/scripts/live-sample.ts 0 [--sample]
```
