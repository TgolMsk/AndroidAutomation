# 万龙助手监控边界

本目录属于 `apps/wanlong-assistant`，不属于独立模拟器产品。模拟器进程、ADB、实例锁和截图读取继续由 `AutomationHost` / `ManagerHost` 提供。监控服务只观察已经启用自动调度的游戏实例；采集或登录占用实例时跳过巡检。

## 已迁移

- 连续真实失败、G0 恢复失败、长时间无派兵的独立计数。`queueFull` 等正常结果不计为失败；`circuitBroken` 由 Insights 单独告警。
- 顶号、登录、维护和更新的旧模板 ID。模板尚未采集时静默退化为连续失败告警；同一模板必须在两次新截图中均超过 `max(0.92, 模板阈值)` 才报告具体场景。
- 每分钟被动采样时，连续四帧、五分钟几乎不变才报告疑似卡死。只有实例进程仍在，且调用方明确分类为 ADB 截图故障，才统计截图失败。报告不会触发重启。
- 现场截图保存到 `~/.avdm/automation/monitoring/shots`，权限 0600，14 天清理。告警通过 `onAlert` 回调交给 Insights 做持久化及用户开启的通知。
- `ReadOnlyTelegramBot` 提供可选的 `/status`、`/shot <编号>` 入站查询。默认关闭，需在“统计与通知”中保存 Bot Token、Chat ID、授权用户 ID 并显式启用；它没有点击、重启、登录或脚本执行端口。截图由 `AutomationHost.captureReadOnly` 提供。

## 旧版能力与边界

旧版 `kicked.ts` 明确是预留钩子，仓库没有真实顶号、维护和更新模板。没有样本时，不能声称已实测具体场景。旧版 `freezeRecovery.ts` 依赖 MuMu/LD 驱动并自动重启实例；迁入官方 Android Emulator 前，需要单独设计实例锁、重启熔断、用户授权和真机验证。旧版 Telegram 机器人支持远程设备控制；本模块只保留状态和截图查询。统计、桌面/Telegram 出站通知由 `InsightsService` 负责。

运行 `pnpm --filter @avdm/wanlong-assistant exec vitest run test/monitoring.test.ts test/monitoring-bot.test.ts test/monitoring-config.test.ts` 验证检测、配置迁移与入站授权边界。
