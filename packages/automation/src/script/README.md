# 脚本 DSL 与执行引擎（`src/script/`）

移植自 wanlong-panel 的 `src/shared/script.ts`、`src/main/store/scripts.ts`（静态校验）、`src/scripts/builtin.ts` 与
`src/worker/{engine,actions,conditions,context,logger}.ts`。**与具体游戏无关**：游戏逻辑只能写进模板和步骤，不许为某个游戏加步骤类型。

| 文件 | 内容 | 出口 |
| --- | --- | --- |
| `types.ts` | 16 种步骤、8 种条件、失败处置、参数定义、运行快照 / 统计、日志、AI 求助契约 | `@avdm/automation/script`（纯） |
| `validate.ts` | 静态体检：致命错误（拒绝保存 / 读取）/ 普通错误（可存草稿、拒绝执行）/ 警告；`countSteps`、`referencedTemplateIds`、`startsWithLaunch` | 纯 |
| `interpolate.ts` | `{{ key }}`（括号内可有空格，未知键原样保留）；`mergeParams`（脚本默认 < 账号 < 任务 < 临时请求） | 纯 |
| `describe.ts` | `describeCondition` / `describeRect` 中文摘要 | 纯 |
| `builtin.ts` | 两个只读示例（`builtin_` 前缀保留），按当前游戏包名生成 | 纯 |
| `context.ts` | `ScriptContext`：取帧（最小间隔 400ms + 0–120ms 抖动、同帧复用、并发共享、输入后作废）、三套坐标、模板匹配、前台 1 秒缓存、留痕、状态节流（≤4 次/秒）、匹配调试（≤3 批/秒） | 包根 |
| `conditions.ts` / `actions.ts` | 同一帧上的条件求值（带中文原因）；动作原语（长按=一次 shell 的 motionevent，中文走端口的 inputText） | 包根 |
| `engine.ts` | `ScriptEngine`：控制流不进重试 / onFail、嵌套失败终止整次运行、goto / loop 超限即失败、每块 20 万次、restartApp ≤10、步骤超时（超时的尝试不会再发输入）、脚本级循环、暂停在步骤边界、`maxRunMs`、`ExecutionGuardError` 绕过一切处置 | 包根 |
| `logger.ts` | `RunLogger`：100ms 一批，缓冲上限 4000，溢出只报一次 | 包根 |
| `shots.ts` | 留痕 = 最近一帧编码 JPEG（1280 宽 q72），绝不 `screencap -p` | 包根 |

边界：引擎只认识 `ScriptDevicePort` / `ScriptVisionPort` / `ScriptShotPort` 三个端口，不碰 adb、不写文件。
宿主（万龙助手的 `script-runner.ts`）负责设备、前台与身份校验、租约和落盘。
`@avdm/automation/script` 入口会被渲染进程引用，**不得**引入 sharp / OpenCV / Node 内置模块（`test/pure-entries.test.ts` 把关）。
