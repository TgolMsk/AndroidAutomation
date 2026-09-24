# 双应用架构与调用约定

仓库提供两个可分别安装、分别启动的 macOS 应用：

| 应用 | 职责 | 工作区依赖 |
| --- | --- | --- |
| `packages/desktop` · AVD 多开管理器 | 安装 Android SDK，创建、启动、克隆、配置和查看模拟器实例 | `@avdm/core`、`@avdm/emulator-shell` |
| `apps/wanlong-assistant` · 万龙助手 | 万龙觉醒的实例启停与基础实例克隆、账号与登录、模板、采集调度、脚本与计划、告警与机器人、统计和 AI 顾问（`wanlong-panel` 的完整移植） | `@avdm/core`、`@avdm/emulator-shell`、`@avdm/automation` |

两个应用各有 Electron 主进程入口、预加载脚本、界面入口、应用标识、图标和安装包。`@avdm/emulator-shell` 复用通用 Electron 启动、受限 IPC、实时画面与基础界面组件；它不依赖任一应用目录，游戏逻辑也不进入共享壳。万龙助手通过工作区包调用模拟器能力；它不把 UI 请求发给多开管理器的窗口进程，因此多开管理器退出后，已经运行的 Android Emulator 实例和助手仍可工作。它也不另建一套模拟器注册表或 SDK 下载逻辑。

## 共享数据与进程边界

默认数据根目录由 `@avdm/core` 的 `defaultHome()` 决定：`~/.avdm`；测试或隔离安装可设置 `AVDM_HOME`。两款应用必须使用**同一个** `AVDM_HOME` 才能看到同一组实例。Android SDK 由现有设置决定，默认 `~/Library/Android/sdk`。Electron 自己的窗口偏好属于各自的应用资料目录，不用于同步实例。

`@avdm/core` 是模拟器操作的唯一入口。实例注册表、运行记录、启动端口与设备发现均由它维护，并使用已有文件锁保护跨进程修改。助手保存的账号绑定、任务配置、模板、统计、通知和顾问数据放在 `~/.avdm/automation/` 下，按游戏和实例隔离；凭据、真实截图与模板不进入源码或安装包。删除或重建同编号实例时，助手应依据实例创建标识检查旧绑定，不能仅按 `index` 自动继承账号。可复用方法、参数和命令示例见 [模拟器核心 API 与 CLI](EMULATOR_API.md)。

## 助手接入模拟器

助手启动后按需打开 `AvdManager`，每次操作前重新读取实例状态，并从当前实例解析 ADB 设备。运行时的 `emulator-5554` 等 serial 可能变化，不能写入账号、模板或任务配置。

```ts
import { AvdManager, defaultHome } from '@avdm/core';

const manager = await AvdManager.open({ home: defaultHome() });
const instances = await manager.list();
const selected = instances.find((item) => item.record.index === index);
if (!selected) throw new Error(`实例 #${index} 不存在`);
// 仅在明确需要时启动；之后重新检查状态与当前前台应用。
// await manager.start(index, { wait: true });
const device = await manager.device(index);
// 使用 device 执行经游戏流程授权的操作；退出时 await manager.dispose()。
```

自动化主进程负责同一实例的输入租约、取消、调度和敏感数据；视觉识别和游戏状态机运行在独立 worker。只读探测可拍照分析，但写操作必须重新确认实例、前台包名与画面锚点。登录、采集、脚本、模板修改不能同时操控同一实例（同一把带标签的实例租约）；脚本计划优先于采集，执行前由调度器让路，而不是互相拒绝。新增游戏时建立并列的助手应用或游戏模块，复用 `@avdm/core` 的设备接口、`@avdm/emulator-shell` 的桌面外壳，以及通用视觉与设备契约，不复制多开管理器的 SDK/实例管理代码。共享壳的导出边界和打包要求见 [Emulator Shell](../packages/emulator-shell/README.md)。

## 助手管理实例

助手需要时会直接管理实例，但一律调用 `@avdm/core` 的 `AvdManager`，不另建注册表：
- 「模拟器实例」页提供启动 / 停止 / 重启 / 新建 / 克隆 / 删除。新建、克隆、编辑对话框与多开管理器共用 `@avdm/emulator-shell` 的组件；停止、重启、删除前先检查该实例是否被采集、登录或脚本占用，并请用户确认。
- 登录向导会按需开机。
- 基础实例批量克隆走 `AvdManager.clone`，每个克隆按 4 GB 预检磁盘空间。
- 「卡死自动重启」（默认关闭）用 `stop({ force: true })` + `start()` 冷启动，避免把卡死的客体存进 Quick Boot 快照；之后重连、拉起游戏并等回主界面，窗口内重启过多就熔断、转为暂停告警。

多开管理器照常可以操作同一批实例；两边的改动经 `~/.avdm` 的注册表与文件锁同步。

## 使用与安装

只管理模拟器时，安装并启动“AVD 多开管理器”即可。需要万龙觉醒自动化时，另外安装“万龙助手”，在其界面选择同一 `~/.avdm` 中的实例。助手不要求多开管理器窗口一直打开，可以自己启动实例；实例上需要安装目标游戏，游戏没开时自动采集会用 monkey 拉起。两个 DMG 可独立更新；更新任一应用不会删除 `~/.avdm` 中的实例与自动化配置。

从仓库根目录运行 `pnpm build` 构建多开管理器，运行 `pnpm build:wanlong` 构建万龙助手；分别用 `pnpm start:desktop` 和 `pnpm start:wanlong` 启动构建产物。发布脚本为 `pnpm dist:mac`、`pnpm dist:mac:wanlong` 或同时打包的 `pnpm dist:mac:all`。完整下载名称与验证命令见 [发布说明](RELEASE.md)。
