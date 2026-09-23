# 模拟器接口与命令

模拟器是独立产品。`packages/desktop` 提供桌面界面，`packages/cli` 提供 `avdm` 命令，`@avdm/core` 提供本仓库内其他应用可复用的 TypeScript 设备接口。`@avdm/emulator-shell` 只是在工作区内复用 Electron 和 UI 的内部包，设备公共 API 仍由 `@avdm/core` 提供。它们读取同一份 `AVDM_HOME`（默认 `~/.avdm`）。游戏助手放在 `apps/` 下，调用 `@avdm/core`，无需启动模拟器桌面界面。

## TypeScript 接口

`@avdm/core` 是工作区包，目前随仓库构建，尚未发布到 npm。先执行 `pnpm --filter @avdm/core build`，在 workspace 应用中声明 `"@avdm/core": "workspace:*"`。最小示例：

```ts
import { AvdManager } from '@avdm/core';

const manager = await AvdManager.open(); // 或 { home: '/自定义数据目录' }
try {
  manager.on('instance-state', (state) => {
    console.log(state.record.index, state.status);
  });

  const instances = await manager.list();
  const target = instances.find((item) => item.record.index === 1);
  if (!target) throw new Error('实例 #1 不存在');

  const ready = target.status === 'running'
    ? target
    : await manager.start(1, { wait: true });
  if (ready.status !== 'running') throw new Error(`实例状态：${ready.status}`);

  const png = await manager.screenshot(1);
  // 在自己的应用中分析 png；需要设备操作时再获取当前 ADB 设备。
  const device = await manager.device(1);
  console.log(device.serial, png.byteLength);
} finally {
  await manager.dispose();
}
```

`AvdManager.open({ home? })` 创建管理器和数据目录；调用方在退出时执行 `dispose()`。常用方法：

| 用途 | 方法 |
| --- | --- |
| 查询 | `list()`、`getState(index)`、`getSettings()`、`getSdk()`、`hostStats()` |
| 实例管理 | `create({ count, ... })`、`clone(sourceIndex, { count, ... })`、`update(index, patch)`、`remove(index)` |
| 生命周期 | `start(index, { wait: true })`、`stop(index)`、`restart(index)`、`waitForBoot(index)` |
| 画面和设备 | `screenshot(index, { width? })`、`device(index)`、`grpc(index)`、`installApk(index, paths)` |
| 脚本与观察 | `listScripts()`、`runScript(id, indices, args)`、`startMonitor()`、`stopMonitor()` |

`manager.on('instance-state', ...)` 推送计算后的状态；`instances-changed` 表示注册表变更。事件在**当前进程**发出：多个应用同时运行时，另一进程的变更应通过 `list()` 或 `getState()` 重新读取，不应仅依赖事件。实例注册表和运行记录有跨进程文件锁；衍生应用仍应在每次输入前重新校验实例、当前设备及前台应用。模拟器实例的 `record.createdAt` 可作为账号和任务绑定的生命周期标识，不能只用可复用的编号或 `emulator-5554` 一类运行时序列号。

## CLI

源码方式：在仓库根目录执行 `pnpm --filter @avdm/cli build` 后，使用 `pnpm avdm <命令>`。macOS 安装包内自带命令行和运行时，无需 Node.js，路径为 `/Applications/AVD 多开管理器.app/Contents/Resources/bin/avdm`。可直接用完整路径，也可自行将这个文件链接到 `PATH` 中的 `avdm`；安装包不会修改系统 `PATH`。例如：

```bash
pnpm avdm doctor
pnpm avdm list --json
pnpm avdm start 1 --wait
pnpm avdm screenshot 1 -o /tmp
pnpm avdm stop 1
```

安装包示例：`'/Applications/AVD 多开管理器.app/Contents/Resources/bin/avdm' list --json`。命令读取与桌面界面相同的 `AVDM_HOME`，无需打开多开管理器窗口。链接到 `PATH` 时应建立符号链接，避免复制包装脚本；它会跟随应用更新。

`--json` 为自动化调用提供机器可读结果；错误的进程退出码非零。`avdm help` 显示全部命令及选项；[README 命令行参考](../README.md#命令行参考)列出 `sdk`、`create`、`clone`、`set`、`start`、`stop`、`shell`、`install`、`app`、`screenshot`、`script` 等命令。`AVDM_HOME=/独立目录 pnpm avdm list --json` 可检查隔离数据目录。

## 衍生应用约定

新游戏或工作流的桌面应用放在 `apps/<assistant-name>/`，复用 `@avdm/core`、公共视觉算法及桌面组件。游戏账号、模板、计划、统计、通知配置由衍生应用管理，不进入模拟器内核。万龙助手是现有示例，入口为 `apps/wanlong-assistant`。两个安装包、图标、应用标识与发布构建保持独立；[双应用架构](APPLICATIONS.md)说明共享数据和进程边界。
