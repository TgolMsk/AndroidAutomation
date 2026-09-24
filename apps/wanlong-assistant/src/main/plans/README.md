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

规则（原版铁律 + 目标加固）：

1. **OpenCV 与脚本执行不在主线程**：主进程只做编排、校验与落盘。
2. **同一实例同一时刻只有一个写入者**：计划运行与临时运行都持有 `run/automation-instance-<i>.lock`；
   全局并发撞上限时计划运行**退避重试、不算失败**，临时运行直接给出中文原因。
3. **输入前必校验**：实例被替换 / 账号解绑 / 游戏离开前台 → `ExecutionGuardError`，重试、onFail、AI 都绕不过去。
   以「启动应用」开头的脚本可以在游戏不在前台时启动（冷启动序章），但照样校验实例身份。
4. **脚本优先于采集**：宿主端口 `suspendForScript`（由调度器接入）会在运行期间借走实例并在结束后归还；
   未接入时，临时运行在该实例开着自动采集调度时拒绝启动。
5. **AI 介入**：线程在步骤重试耗尽后发 `aiConsult`，主进程**总会**回 `aiResult`（180 秒超时、迟到的答复丢弃）。
   默认处理器回「未接入」；AI 模块用 `ScriptRunner.setAiAssist()` 接入真正的顾问。
6. **留痕策略** `never / onFail / always`：默认取宿主端口 `shotPolicy()`（应用设置），临时运行可覆盖。

没有移植：原版的预览推流（改用模拟器实时画面窗口 LiveView）、MessagePort 直连渲染进程（改为主进程批量推送事件
`plan-run` / `run-logs` / `run-matches`）、模板编辑器的「立即验证」（`detectOnce`，由模板库自己的测试接口承担）。
