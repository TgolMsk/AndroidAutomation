# 任务计划、脚本库与脚本执行（`src/main/plans/`）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 计划 / 运行契约；脚本 DSL 类型从 `@avdm/automation/script` 转出 |
| `scripts.ts` | 脚本库：内置示例在前、用户脚本 0600 原子写；只有致命问题拒绝保存，读取时结构错误显示为 ⚠ |
| `store.ts` / `clock.ts` / `legacy.ts` | `plans.json`（含全局并发上限 `maxConcurrentScripts`，默认 4、1–16）、北京时间触发、旧版导入（循环脚本保留循环） |
| `index.ts` | `PlanService`：计划队列与定时触发、**临时运行任意脚本**（`runScript`，账号可选）、暂停 / 继续 / 停止、日志与留痕读取、输入法 |
| `script-runner.ts` | `ScriptRunner`：每次执行一个 `script-worker` 线程；设备 RPC 串行队列、每次输入前复核实例身份 + 账号 + 前台、只允许启动 / 停止本游戏（monkey 拉起并等前台 60 秒）、中文经 ADBKeyboard 广播、停止先礼后兵（10 秒后终止线程）、排空设备队列后才返回（租约不会在迟到的点击之下释放）、AI 求助必答 |
| `script-worker-core.ts` / `script-worker.ts` | 线程内：只编译脚本引用到的模板（缺失 / 无法编译一次列清）、运行 `ScriptEngine`、把一切设备操作与留痕变成请求 |
| `script-protocol.ts` | 主进程 ↔ 线程消息（start → ready → go → … → finished） |
| `run-logs.ts` | `runs/<runId>/events.ndjson` 与 `shots/`：只由主进程写、同文件串行追加、4 MB 尾读、过滤、按运行清理（保留最近 200 次）、路径穿越防护 |
| `ime.ts` | ADBKeyboard 状态检查与安装启用（APK 由用户自己选择，绝不打包） |
| `device-errors.ts` | 设备失败转成可落盘的中文：去掉 adb 命令行与 serial；文本 / 长按只报「输入文本失败（N 字）：原因」 |

规则（原版铁律 + 目标加固）：

1. **OpenCV 与脚本执行不在主线程**：主进程只做编排、校验与落盘。
2. **同一实例同一时刻只有一个写入者**：计划运行、临时运行与输入法安装都持有 `run/automation-instance-<i>.lock`
   （`withLabelledLease`，标签「运行脚本计划 / 运行脚本 / 安装中文输入法」写进 owner.json 并登记进占用表）；
   全局并发撞上限时计划运行**退避重试、不算失败**，临时运行直接给出中文原因。
3. **输入前必校验**：实例被替换 / 账号解绑 / 游戏离开前台 → `ExecutionGuardError`，重试、onFail、AI 都绕不过去。
   以「启动游戏」开头的脚本，或第一步是「如果游戏不在前台 → 启动游戏 …」的脚本（保活巡检写法），
   可以在游戏不在前台时启动（冷启动序章），但照样校验实例身份，之后每次输入照样复核前台。
   **只抓游戏的画面**：截图请求在 screencap 前后各查一次前台，游戏不在前台就拒绝（普通步骤失败，不是 guard ——
   重试与 `onFail: restartApp` 仍能把游戏拉回来），所以留痕截图绝不会存下别的应用、桌面或系统弹窗。
4. **脚本优先于采集**：宿主端口 `suspendForScript`（由调度器接入）会在运行期间借走实例并在结束后归还；
   未接入时，临时运行在该实例开着自动采集调度时拒绝启动。
5. **AI 介入**：线程在步骤重试耗尽后发 `aiConsult`，主进程**总会**回 `aiResult`（180 秒超时、迟到的答复丢弃）。
   默认处理器回「未接入」；AI 模块用 `ScriptRunner.setAiAssist()` 接入真正的顾问。顾问在本次执行的设备队列里跑
   （租约等它），停止 / 超时 / 退出时 `signal` 中止，最多再等 5 秒；引擎在停止时立刻不再等顾问。
6. **留痕策略** `never / onFail / always`：默认取宿主端口 `shotPolicy()`，`src/main/index.ts` 接的是应用设置服务
   （`appSettings.get().shotPolicy`，等设置文件读完再取；端口缺失或出错时「仅失败时留痕」）。
   启动执行弹窗默认「跟随应用设置」，只有用户改过才覆盖。「截图」步骤与 `capture: true` 是明确要求，任何策略下都保存。
   **匹配默认值**：宿主端口 `matchDefaults()`（应用设置的 `matchThreshold` / `shrink`）随每次执行交给线程：没写阈值的模板用
   设置里的默认命中阈值（步骤自己写的阈值仍然优先），帧与模板按设置的倍率降采样；端口缺失或数值非法时用视觉包默认（0.85、1/2）。
   设备调用经 `deviceHost`（DeviceLane），与采集、探针、机器人截图共用每实例的串行通道与最小截图间隔。
7. **整体时限**：引擎自己的 `maxRunMs` 计时（含暂停时间），到点时快照标 `timedOut`：单次脚本记失败；循环脚本本来就只能靠
   停止或时限结束，所以记成功（「按时结束」）。主进程另有兜底（`maxRunMs` + 30 秒），线程卡住 / 设备调用不可打断时先请求停止、
   10 秒后终止线程，结果记为「超过时间上限」的失败（同样 `timedOut`）。**计划运行被时限结束的绝不重试**（原版：计划时限
   停掉的运行不重试），其它失败按 `retry` 在租约内重试。
8. **绝不落盘敏感内容**：设备错误先经 `device-errors.ts` 清洗再交给线程（它会进日志、快照、plans.json 与 AI 求助理由），
   文本步骤的内容与 base64、设备 serial 一律不出现。

给后续模块的接口：

- `ScriptRunner.run(options: ScriptExecuteOptions): Promise<ScriptRunSnapshot>`（`execute` 是同一个方法的旧名）：
  调用方先持有实例租约；脚本失败不抛，看返回快照的 `status` / `error` / `timedOut`。`reserve(index, runId)` 同步占位，
  `runIdOfInstance(index)` / `busyIndices()` / `activeCount()` 供忙碌判断，`pause` / `resume` / `stop(runId)`、`list` / `get`。
- AI：`ScriptRunner.setAiAssist(handler)`，`handler(request: ScriptAiRequest) → Promise<AiAssistResult>`（类型 `ScriptAiAssist`）
  （`{ handled, message?, requiresAttention? }`）；不接时一律 `handled: false`。
- `PlanHostPort.suspendForScript?(gameId, index, reason) → 归还函数`（调度器接）、`shotPolicy?()` 与 `matchDefaults?()`（应用设置）。

没有移植：原版的预览推流（改用模拟器实时画面窗口 LiveView）、MessagePort 直连渲染进程（改为主进程批量推送事件
`plan-run` / `run-logs` / `run-matches`）、模板编辑器的「立即验证」（`detectOnce`，由模板库自己的测试接口承担）。
