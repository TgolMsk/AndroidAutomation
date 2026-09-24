# 设备通道 DeviceLane（`src/main/device/lane.ts`）

原版 `src/main/adb/queue.ts`（每设备串行车道 + 全局上限 + AsyncLocalStorage 重入）与 `adb/capture.ts`（截图最小间隔）的移植，
DECISIONS C「设备通道」：助手内部的 adb 调用按实例串行，只读路径（探针、顾问、机器人截图、模板截取）也走它，避免与写入链路并发打同一台设备。

- 每个实例一条车道：同一实例的设备操作一个接一个、按提交顺序执行；不同实例并行，总并发上限 `GLOBAL_ADB_CONCURRENCY = 6`。
- `screencapRaw` / `screencapPng` 之间至少隔 `minCaptureIntervalMs`（应用设置，默认 400 ms；模拟器截图吞吐上限约 4.3 帧/秒）。
  **等待发生在车道里面**：等待期间该实例的其他操作也不会插队，这是有意的。
- 重入：正在车道上运行的操作再调同一实例的设备方法（如 `text(value, beforeEach)` 的回调里读前台）会就地执行，不会自锁。
- `drop(i)` 取消排队中的操作（`code: CANCELLED`），正在跑的那一个不打断；`dispose()` 在退出时取消全部。

## 怎么接入

组合根已经把包了车道的宿主传给了设备服务：

```ts
const deviceLanes = new DeviceLanes({ minCaptureIntervalMs: () => appSettings.get().minCaptureIntervalMs });
const deviceHost = deviceLanes.host(services.host);   // get() → manager，manager.device(i) → 车道设备（方法名不变）
new AutomationHost(deviceHost, …); new AccountManager(deviceHost, …); plans 的 device: (i) => (await deviceHost.get()).device(i)
```

因此 `AutomationHost.captureReadOnly`、探针、模板截取/测试、顾问与机器人截图（经 captureReadOnly）、采集工作线程的设备 RPC、
登录输入、脚本计划的设备调用、设置页「设备工具」的安装 APK（`DeviceTools`，经车道设备的 `install`）都已经在车道上。新的运行器（调度器采样、资源统计、卡死恢复……）：

1. 需要设备时一律从 `deviceHost`（或 `deviceLanes.device(i, device)`）拿，不要直接 `services.host.get()` 再 `device(i)`；
2. 需要「前台检查 → 截图 → 前台检查」这类不可被插队的组合动作时，用 `deviceLanes.run(i, async () => { … })` 包起来（内部的设备调用自动重入）；
3. 实例被停止/删除后可以 `deviceLanes.drop(i)` 清掉排队的旧请求。

不经过车道的只有 core 自己的调用（`AvdManager.start/stop/…`、gRPC 实时画面），它们不走 adb shell。
