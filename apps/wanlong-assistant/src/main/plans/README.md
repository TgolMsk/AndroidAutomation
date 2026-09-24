# 任务计划、脚本库与脚本执行（`src/main/plans/`）

| 文件 | 职责 |
| --- | --- |
| `../../shared/plan.ts` | **计划契约与唯一一份计划规则**（主进程与渲染进程共用）：`TaskTrigger` / `PlanTask` / `AccountPlan` / `PlanConfig` / `TaskRuntime` / `PlanRun` / `PlanTaskState` / `PlanQueueView` / `PlanOverview`，`describeTrigger`、`dueReason`、`lastRunAtOf`、`defaultPlanConfig`、`PLAN_RANGE`、`clampToRange`、`mergePlanConfig`、`emptyTask`、`PLAN_PHASE_TEXT`、容错的 `sanitize*`；北京时间函数（`nextFireAt` / `previousFireAt` / `inClockWindow` …）来自 `shared/time.ts` |
| `types.ts` | 主进程侧类型（脚本执行、宿主端口 `PlanHostPort`）；计划契约从 `shared/plan.ts` 转出 |
| `store.ts` | `plans.json`：写入严格校验、0600 原子写、跨进程文件锁；**读取容错**（坏 JSON / 越界字段按原版逐项修复，原文件在下一次写入前备份为 `plans.json.corrupt-<时间>`，中文说明经 `warnings()` 与 `PlanOverview.warnings` 给到页面）；认领、开关、删任务、运行记录与记账 |
| `clock.ts` | 落盘前的严格时刻检查（不许首尾空格）；触发计算不在这里 |
| `legacy.ts` | 旧版（wanlong-panel）脚本与 `plans.json` 的**显式**导入：按原版容错规则清洗（坏的「每天」→ 仅手动、上限夹回 0–720、id 不合规的换新 id），导入的账号计划默认关闭，不导入运行次数 |
| `scripts.ts` | 脚本库：内置示例在前、用户脚本 0600 原子写；只有致命问题拒绝保存，读取时结构错误显示为 ⚠ |
| `index.ts` | `PlanService`：计划队列与定时触发、抢占采集、重试、开关、概览；**临时运行任意脚本**（`runScript`）、暂停 / 继续 / 停止、日志与留痕读取、输入法 |
| `script-runner.ts` | `ScriptRunner`：每次执行一个 `script-worker` 线程；设备 RPC 串行队列、每次输入前复核实例身份 + 账号 + 前台、只允许启动 / 停止本游戏、中文经 ADBKeyboard 广播、停止先礼后兵（10 秒后终止线程）、时间上限的主进程兜底、AI 求助必答 |
| `script-worker-core.ts` / `script-worker.ts` / `script-protocol.ts` | 线程内执行与主进程 ↔ 线程消息 |
| `run-logs.ts` / `ime.ts` / `device-errors.ts` | 运行日志与留痕、ADBKeyboard、设备错误脱敏 |

## 计划的规则（原版铁律 + 目标加固）

1. **★ 脚本优先级最高**（原版铁律 1，DECISIONS A.4）：计划运行（含「立即运行」与失败重试）与临时运行在拿实例租约**之前**调用
   `PlanHostPort.suspendForScript(gameId, i, reason, graceMs)`，组合根接 `EtaScheduler.suspendForScript(i, preemptGraceMs, reason)`：
   先等在飞的采样 / 派遣 `preemptGraceMs`（计划设置「抢占宽限」，默认 8 秒，0–120 秒），还不让开就中止；运行结束（成功 / 失败 /
   跳过 / 取消）后在 `finally` 里归还，调度器 15 秒后重读队列。让路失败绝不挡住脚本。开着自动采集从不阻止脚本（不再互斥）。
2. **每实例串行 + 全局上限**：每实例一条队列（优先级大的先、同优先级按入队先后），同一时刻只发一个；同一任务不会重复入队
   （「立即运行」重复点会得到「已经在队列里了」）。`maxConcurrentScripts`（默认 4，1–16，采集不计入）撞上时**原地排队、15 秒后
   再试**，不算执行、不算失败、也不会先去抢采集。
3. **等不到就跳过**（原版铁律 3）：排队超过 `queueWaitMs` 的等待项由每次评估扫掉，记「已跳过」（「等了 N 分钟仍没轮到（实例一直忙），
   这一轮跳过。」）；等租约只用剩下的排队预算，不会等两倍。出队后还在等租约的一轮仍显示「排队中」（排在队列视图的等待首位），
   拿到租约才算「执行中」。等租约分片轮询（每片 250 ms）并检查这一轮的 AbortSignal：「停止」「删除任务」、关掉开关（与排队项一样
   出队并释放认领）和退出助手都在一片之内返回，不会被登录 / 手动采集 / 别的进程占着实例而卡到排队预算用完（core 的文件锁不收
   signal）；等采集让路（`suspendForScript`）同样随时可中止，中止后才迟到的让路会立刻归还。已拿到租约的脚本不受开关影响（原版）。
4. **时间一律北京时间，只有一份实现**：`dueReason` / `nextFireAt` / `previousFireAt` 在 `shared/`，主进程排定时器（最早到点或重试
   保持时刻，1–60 秒）与页面「下次运行」倒计时用同一套函数。
   - 每天：错过的时刻在 `catchUpMs` 内补一次，更早的直接丢掉（开机不会一股脑放出一天的任务）。
   - 按间隔：从没跑过立刻跑；过期**只补一次**（补跑窗口不适用于间隔任务——旧版目标会因此永久卡住）；限时段外推到下一个时段起点。
   - 基准时刻 = max(这一轮的认领时刻, 上次开始时刻)：认领在执行前就落盘（★ 铁律 5，重启不重跑），手动运行也会推后间隔。
   - 开关关掉而出队的一轮会释放认领，重新打开后照原版规则仍可补跑；用户手动「停止」排队的一轮不释放。
   - 认领落盘期间同一任务被「立即运行」抢先入队：这条认领记录当场记「已取消」（「同一任务已在队列里」）并释放认领，不会留下一条
     永远「排队中」的记录；认领期间开始退出则按退出时的排队项记「已跳过」。
5. **跳过 / 失败 / 重试按类型判定，不看文案**：
   - 执行前的「现在没法跑」→ 已跳过、不重试、不计失败：任务已删、账号删除 / 停用 / 未登录 / 解绑 / 换了实例、实例未运行或被替换、
     游戏不在前台（脚本不以「启动游戏」开头时）、等租约超时、`@avdm/core` 的 `INSTANCE_NOT_FOUND / INSTANCE_NOT_RUNNING /
     BOOT_TIMEOUT / ADMISSION_DENIED / ADB_MISSING / LOCK_TIMEOUT / COMMAND_FAILED`，以及执行器在任何输入前拒绝启动（`failureCode:
     'START_CHECK'`）。
   - 脚本读不出 / 校验不过 → 失败，不重试（重试也一样过不去）。
   - 运行中被安全检查拦下（`GUARD`）、AI 判定需要人处理（`AI_RISK_BLOCKED`，含游戏更新）、被时间上限停掉（`timedOut`）→ 失败，**不重试**。
   - 用户停止 / 助手退出 → 已取消，不重试，不计失败。
   - 其它失败 → 失败，按 `retry`（默认 1 次，0–5）重试：**先释放实例与采集**，等 `retryDelayMs`（最少 200 毫秒）后作为同一轮的
     新一次尝试（`PlanRun.attempt`）重新排队；每次失败都计入 `fails`。等待中的重试显示在「下次运行」，停止 / 关开关会撤销它。
6. **时间上限**：`maxRunMinutes` 0–720（0 = 不限）。引擎自己按时结束；主进程兜底在上限 + 30 秒时请求停止、再 10 秒终止线程
   （即使设备调用卡住）；循环脚本跑满上限算「按时结束」的成功。
7. **参数合并**：脚本默认 < 账号的 `scriptParams[scriptId]` < 任务 `params` < 临时运行请求。
8. **AI 介入**：计划设置 `aiAssist`（默认开，原版）随每次运行交给执行器（关掉时步骤失败不再问 AI）；组合根把
   `ScriptRunner.setAiAssist` 接到 AI 模块的 `AiRecoveryService.assistScript`，它在每次求助时再读一次
   `PlanService.aiAssistEnabled(gameId)`（运行中关掉也立即生效，原版 `getConfig().aiAssist`）；是否真的动手由 AI 模块决定
   （AI 顾问启用且允许自动处理；被告警暂停的实例不碰）。AI 判定需要人处理（含游戏更新）时，告警模块先暂停该实例再推送一次
   （与采集链路同一个出口 `EtaScheduler.raiseAttention`），这一轮记失败（`AI_RISK_BLOCKED`）、不重试；计划的跳过 / 失败本身
   不产生告警，也不计入采集的失败统计（原版同样只按采集轮判异常）。
9. **开关即时生效**：总开关关 → 只剩「立即运行」，已排队的定时轮次与其重试出队；账号开关 / 任务勾选框关 → 该账号 / 任务的排队项
   立即出队（正在跑的不打断，用「停止」）。整份保存计划时，被删除或关掉的任务同样出队。
10. **容错读取绝不挡住启动**：`restore()` 里各服务各自启动；`plans.json` 损坏时照常启动并在页面顶部说明。符号链接等非普通文件仍拒绝读取。

## 执行（脚本引擎模块已有，保持不变）

- **OpenCV 与脚本执行不在主线程**；同一实例同一时刻只有一个写入者：计划运行、临时运行与输入法安装都持有
  `run/automation-instance-<i>.lock`（`withLabelledLease`，标签「运行脚本计划 / 运行脚本 / 安装中文输入法」）。
- **输入前必校验**：实例被替换 / 账号解绑 / 游戏离开前台 → `ExecutionGuardError`，重试、onFail、AI 都绕不过去；以「启动游戏」开头的
  脚本可以在游戏不在前台时启动（冷启动序章）。只抓游戏自己的画面。
- **留痕策略** `never / onFail / always` 与匹配默认值取应用设置；「截图」步骤与 `capture: true` 任何策略下都保存。
- **绝不落盘敏感内容**：设备错误先经 `device-errors.ts` 清洗；文本步骤内容与 serial 一律不出现。

## 给后续模块的接口

- IPC（`src/shared/ipc/plans.ts`）：`planOverview`（含 `tasks` / `queues` / `warnings` / `contended`）、`planGet`、`planSave`、
  `planSetTaskEnabled`、`planSetAccountEnabled`、`planRunNow`、`planCancel`（按任务）、`planCancelRun`（按运行 id）、`planRemoveTask`、
  `planConfig`、`planSaveConfig`；事件 `plan-changed`（`PlanOverview`，带 `gameId`）、`plan-config-changed`（`{ gameId, config }`），
  运行记录仍走 `plan-run`。
- 主进程：`PlanService.aiAssistEnabled(gameId)`、`config(gameId)`、`isActiveForInstance(i)`、`runIdOfInstance(i)`、
  `hasEnabledPlanForInstance(gameId, i)`；宿主端口 `PlanHostPort.onChanged` / `onConfigChanged` / `suspendForScript(gameId, i, reason, graceMs)`。
- `ScriptRunner.run(options)`：调用方先持有实例租约；脚本失败不抛，看返回快照的 `status` / `error` / `timedOut` / `failureCode`。
  `reserve(index, runId)` 同步占位；AI：`ScriptRunner.setAiAssist(handler)`；每次运行的 `aiAssist: false` 让线程不再求助。
- 渲染进程：`src/renderer/views/plans/`（`PlansView` 页面、`TaskDialog`、`PlanConfigDialog`、`LegacyPlanImport`、纯函数 `plans-model.ts`）。

没有移植：原版的预览推流（改用模拟器实时画面窗口 LiveView）、MessagePort 直连渲染进程（改为主进程批量推送事件
`plan-run` / `run-logs` / `run-matches`）、模板编辑器的「立即验证」（由模板库自己的测试接口承担）。
原来的 `views/automation/PlanPanel.tsx`（按账号的计划编辑器 + 脚本库）已删除：脚本库是「脚本」页的可视化块编辑器
（`views/scripts/ScriptsView.tsx`），计划界面只有「任务计划」页一份实现（`describeTrigger` / `PLAN_RANGE` / `formatCst` 都来自 `shared/`）。
