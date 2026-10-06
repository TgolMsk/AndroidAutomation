# 异常告警 / 自动暂停 / 推送 / 卡死看门狗

移植自 wanlong-panel `src/main/alerts/`（`detect.ts` / `kicked.ts` / `center.ts` / `notifier.ts` / `telegram.ts` / `store.ts` /
`freeze.ts` / `freezeRecovery.ts`）、`src/shared/alerts.ts`、`src/main/index.ts` 里的 `tryFreezeRecovery()` 与渲染进程
`features/alerts/`。取代了本仓库原来的 `monitoring/`（只读监控）与 `automation/insights/notifications.ts`（按实例的通知设置）。

用户诉求原话：「设备被顶号了就暂停任务并且推送到 telegram」。

```
shared/alerts.ts            契约：ALERT_TYPES / ALERT_SPECS 单表、事件、渲染（北京时间）、冷却、配置三件套（默认值唯一权威
                            defaultAlertsConfig / normalize / merge / validate）、Token 打码与清洗、Telegram 话术、按钮回调格式
packages/automation/src/wanlong/freeze.ts          FreezeGuard：帧指纹、完整 / 降档两道门槛、重启熔断（纯逻辑，原样移植）
packages/automation/src/wanlong/freezeRecovery.ts  recoverFrozenInstance：7 步恢复流程（纯逻辑 + io 注入）
packages/automation/src/wanlong/gameRestart.ts     restartStuckGame：先查顶号 → force-stop → monkey → 等主界面（只重启游戏）
src/main/alerts/
  detect.ts           FailureTracker：只数数（真失败轮 / 恢复阶梯用尽 / 采样失败 / 长时间派不出队）→ 事件或 null
  kicked.ts           第二层：预留模板（tpl_dlg_kicked / tpl_login_screen / tpl_dlg_maintenance / tpl_dlg_update）单帧匹配；
                      模板缺失 → null，静默降级，绝不抛
  center.ts           AlertCenter：只做动作 —— 先暂停（setAuto(false)）→ 落盘 → 推界面 → 交给推送 → 回填推送结果 / 历史 / 日账
  records.ts          automation/wanlong/{alerts-pauses.json, alerts-history.json}（容错读、文件锁 + 串行原子写）
  notifier.ts         NotifyHub：配置 + 三道闸（开关 → 订阅 → 冷却）+ 冷却去重与「期间还发生过 N 次」；不认识「暂停」
  telegram.ts         一条通道：sendMessage / sendPhoto（FormData）、重试分类、429 retry_after、Token 清洗
  local.ts            本机通知（macOS 通知中心；本仓库新增的第二通道）
  store.ts            automation/alerts/{config.json, throttle.json}；Token 只存 safeStorage 密文；旧 notifications.json 一次性迁移
  freeze-controller.ts 卡死看门狗接线：三个触发点、默认只告警、开启后在 exclusive() 内重启、熔断转掉线暂停
  screen-watch.ts     画面巡检：自动调度中的实例每分钟自己截一帧喂给看门狗（经 exclusive() 进锁），按完整阈值判定
  freeze-io.ts        FreezeRecoveryIo 的 @avdm/core 实现（stop force → start → getState → device → monkey）
  game-restart.ts     「异常时自动重启游戏」：GameRestartController（前置条件、exclusive 内重启、预算窗口、结论）与
                      GameRestartIo 的 @avdm/core 实现（只 force-stop / monkey 游戏自己的包）
  index.ts            AlertsService：组合上面这些，给出调度器钩子 schedulerHooks() 与宿主钩子 hostHooks()
src/main/ipc/alerts.ts                  alerts 域 IPC
src/renderer/state/alerts.ts            渲染进程告警 store（配置视图 / 暂停态 / 历史）
src/renderer/views/alerts/              PauseBanner / PausedInstancesStrip / 设置页「通知与推送」卡片 / 表单纯函数
```

## 铁律（与原版一致）

1. **`queueFull` / `noResourceWanted` / `giveUp` / `staminaLow` / `circuitBroken` 不是失败，还要清零计数。** 调度器的退避步数在 5/5
   挂机稳态下也会涨，拿它判故障必然误报，所以 `detect.ts` 另有一套只数真失败的计数器。
2. **暂停 = `EtaScheduler.setAuto(i, false)`**：它中止在飞的采样 / 采集、取消唤醒、清 `nextWakeAt`、落盘、推 `scheduler-changed`，
   而且不抢实例锁，可以在锁内的钩子里调。暂停之后没有任何路径会再 rearm。
   ★ 调度器的队列视图经 `pauseOf` → `AlertCenter.pauseInfo()` 带出暂停原因：暂停记录**先**写进内存再 `setAuto(false)`（它会发布视图），
   失败就回滚；此后每次暂停记录变化（推送结果回填、恢复、实例被替换作废）都调 `EtaScheduler.refreshView(i)` 重发一次，
   发布出去的 `pause` 永远与暂停记录一致。
3. **先暂停，再推送。** 锁内的钩子用 `raiseInLock()`：只 await 暂停这一步，推送在后台跑（最长一分钟的网络请求不占设备锁）。
   推送的一切异常都吞掉，**推送失败绝不影响暂停**；失败原因（已清洗）写进暂停态，横幅上看得到。
4. **`resume()` 只能从 IPC / 机器人调，绝不能在锁内调**：`setAuto(true)` 会采样、要抢锁。恢复先清暂停态、清失败计数与卡死证据、
   清该实例在各通道的推送冷却，再 `setAuto(true)`，最后补一条 `instanceResumed` 闭环通知。
   ★ 只恢复告警关掉的：实例没有生效中的暂停（或暂停属于已被删除 / 重建的 AVD）就用中文拒绝 —— 这条路绕过了宿主「首次开启要先过
   只读探针并确认」的门槛，只能把告警关掉的再打开（与原版的差异，见下表）。
5. **`onCycleResult` 在失败轮往上抛之前调用**（宿主钩子，锁内），`step === 'G0'` 就是「恢复阶梯用尽」。只数调度轮；手动轮由用户看着。
6. **默认值只有一份权威：`defaultAlertsConfig()`。** 主进程、渲染进程、测试都 import 它；设置页的上下限来自 `ALERT_RANGE`。
7. **「需要人处理」只有一个出口**（`GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED`）：调度器自己的到点唤醒，与 AI 执行器在采集 G0 /
   采样（含手动刷新、派兵后校准）/ 脚本里的判定，都走 `EtaScheduler.raiseAttention` → 钩子 `raiseNeedsAttention()`：告警中心先暂停
   （记录 → `setAuto(false)` → 落盘，自动暂停开关关着也暂停），再后台推送；已暂停或同一实例正在暂停途中就不再告警 —— 一段异常一条告警
   （原版 `!alertCenter.isPaused(i)`）。被暂停的实例 AI 执行器一律不碰（`AiRecoveryService` 的 `paused` 端口）。
   采样认不出界面时顺序同原版：本模块的顶号 / 维护探针（`probeUnrecognizedFrame`）先在同一帧上跑，命中即接管，AI 不再被问。
8. **卡死 ≠ 掉线**：画面纹丝不动 / 截图一直失败、但实例进程还在 → 判卡死。三个触发点都在调度器的实例锁内：
   - 健康探针：完整阈值 `freezeMinutes`；
   - 画面巡检（`screen-watch.ts`）：完整阈值，自动调度中的实例每分钟截一帧，游戏在前台才看；本进程持有调度器时才巡检；
     脚本、登录占着实例，或实例已暂停、正在恢复时跳过；
   - 「连续采样失败、马上要按掉线暂停」：降档门槛。

   巡检补的是调度器看不到画面的时段：采样失败后退避唤醒不排健康探针。2026-09-25 那次渲染线程卡死
   （GuestAngle fence fd 泄漏，无 ANR）就是等到第 3 次采样失败，13 分钟后才判出来，而且是暂停，没有重启游戏。

   重启命令一下发就 `noteRestart()`（失败的也算），窗口内超过 `freezeRestartLimit` 次 → 转「模拟器或游戏掉线」暂停。
   恢复流程接 AbortSignal（自动调度关掉 / 助手退出）。
9. **被顶号 → 关闭模拟器**（用户诉求「账号被挤（关闭该模拟器）」；设置 `detect.stopOnKicked`「被顶号时关闭模拟器」，**默认开**）：
   `suspectedKicked` 一旦判定，照常**先暂停、再推送**，然后后台对这台实例做一次**正常关机**（端口 `stopInstance` = core `stop(i)`，
   保存 Quick Boot 快照，再丢掉这次开机的设备通道）；关机不在实例锁的 await 链里（最长约一分钟），实例已暂停，期间没有自动流程碰它。
   同一实例同一时刻只关一次，推送与历史的 `detail.模拟器` 写明「随后自动关闭」。判定来源：
   - 采样认不出的帧 / 健康探针帧 / 采集失败现场上的顶号模板（原有三条），**手动「运行一轮」的失败现场也算**（只有顶号，其它手动失败仍不计）；
   - **脚本失败后**再截一帧跑一次顶号探针（`probeAfterScript`，脚本自己没有探针）；
   - 「自动处理」开着时 **AI 把画面认成「被顶号」**（置信度不低于 AI 设置的下限）：AI 执行器不点、不按 BACK，经 `AiAttentionInfo.screen`
     交给 `raiseKickedByAi`，与模板判定同一结论（即使「自动暂停」关着也暂停）。「自动处理」关着时 AI 只记建议，不产生这个判定。
   维护 / 强制更新（`needsAttention`）只暂停，不关模拟器；AI 处理不了的其它异常用「模拟器实例」行上的「重启游戏」（`AutomationHost.restartGame`）。
   恢复前要先把实例重新启动并登录（恢复会打开自动调度，没开机会被拒）。
10. **不是顶号的异常 → 先重启游戏**（用户诉求「当出现非挤号情况自动重启应用」；设置 `detect.gameRestartEnabled`
   「异常时自动重启游戏（顶号除外）」，**默认开**，端口 `gameRestartIo` 没接时整条不生效）：模拟器还在、只是游戏坏了时，
   在原本要暂停的地方先强制停止游戏、monkey 重新拉起、等主界面，成了就推一条「游戏异常已自动重启」（warning，不暂停），
   清零失败计数与卡死证据，自动调度照跑。触发点（都在实例锁内，`exclusive()` 重入）：
   - 连续采样失败到阈值（先问卡死看门狗，再重启游戏，最后才按掉线暂停）；
   - 调度轮连续失败 / 恢复阶梯用尽（`fact.kicked` 为空的那两类；第二层命中的维护 / 更新仍直接暂停）；
   - 健康探针发现游戏进程已退出；画面长时间不动且「卡死自动重启」关着（FreezeController 端口 `restartGame`，先于「疑似模拟器卡死」）；
   - 系统的「应用无响应」/「已停止运行」弹窗是游戏的（端口 `appDialogOf` = `AdbDevice.appDialog()`，采样失败与健康探针时看）：
     **立刻**重启，不等阈值 —— 2026-09-24 那次 ANR（GuestAngle 下 gfxstream 驱动死锁）不管它就一直空转了四小时。
   ★ 绝不在顶号画面上重启：动手前截一帧跑第二层识别（顶号框 / 登录页 / 维护 / 更新），命中就不重启、不计次，按该结论处理
   （顶号 = 暂停 + 关模拟器）；重启后等满时限仍认不出主界面时，最后一帧再查一次。人工处理类（`GAME_UPDATE_REQUIRED` /
   `AI_RISK_BLOCKED`）、就绪门槛、调度器 8 次安全阀、手动轮都不重启。
   ★ 预算：`gameRestartLimit` 次 / `gameRestartWindowMin` 分钟（默认 3 次 / 60 分钟），下发即计次（失败的也算）；超出或重启失败
   就按原规则暂停，原因后面带上「已自动重启游戏，但没能恢复（卡在：…）」或「… 分钟内已自动重启游戏 N 次」。

## ★★ 凭据

- Bot Token 只以 **safeStorage 密文**存在 `automation/alerts/config.json`（原版是明文 `alerts.json`；这里沿用本仓库的钥匙串加固）。
- 过 IPC 只送 `toAlertsConfigView()`（类型上就没有 `botToken` 键，打码为全遮 `••••••••`，连后 4 位都不给）。
- 写日志只写 `redactAlertsConfig()`；每一处 `catch` 先 `scrubSecret(describeThrown(e), token)`；抓异常只取 message + cause，不取 stack。
- 明文 Token 只有 `NotifyHub.currentTelegramConfig()` / `readOnlyBotConfig()` 两个出口，仅限主进程使用；机器人模块
  （`src/main/bot`）读 `currentTelegramConfig()`，按两个开关各管各的动作：查看类只看「允许手机查看状态与截图」，操作类只看
  「允许手机远程操作」，远程操作开关绝不顺带打开 /status、/shot。
- 改完推送相关代码必须跑 `test/alerts-telegram.test.ts`（含泄露实测：URL 塞进 message / cause / stack / 响应体 / 断流，扫结果、日志、视图、磁盘上每个文件）。

## 与原版的差异（及原因）

| 项 | 原版 | 这里 | 原因 |
|---|---|---|---|
| 卡死自动重启 | 默认开 | `freezeRestartEnabled` 默认**关**，关着时只推「疑似模拟器卡死」（每段卡死一次），采样连续失败仍按掉线暂停 | DECISIONS A.3：动模拟器的自动化必须显式开启 |
| 远程控制按钮 | 默认开 | `remoteControlEnabled` / `remoteReadOnlyEnabled` 默认关，需授权用户 ID；各管各的（远程操作开关不会放行查看类动作）；按钮只在机器人正在运行时才附加（机器人启动 / 停止时调 `hub.setRemoteControlHandler(running)`），且只附加开关允许的那几个：「恢复 / 重启游戏」要远程操作，「查看状态」要查看开关 | DECISIONS A.3；没人处理的按钮在手机上会一直转圈 |
| 恢复 | 任何实例都能 `resume` | 只恢复生效中的暂停，其余用中文拒绝 | 首次开启自动调度要走宿主的只读探针 + 确认门槛（DECISIONS C） |
| 重启方式 | MuMu `control restart` / 雷电 `quit+launch` | `stop({ force: true })` + `start()`（SIGKILL 保留快照失效标记 → 冷启动） | DECISIONS C：Android Emulator 的 Quick Boot 会把卡住的现场存进快照 |
| Token 存储 / 打码 | 明文 alerts.json / 显示后 4 位 | safeStorage 密文 / 全遮 | 本仓库原有的钥匙串加固，不回退 |
| 顶号探针 | 失败现场 + 可能再截一帧 | 只用已经截到的那一帧（失败现场、采样认不出的帧、健康探针帧），分数下限 `max(0.92, 模板阈值)`；只有脚本失败后会专门再截一帧 | 零额外截图；沿用本仓库原监控的安全下限；脚本没有自己的探针 |
| 被顶号之后 | 暂停 + 推送 | 暂停 + 推送 + 关闭该模拟器（`stopOnKicked`，默认开，可关） | 用户诉求：被挤下线的号不要反复重连把另一台设备挤掉 |
| 非顶号异常 | 暂停 + 推送（重启游戏靠机器人按钮） | 先自动重启游戏（`gameRestartEnabled`，默认开，3 次 / 60 分钟），不行才暂停；系统「应用无响应」立刻重启 | 用户诉求「当出现非挤号情况自动重启应用」 |
| 通道 | 只有 Telegram | Telegram + 本机通知（两通道各自冷却键 `channel|实例:类型`） | 本仓库原有本机通知；本机成功不能吞掉 Telegram 的重试 |
| 历史 | 内存 | `automation/wanlong/alerts-history.json`（≤100 条），并写入统计日账 | 重启后仍能看最近告警 |
| 日账里的运行失败 | 只在达到阈值时告警 | 同原版：失败的运行只记成当天的 `failed` 周期，不再写 `runFailed` 告警行（旧日文件里的仍可读） | 「告警记录」与每日告警数只含真正的告警结论 |
| 暂停类型 | — | 新增 `schedulePaused`（就绪门槛拒绝）、调度器 8 次真失败安全阀映射为 `consecutiveFailures` | 本仓库原有的两个暂停来源，统一进暂停横幅 |
| 开关 | 可无凭据打开 | 开 Telegram / 机器人前必须凭据齐全，清除 Token 同时关掉所有依赖它的开关 | 本仓库原有规则 |
| 暂停时的开关 | — | 暂停中的实例拒绝手动开启自动调度（提示去横幅点「恢复」） | 恢复要同时清计数与冷却，只有一条路 |
| 旧设置 | — | `automation/insights/notifications.json`（按实例）一次性迁移为全局设置，密文原样保留，旧文件改名 `.migrated` | 数据迁移 |

旧 IPC（`getNotificationConfig` / `saveNotificationConfig` / `testNotification` / `remoteBotConfig` / `saveRemoteBotConfig`）
仍可用，改由 `NotifyHub` 的兼容适配器实现（设置已是全局的，按实例的补丁作用于所有实例）。

## 给后续模块的接口

- IPC（`shared/ipc/alerts.ts`）：`alertsConfig` / `saveAlertsConfig(patch)` / `testAlertPush(channel)` / `alertPauses` /
  `resumeAlertPause(index)` / `alertHistory(limit?)` / `alertScreenshot(shotPath)` / `freezeStatus`；
  事件 `alert-pause-changed` / `alert-raised` / `alert-config-changed`。
- 渲染进程：`useAlerts()` / `usePause(index)` / `resumePause(index)`（`state/alerts.ts`），组件 `PauseBanner` / `PausedInstancesStrip`
  （`views/alerts/PauseBanner.tsx`），外壳徽标 `PausedInstancesBadge`。红色状态只看 `pause.paused === true`，绝不看 `!auto`。
- 机器人模块：`AlertsService.resume(i)`（锁外；没有生效中的暂停会抛中文错误）、`hub.currentTelegramConfig()`、
  `hub.telegramChannel().sendPhoto/sendText`、回调数据 `alertCallbackData` / `parseAlertCallbackData`（`resume:0` / `relaunch:0` /
  `status:0`，与原版 `bot.ts` 相同）。★ 开始处理 `callback_query` 时调 `hub.setRemoteControlHandler(true)`（停止时 false），
  告警消息才会附加按钮，设置页的「机器人模块接入后生效」标注也随之去掉（配置视图的 `remoteControlAvailable`）。
  ★ 这一步只推视图（端口 `onViewChanged`），不算「配置已保存」：`onConfigChanged`（监听与端口）只在 `saveConfig` 成功后触发，
  机器人按它重载。把机器人的启停接回 `onConfigChanged` 会变成「启停 → 重启 → 启停」的死循环。
- 调度器 / 采集界面：暂停记录是唯一来源 —— 调度器自己的安全暂停、「需要人工处理」暂停与就绪门槛暂停都记成暂停记录，
  队列视图的 `pause`（`SchedulerQueueState.pause`）只经 `pauseOf` 镜像它（见铁律 2），调度器不另记一份。采集总览的红框卡片、
  实例页的红色行、诊断角标（完整 `PauseBanner`）、批量采集的跳过规则都直接读 `useAlerts()` / `pauseOf()`，「恢复」走 `resumePause(i)`。
  「需要人工介入」的 `detail.阶段` 用 `ATTENTION_STAGE` / `attentionStageOf()`（`shared/alerts.ts`，AI 执行器同用一份），
  `pauseTitle()` 把它带进状态行；AI 风险暂停（`isAiAttentionPause`）的横幅上有「查看 AI 处理记录」。
- 统计模块：暂停 / 恢复事件仍只从 `SchedulerHooks.onAutoChanged` 来；告警写进日账走 `ledgerAlertOf()` → `InsightsService.recordAlert()`，新写入的一条再经 `insights.onAlertStored` 计入数据统计的「告警」数（按 id 只数一次）。

## 验证

```bash
pnpm --filter @avdm/wanlong-assistant exec vitest run test/alerts-contract.test.ts test/alerts-telegram.test.ts \
  test/alerts-e2e.test.ts test/freeze-controller.test.ts test/alerts-view.test.ts test/game-restart.test.ts \
  test/alerts-game-restart.test.ts test/screen-watch.test.ts
pnpm --filter ./packages/automation exec vitest run test/wanlong-freeze.test.ts test/wanlong-game-restart.test.ts

# ★ 真机：会真的强制重启实例并重新拉起游戏（5 秒倒计时，Ctrl+C 取消）。测试绝不跑它。
pnpm build:wanlong && packages/cli/node_modules/.bin/tsx apps/wanlong-assistant/scripts/freeze-live.ts 0
```
