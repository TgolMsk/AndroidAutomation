# 万龙助手 IPC 契约（按领域拆分）

`src/shared/ipc.ts` 只做聚合；每个领域一个文件，只放类型与常量（主进程、预加载、渲染进程共用，不得有运行期副作用）。

| 文件 | 领域 | 主进程处理器 |
| --- | --- | --- |
| `automation.ts` | 游戏目录、每实例采集设置、只读探测、采集运行、自动续跑 | `src/main/ipc/automation.ts` |
| `templates.ts` | 模板集、截图、去底预览、保存 / 删除 / 测试模板 | `src/main/ipc/templates.ts` |
| `accounts.ts` | 账号、实例绑定（确认改绑）、脚本参数、就绪闸门、登录会话与预览输入；推送 `account-changed` / `login-changed` | `src/main/ipc/accounts.ts` |
| `plans.ts` | 任务计划与脚本库 | `src/main/ipc/plans.ts` |
| `runs.ts` | 脚本执行监控（空，待 script-engine） | `src/main/ipc/runs.ts` |
| `insights.ts` | 现有洞察、通知、只读机器人 | `src/main/ipc/insights.ts` |
| `stats.ts` / `alerts.ts` / `bot.ts` / `resources.ts` | 统计 / 告警 / 机器人 / 资源统计（空） | 同名文件 |
| `advisor.ts` | AI 顾问 | `src/main/ipc/advisor.ts` |
| `scheduler.ts` / `instances.ts` / `update.ts` | ETA 调度 / 实例级操作 / 应用内更新（空） | 同名文件 |
| `app.ts` | 后台服务启动失败（`appServiceFailures` + `service-failures` 事件）；应用设置、路径、自检、日志与旧版导入待 app-shell 追加 | `src/main/ipc/app.ts` |

每个领域文件导出 `XxxApi`、`XXX_METHODS`（`as const`）、`XxxEvents`、`XXX_EVENTS` 与 `XxxContractCheck`。

## 新增一个 IPC 方法

1. 在领域文件的 `XxxApi` 里声明方法（返回 `Promise<…>`，参数与返回值必须可结构化克隆），并把方法名追加到 `XXX_METHODS`。
   漏加时 `XxxContractCheck` 编译失败（`Type 'false' does not satisfy the constraint 'true'`）；写错名字时 `satisfies` 报错。
2. 在 `src/main/ipc/<领域>.ts` 的 `xxxHandlers` 里实现同名处理器：先用 `./validate` 校验渲染进程传来的每个参数（中文、以「无效」结尾），再调服务。
   需要新服务就加到该文件的 `XxxServices`，并在 `src/main/index.ts` 的 `registerWanlongIpcHandlers({...})` 里传入。
3. 预加载和聚合器都不用改。渲染进程直接 `await avdm.xxx(...)`；失败抛 `WanlongError`（`errMsg(e)` 取文案，`errorCodeOf(e)` 取错误码）。
4. 通道名固定为 `wanlong:<方法名>`；方法名不得与壳层 `AvdmApi` 重名（编译期与 `test/ipc-boundary.test.ts` 双重检查）。

## 新增一个推送事件

1. 在领域文件的 `XxxEvents` 里加 `'事件名': 负载类型`，并把事件名追加到 `XXX_EVENTS`。事件名不得与壳层 `AvdmEvents`（`script-run`、`script-output`、`log` …）重名。
2. 服务通过构造参数注入的回调发事件（不直接 import `events.ts`），在 `src/main/index.ts` 里接到 `broadcast('事件名', payload)`。
3. 渲染进程 `useAvdmEvent('事件名', (payload) => …)`（监听器放在 ref 里，内联函数不会反复订阅）。

## 错误码透传

主进程处理器抛出的错误以 `{ ok: false, error: { message, code? } }` 的形式返回；预加载对助手方法**原样返回信封**，
由 `src/renderer/api.ts` 在渲染进程里重建 `WanlongError`，所以 `code` 不会在 contextBridge 上丢失。壳层方法保持「成功返回值、失败抛 message」。
