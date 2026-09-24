# 应用内更新（`src/main/update/`）

移植自 wanlong-panel 的 `src/main/update/`（UpdateCenter 状态机 + 忙碌闸门 + 中文错误）与 `src/shared/update.ts`。
原版用 electron-updater 静默安装 Windows NSIS 包；万龙助手是**临时签名（ad-hoc）的 macOS DMG**，Squirrel.Mac
会拿新包去对「正在运行的应用的指定要求（designated requirement）」，临时签名的要求绑死在具体二进制上，
每个新版本都会被拒。所以这里不用 electron-updater，改成：

```
查 GitHub Release（TgolMsk/AndroidAutomation，含预览版）
  → 显示版本号与更新说明
  → 用户点「下载更新」：下载 Wanlong-Assistant-<版本>-mac-arm64.dmg 到「下载」文件夹（先写 .part，可断点续传）
  → 用同一 Release 的 SHA256SUMS 校验，通过才改名成 .dmg
  → 用户点「退出并打开安装包」：忙碌闸门 → 再校验一次 → 再问一次闸门 → 打开 DMG → 退出助手
  → 用户在打开的窗口里把「万龙助手」拖到「应用程序」替换旧版，再重新打开
```

## 分层

| 文件 | 职责 | 边界 |
|---|---|---|
| `src/shared/update.ts` | 契约：8 个阶段 + 中文、`UpdateState`、版本比较 / 字节与速度格式化（纯函数） | 主进程与渲染进程共用，不引 Node / Electron |
| `center.ts` | `UpdateCenter` 状态机、`UpdaterPort` / `UpdateDeps` 接口、`describe()` 错误中文化 | 不引 Electron、不联网，测试塞假端口 |
| `github.ts` | `UpdaterPort` 的真实实现：Releases API、SHA256SUMS、带进度与续传的下载、复核、打开 | 不引 Electron（fetch / 下载目录 / 访达动作都注入） |
| `busy.ts` | `BusyGate`：汇总各服务的占用探针（原版 `instanceAccess.anyBusy()`） | 探针必须同步、便宜；抛错按占用处理 |
| `electron-deps.ts` | 用 `app` / `net.fetch` / `shell` 组装 `UpdateDeps` | **本目录唯一引用 electron 的文件** |
| `index.ts` | `UpdateService`：初始化状态机 + 启动 30 秒后自动查一次 | — |
| `src/main/ipc/update.ts` | `update*` 七个方法；都不接收渲染进程参数 | 仅主窗口可调（统一鉴权） |

渲染进程：`src/renderer/views/update/`（`update-store.ts` 单一状态源 + 引用计数订阅、`UpdatePanel` 完整 / 紧凑两种形态、
`SidebarUpdate` 左下角版本号与红点）、`src/renderer/views/settings/UpdateCard.tsx`（设置页「版本与更新」卡）。

## 铁律（原版四条，照搬）

1. **绝不自作主张装。** 自动的只有「启动 30 秒后静默查一次」（只读 Release 元数据）；下载和安装都必须用户点。
   开发模式、截图验证模式（`AVDM_SCREENSHOT_PATH`）不自动查。
2. **有任务在跑就不许装。** 安装 = 退出助手。`BusyGate` 由主进程拦，按钮禁用只是提示；
   复核安装包（算 SHA-256 要一两秒）之后**再问一次**，防止这期间有任务开始。
   **仅仅开着自动续跑不算忙**：那只是个定时器，重新打开助手后按磁盘上的状态恢复。
3. **不能更新的环境给出能照着做的下一步**：`dev`（开发模式）、`platform`（不是 macOS Apple Silicon，没有安装包）。
   任何时候都能「打开 Release 页面」手动下载。
4. **开发模式不检查**，也不会构造更新器。

## 忙碌闸门现有的探针（`main/index.ts` 的 `// ── update ──` 段）

| 名称 | 占用条件 |
|---|---|
| 采集运行 | `AutomationHost.activeRunIndices()`：手动或自动续跑的一轮正在跑 / 正在停止 |
| 脚本计划 | `PlanService.isActiveForInstance(i)`：执行中或排队中 |
| 账号登录 | 登录向导处于 准备 / 启动 / 等待登录 / 验证 |
| SDK 安装 | 外壳的 `sdkInstall.active` |

之后移植的、会占着设备的链路（调度器 `exclusive`、卡死恢复、资源统计读取、机器人重新拉起……）
在同一段里各加一行 `busyGate.register('<中文名>', () => [{ index, activity: '<正在做什么>' }])`。
`busyGate.holdersOf(i)` 也可用于「停止 / 重启实例前先确认」。

## 与原版的差异

- **不用 electron-updater**（见上）。`quitAndInstall` 换成「打开 DMG + 退出」，替换应用那一步由用户拖一次；
  没有 `.blockmap` 增量下载，改为 `.part` 断点续传。原版的「CJS 默认导入」与「惰性构造」两个坑随 electron-updater 一起消失，
  但仍保留惰性构造：`GitHubUpdater` 第一次真正要用时才建。
- **新增「取消下载」与「在访达中显示」**两个方法；下载失败的原因在「有新版本」状态里也显示（原版只在检查失败时显示）。
- 不支持原因：原版 `portable`（Windows 免安装版）在 macOS 没有对应物，换成 `platform`。
  差距报告里提议的 `not-installed`（从 DMG 里直接运行）与 `unsigned` 不再需要：DMG 路线本身就是给未签名应用的替代方案，
  从哪里运行都不影响「下载新 DMG 再拖一次」。
- 下载完成后再点「检查更新」沿用原版行为（按新结果重新判定为「有新版本」）；再点下载时已校验的文件会被直接复用，不会重下。
- 更新日志目前只写 console（`[wanlong/update]` 前缀）；助手的应用日志落地后，把 `index.ts` 里 `electronUpdateDeps` 的 `log`
  接过去即可（原版写 `<数据目录>/logs/app.ndjson`，`scope: 'update'`）。

## 安全

- 只访问本仓库：API 固定为 `api.github.com/repos/TgolMsk/AndroidAutomation/releases`，安装包与 SHA256SUMS 的地址
  必须以 `https://github.com/TgolMsk/AndroidAutomation/releases/download/` 开头，文件名必须匹配
  `Wanlong-Assistant-<版本>-mac-arm64.dmg`（它会成为「下载」文件夹里的路径）；只打开本仓库的发布页。
- SHA256SUMS 与 DMG 来自同一个 Release，校验防的是传输损坏与断点续传拼错，不防 GitHub 账号被盗；这一点与原版的
  `latest.yml` sha512 相同。安装包本身没有开发者签名，首次打开仍可能需要在「隐私与安全性」里允许。
- 所有请求有超时（API 20 秒、下载空闲 60 秒）与大小上限；`net.fetch` 走系统代理。

## 自检

```bash
pnpm --filter @avdm/wanlong-assistant exec vitest run test/update-contract.test.ts test/update-center.test.ts \
  test/update-github.test.ts test/update-busy.test.ts test/update-ipc.test.ts
```

原版 `scripts/update-offline-check.ts`（43 项）逐节移植在 `update-contract`（一、版本比较）与 `update-center`（二～五），
不联网、不打包、不碰 Electron。
