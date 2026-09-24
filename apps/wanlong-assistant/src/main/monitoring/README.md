# 万龙助手只读机器人（监控目录的剩余部分）

原来这里的只读监控（连续失败计数、顶号专用模板、每分钟巡检的疑似卡死、现场截图）已经由 `src/main/alerts` 取代：
失败计数、自动暂停、推送、卡死看门狗与自动重启都在那里，接在 ETA 调度器的钩子上（见 `src/main/alerts/README.md`）。

本目录只剩 `ReadOnlyTelegramBot`（`/status`、`/shot <编号>` 入站查询）。它的凭据与开关（Bot Token、Chat ID、授权用户 ID、
「手机查看状态与截图」）现在由告警推送设置统一保存（`NotifyHub.readOnlyBotConfig()`，Token 仍用系统钥匙串加密）。
完整的机器人（菜单、远程控制、按钮回调）由机器人模块移植并替换本目录。

运行 `pnpm --filter @avdm/wanlong-assistant exec vitest run test/monitoring-bot.test.ts` 验证入站授权边界。
