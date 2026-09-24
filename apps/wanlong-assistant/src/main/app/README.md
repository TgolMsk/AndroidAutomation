# 应用外壳服务（`src/main/app/`）

原版 `src/main/config.ts`、`paths.ts`、`health.ts`、`instanceAccess.ts`、`store/logs.ts` 与 `app:*` 通道的移植。
全部在 `src/main/index.ts` 的 `// ── app … ──` 两节里构造与接线；IPC 在 `src/main/ipc/app.ts`，契约在 `src/shared/ipc/app.ts`。

| 文件 | 职责 | 边界 |
| --- | --- | --- |
| `settings-store.ts` | `AppSettingsStore`：`<AVDM_HOME>/automation/app-settings.json`（`{version:1, …}`，0600 原子写） | 坏文件 / 版本不符 / 值非法 → 备份为 `app-settings.json.bad-<时间>`、整体回退默认值、`warning` 给设置页看；**绝不因此起不来**。保存串行、先校验后写、写成功才改内存 |
| `../../shared/app-settings.ts` | 字段、范围、`defaultAppSettings()`（**默认值唯一权威**，主进程与渲染进程共用）、`keepShot()` | 纯函数 |
| `app-log.ts` | `AppLog`：`automation/logs/app.ndjson`，按大小轮换（5 MB × 1+3 个文件），`query()` 跨轮换文件回查（带 `since` 时跳过更早的轮换文件） | **warn / error 必须落盘**（打包后没有控制台，原版 2026-09-18 教训）；debug 从不落盘；info 由设置 `logLevel` 决定。写盘前统一脱敏（Telegram token、`sk-` 密钥、Bearer / key=value、手机号 + `addSecrets()` 注册的明文凭据）。`installConsoleCapture()` 把主进程的 `console.warn/error` 也落盘 |
| `log-secrets.ts` | `SecretMemory` + `rememberingCodec()`：组合根把 Telegram 的钥匙串编解码器包一层，经它加密 / 解密过的明文都记下来交给 `appLog.addSecrets`；AI 顾问的 Key 由 `advisor.logSecrets()` 提供 | 只在主进程；明文凭据只有经过编解码器才会出现在内存里，所以包住编解码器就覆盖了本进程可能打印的全部 token（原版铁律 15 / AI 铁律 5） |
| `paths.ts` | 白名单数据位置 + `openAppPath()`（目录用访达打开、文件只「在访达中显示」，绝不运行它）+ `listInstanceTemplateSets()`（各实例选用的模板集，含已删实例留下的配置）+ `copyText()`（主进程剪贴板） | 渲染进程只能传键名，永远不传路径；还没有模块写入的位置标 `pending`（目前只有「采集现场截图」） |
| `health.ts` / `health-worker.ts` | `runAssistantHealthCheck()`（永不抛）+ `AppHealth`（缓存最近一次、并发合并、推 `app-health`） | 前半是 `@avdm/core` 的 `runDoctorChecks({ audience: 'app' })`（与 `avdm doctor` 同一份检查）+ `adb start-server`（原版 `checkAdbServer`：5037 端口被别的版本的 adb 占着时，adb 本身「正常」但所有设备操作都会失败），后半是助手自己的：实例分辨率、启用采集实例的模板集（每个实例单独限时、并行读取；采集配置读不出也算一条失败）、数据目录可写、OpenCV（在一次性工作线程里初始化，主进程不加载 WASM）、sharp、磁盘余量 |
| `instance-access.ts` | `InstanceAccess`（原版占用表：同步 `acquire`、只删自己的令牌、`anyBusy()`；进程内单例 `instanceAccess`）+ `withLabelledLease()`（现有写入链路用：采集 `运行采集`、模板 / 采集配置 `修改模板或采集配置`、登录 `进行账号登录`、账号修改 `修改账号绑定`、脚本计划 `运行脚本计划`、临时运行脚本 `运行脚本`、输入法安装 `安装中文输入法`、基础实例克隆的源实例 `复制为新实例`）+ `withInstanceLease()`（新写入链路用：先同步占表再拿租约） | 两者都在租约目录里写 `owner.json`（活动 + pid）并在持有期间登记到占用表。`withLabelledLease` 的错误与 `withFileLock` 完全一致（忙时仍是 `LOCK_TIMEOUT`，各调用方的「跳过 / 改写提示」逻辑不变），IPC 边界的 `explainLeaseTimeout` 再把它翻译成「实例 #N 正在<活动>」（`code: CONCURRENCY_LIMIT`）；`withInstanceLease` 直接抛这个错误 |
| `occupancy.ts` | `InstanceOccupancy`：汇总「谁在用实例 N」 | 来源由组合根注册（采集运行、自动续跑、脚本计划、登录）+ 占用表；另一个进程持有的租约在 `holders(i)` 与 `anyBusy()`（更新闸门）里都算忙。坏来源跳过不致命 |
| `device-tools.ts` | `DeviceTools.installApk`：设置页「设备工具 → 安装 APK…」（原版 `device:installApk`） | 只装用户选的本地文件（`.apk/.apks/.xapk`、绝对路径、确实存在），只对运行中的实例，走设备通道排队（原版也是排在该设备的串行队列里） |
| `toasts.ts` | `AppToasts`：主进程 → 界面的提示（服务没能启动、自检发现问题…） | 最近 3 分钟的提示可重放：窗口晚于提示加载时由渲染进程读一次 `appRecentToasts()` |
| `../device/lane.ts` | 设备通道（见 `src/main/device/README.md`） | |

## 给其他模块的接口

- **应用设置**：`appSettings.get()`（同步，读前已加载默认值）、`appSettings.onChange(fn)`；截图留痕统一用
  `keepShot(appSettings.get().shotPolicy, 'failure' | 'process' | 'requested')` 决定存不存。已接上的：告警现场截图
  （`MonitorPorts.keepEvidence` = `'failure'`）；脚本执行（工作线程里的脚本引擎）自己按策略判断，助手只经
  `PlanHostPort.shotPolicy()` 把 `appSettings.get().shotPolicy` 交给没选策略的运行（失败步骤 = 非「不留痕」都存、「每步都留痕」
  每步都存、「截图」步骤与 `capture: true` 任何策略都存）。**待接入**：采集流程的失败现场
  （采集工作线程接 `onShot` 时按 `'failure'` / `'process'` 判断，写到 `automation/<game>/shots`，再去掉 `paths.ts` 里该项的 `pending`）。
  `matchThreshold` / `shrink`：脚本匹配时，步骤和模板都没写阈值就用 `matchThreshold`，帧与模板都按 `shrink` 降采样
  （`PlanHostPort.matchDefaults()` → `ScriptRunner.run({ matchDefaults })` → 脚本工作线程编译模板与准备帧）；采集流程用自己的阈值，不受影响。
- **日志**：`appLog.scoped('scheduler').warn('…', data, index)`；有明文凭据的模块用 `appLog.addSecrets(() => [token, apiKey])` 注册，日志里就不会出现它们。
  服务里原有的 `console.warn/error('[wanlong/xxx] …')` 已自动落盘（`[xxx]` 成为来源）。`broadcast('log', …)` 也会落盘。
- **占用**：`occupancy.register('名字', (index?) => holders)` 登记新的占用来源；`await occupancy.anyBusy()` 给更新闸门用
  （「实例 #N 正在<活动>。」或 null，自动采集仅开着不算忙；另一个助手进程的租约也算忙）；`occupancy.holders(i)` 给实例生命周期确认用（IPC `instanceOccupancy`）。
  **所有设备写入者都要带标签拿租约**：改造现有链路时把 `withFileLock(run/automation-instance-<i>.lock, fn, { timeoutMs })` 换成
  `withLabelledLease(home, i, '活动', fn, { timeoutMs })`（错误不变）；新链路（调度器采样、资源统计、卡死恢复、基础实例克隆……）用
  `withInstanceLease(home, i, '活动', fn, { timeoutMs })`，冲突时直接得到「实例 #N 正在<活动>」。两者都不可重入。
- **凭据**：新增的明文凭据要么经 `rememberingCodec(codec, logSecrets)` 加解密，要么 `appLog.addSecrets(() => [值])` 注册（同步取值）。
- **设备工具**：`deviceTools.installApk(i, paths)`；渲染进程的「中文输入法」扩展位见 `src/renderer/views/settings/device-tool-slots.tsx`。
- **错误码**：助手自己抛的带码错误用 `shared/errors.ts` 的 `WanlongErrorCode` 标注 `code`，新码追加到 `WANLONG_ERROR_CODES`；渲染进程用 `isRetryLaterCode(errorCodeOf(e))` 区分「稍后再试」。
- **提示**：`appToasts.push({ level, title, detail?, view? })`（`view` 是渲染进程的页面键，提示会带「前往查看」按钮）。
- **自检**：`appHealth.check()` / `appHealth.last()`；事件 `app-health`。

## 刻意没有移植

- 模拟器种类、adb / mumutool 路径、数据目录、参考分辨率这几个设置项（AVD 下由 core / AVDM_HOME / 游戏插件与模板集决定），
  以及「重启后生效」的运行设置分离（剩下的设置全部即时生效）、按模拟器安装隔离数据（`device-context.json`）。
- 「同时运行实例上限」与「实例状态轮询间隔」改为编辑 core 设置（与多开管理器共用：`maxRunning`、`healthIntervalSec`、`bootTimeoutSec`）。
- 通用 `app:pickFile`：保持目标的最小权限做法，用各自用途的选择器（APK 用壳层的 `pickApks`）。
- 「设备工具 → 安装并启用中文输入法」（原版 `device:setupIme`）：归脚本引擎模块（DECISIONS 脚本引擎：用户自选 ADBKeyboard APK），这里只留扩展位与说明。
- 浅色主题（PRODUCT.md：用户选择保留深色）。
