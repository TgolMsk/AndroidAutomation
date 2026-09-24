# 应用外壳服务（`src/main/app/`）

原版 `src/main/config.ts`、`paths.ts`、`health.ts`、`instanceAccess.ts`、`store/logs.ts` 与 `app:*` 通道的移植。
全部在 `src/main/index.ts` 的 `// ── app … ──` 两节里构造与接线；IPC 在 `src/main/ipc/app.ts`，契约在 `src/shared/ipc/app.ts`。

| 文件 | 职责 | 边界 |
| --- | --- | --- |
| `settings-store.ts` | `AppSettingsStore`：`<AVDM_HOME>/automation/app-settings.json`（`{version:1, …}`，0600 原子写） | 坏文件 / 版本不符 / 值非法 → 备份为 `app-settings.json.bad-<时间>`、整体回退默认值、`warning` 给设置页看；**绝不因此起不来**。保存串行、先校验后写、写成功才改内存 |
| `../../shared/app-settings.ts` | 字段、范围、`defaultAppSettings()`（**默认值唯一权威**，主进程与渲染进程共用）、`keepShot()` | 纯函数 |
| `app-log.ts` | `AppLog`：`automation/logs/app.ndjson`，按大小轮换（5 MB × 1+3 个文件），`query()` 跨轮换文件回查 | **warn / error 必须落盘**（打包后没有控制台，原版 2026-09-18 教训）；debug 从不落盘；info 由设置 `logLevel` 决定。写盘前统一脱敏（Telegram token、`sk-` 密钥、Bearer / key=value、手机号 + `addSecrets()` 注册的明文凭据）。`installConsoleCapture()` 把主进程的 `console.warn/error` 也落盘 |
| `paths.ts` | 白名单数据位置 + `openAppPath()`（目录用访达打开、文件只「在访达中显示」，绝不运行它） | 渲染进程只能传键名，永远不传路径 |
| `health.ts` / `health-worker.ts` | `runAssistantHealthCheck()`（永不抛）+ `AppHealth`（缓存最近一次、并发合并、推 `app-health`） | 前半是 `@avdm/core` 的 `runDoctorChecks({ audience: 'app' })`（与 `avdm doctor` 同一份检查），后半是助手自己的：实例分辨率、启用采集实例的模板集、数据目录可写、OpenCV（在一次性工作线程里初始化，主进程不加载 WASM）、sharp、磁盘余量 |
| `instance-access.ts` | `InstanceAccess`（原版占用表：同步 `acquire`、只删自己的令牌、`anyBusy()`）+ `withInstanceLease()`（占用表 + 跨进程租约 + `owner.json` 标签） | 租约超时翻译成「实例 #N 正在<活动>」（`code: CONCURRENCY_LIMIT`），不再是「等待文件锁超时」 |
| `occupancy.ts` | `InstanceOccupancy`：汇总「谁在用实例 N」 | 来源由组合根注册（采集运行、自动续跑、脚本计划、登录）；另一个进程持有租约时也能看见。坏来源跳过不致命 |
| `toasts.ts` | `AppToasts`：主进程 → 界面的提示（服务没能启动、自检发现问题…） | 最近 3 分钟的提示可重放：窗口晚于提示加载时由渲染进程读一次 `appRecentToasts()` |
| `../device/lane.ts` | 设备通道（见 `src/main/device/README.md`） | |

## 给其他模块的接口

- **应用设置**：`appSettings.get()`（同步，读前已加载默认值）、`appSettings.onChange(fn)`；截图留痕统一用
  `keepShot(appSettings.get().shotPolicy, 'failure' | 'process' | 'requested')` 决定存不存（采集失败现场、脚本截图、告警现场、机器人截图同一个开关）。
  `matchThreshold` / `shrink` 是脚本条件与新模板在自身没写阈值时的默认值。
- **日志**：`appLog.scoped('scheduler').warn('…', data, index)`；有明文凭据的模块用 `appLog.addSecrets(() => [token, apiKey])` 注册，日志里就不会出现它们。
  服务里原有的 `console.warn/error('[wanlong/xxx] …')` 已自动落盘（`[xxx]` 成为来源）。`broadcast('log', …)` 也会落盘。
- **占用**：`occupancy.register('名字', (index?) => holders)` 登记新的占用来源；`await occupancy.anyBusy()` 给更新闸门用
  （「实例 #N 正在<活动>。」或 null，自动采集仅开着不算忙）；`occupancy.holders(i)` 给实例生命周期确认用（IPC `instanceOccupancy`）。
  新写入链路优先用 `withInstanceLease(home, i, '活动', fn, { access: instanceAccess, timeoutMs })`，冲突时对方能说出「正在做什么」。
- **提示**：`appToasts.push({ level, title, detail?, view? })`（`view` 是渲染进程的页面键，提示会带「前往查看」按钮）。
- **自检**：`appHealth.check()` / `appHealth.last()`；事件 `app-health`。

## 刻意没有移植

- 模拟器种类、adb / mumutool 路径、数据目录、参考分辨率这几个设置项（AVD 下由 core / AVDM_HOME / 游戏插件与模板集决定），
  以及「重启后生效」的运行设置分离（剩下的设置全部即时生效）、按模拟器安装隔离数据（`device-context.json`）。
- 「同时运行实例上限」与「实例状态轮询间隔」改为编辑 core 设置（与多开管理器共用：`maxRunning`、`healthIntervalSec`、`bootTimeoutSec`）。
- 通用 `app:pickFile`：保持目标的最小权限做法，用各自用途的选择器。
- 浅色主题（PRODUCT.md：用户选择保留深色）。
