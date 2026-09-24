# Telegram 机器人（手机上点按钮 / 发命令远程操作）

移植自 wanlong-panel `src/shared/bot.ts`、`src/main/alerts/telegramBot.ts`、`src/main/bot/{actions,ipc}.ts`、`src/main/index.ts` 里的
`recoverGame` / `captureShotForBot` 接线，以及渲染进程 `features/bot/BotTestCard.tsx`。取代了本仓库原来的只读机器人
（`monitoring/telegram-readonly.ts`，已删除）。

场景（原版话）：半夜收到「疑似被顶号」推送，人在外面没法开电脑 —— 在消息下面点一下「重启游戏并恢复」；白天想看看号在不在
正常挂着 —— 点底部菜单的「📷 截图」，选个账号，几秒后画面就发过来了。

```
src/shared/bot.ts            契约（纯函数，渲染进程可用）：九个动作 BOT_ACTIONS / BOT_ACTION_SPECS（含 permission）/ 命令列表 /
                             菜单按钮字面量 BOT_MENU_BUTTON（★ 一个字都不能改）/ 回调数据 ≤64 字节 / 选实例按钮 /
                             BotActionPort / 账号列表与截图说明的渲染（北京时间）/ BotStatusView
packages/automation/src/wanlong/recoverGame.ts   顶号 / 断线恢复序列（纯逻辑 + io 注入；原版 index.ts 的 recoverGame）
src/main/bot/
  actions.ts        createBotActions(deps)：九个动作的实现，Electron 无关，端口全注入
  telegram-bot.ts   TelegramBot：长轮询、鉴权、开关、三种输入 → (动作, 实例号)、回复（先图后文）
  device.ts         BotDevice：在 Android 模拟器上截图 / 跑恢复序列（@avdm/core + 设备通道 + 视觉线程的模板匹配）
  shots.ts          BotShotStore：发出去的截图留底 automation/wanlong/bot-shots/（0600，14 天 / 300 张）
  index.ts          BotService：把上面几样拼起来；setPorts() 给统计 / 资源模块晚接线
src/main/ipc/bot.ts                    bot 域 IPC：botPerform / botInstances / botStatus，事件 bot-status
src/renderer/views/bot/                设置页「Telegram 机器人 · 在助手内测试动作」卡片 + 纯函数 bot-tester.ts
```

分层只有一条边界：`BotActionPort`（`perform(action, index)` / `listInstances()`）。通道层与动作层互不认识，设置页测试卡片
走的也是同一个 `BotActionPort`（`botPerform`），这里通了手机上就通。

## 铁律

1. **凡要碰模拟器的动作（截图 / 读资源统计 / 重启游戏）必须走 `EtaScheduler.exclusive()`**：与采样、派遣抢同一把实例锁
   （也是跨进程的带标签设备租约），脚本、登录或别的写入者占着实例时直接用中文拒绝（`CONCURRENCY_LIMIT`），原样回给用户。
   实例号校验在抢锁之前（未知实例 / 没选实例 / 模拟器没在运行都不碰锁）。
2. **恢复自动调度只能在锁外调**（会采样、要抢锁）：「重启游戏并恢复」= 锁内 `recoverGame` → 解锁 → 恢复。恢复失败时照样
   把已经做了的步骤告诉用户（原版会被「操作失败」盖掉）。
3. **暂停 / 恢复不自己记统计事件**：唯一来源是调度器的 `onAutoChanged`（开关真的翻转才通报）。
4. **绝不盲点**：顶号框 / 网络断开弹窗都要模板命中（`tpl_dlg_kicked` / `tpl_dlg_network_lost`，模板集里没有就跳过这一步），
   每次点击前在设备通道上重读前台，不是游戏就不点；拉起游戏只用 monkey、只拉本游戏包。坐标是 2560×1440 参考坐标，按截到的帧换算。
5. **★★ Token 只出现在 `api()` 的 URL 里**：每条日志、每句回给用户的话、每个抛出的错误都先清洗（`scrubSecret` + 按形状兜底），
   动作层根本拿不到 Token；设置页只拿到 `BotStatusView`。从不加 `parse_mode`。
6. **按钮先应答再干活**：回调在 10 秒内 `answerCallbackQuery`（「收到，正在操作模拟器，请稍等…」），慢动作排进一条有序队列
   （上限 20 个），轮询不会被一次重启游戏卡住。
   ★ 队列里的每条请求属于收到它的那一轮运行：停止 / 重启就结束这一轮 —— 还没开始的请求直接丢弃，正在做的动作做完（它持有实例锁，
   不能半路打断）但结果不再发回手机（与原版一致：原版在轮询循环里直接执行，stop() 一中止就什么都不剩）。每个动作 `perform`
   之前再读一次设置：开关已关 → 回拒绝说明；两个开关都关了或换了 Chat ID / 授权用户 → 不执行、不回复。
7. **启动时丢弃积压的旧更新**（`offset -1`）：重启助手后，睡着时发的 `/relaunch` 不会被重放。
8. **只在保存设置时重载，且只在机器人自己的设置变了才重启**（`reload()`：开关、Token、Chat ID、授权用户）。机器人启停只调
   `hub.setRemoteControlHandler(running)`，那一步只推视图（`onViewChanged`），**绝不能**再触发重启 —— 否则启停互相触发、永不停歇
   （`test/bot-alerts-wiring.test.ts` 按 `main/index.ts` 的接线把 NotifyHub 与 BotService 接在一起钉死了这一条）。

## 权限（DECISIONS A.3）与鉴权

| 开关（设置 → 通知与推送 → 手机机器人） | 默认 | 放行的动作 |
|---|---|---|
| 允许手机查看状态与截图（`remoteReadOnlyEnabled`） | 关 | status、accounts、shot、stats |
| 允许手机远程操作（`remoteControlEnabled`） | 关 | pause、resume、relaunch、resources（会点游戏，所以算操作类） |
| 任一个开着 | — | 机器人运行；menu、/help、/start |

- 只响应配置的 **Chat ID 且** 授权用户 ID（本仓库加固；原版只认 Chat ID）。别的会话 / 用户：消息静默忽略，每个会话 / 用户对只记
  一条警告；按钮只应答「未授权的会话。」。
- 开关关着的动作回一句说明去哪打开，不执行。告警消息下面的按钮也只附加开关允许的那几个（`buildAlertKeyboard`），且只在机器人
  正在运行时附加（`hub.setRemoteControlHandler(running)`）。
- 设置页的测试卡片不受手机开关限制（本机界面），但会标出「手机上需要先打开 …」。

## 与原版的差异（及原因）

| 项 | 原版 | 这里 | 原因 |
|---|---|---|---|
| 开关 | `remoteControl` 一个开关，默认开 | 查看 / 操作两个开关，默认都关，另需授权用户 ID | DECISIONS A.3 |
| 实例列表 | 绑定了实例的账号；一个都没有时回落到实例 0 | 只算绑定仍有效的（同一 AVD：序号 + 创建时间），排除基础实例；一个都没有时列出全部非基础实例 | AVD 重建后不继承绑定；没有 MuMu 的固定实例 0 |
| resume | 任何实例 `alertCenter.resume` → `setAuto(true)` | 告警暂停中 → 告警模块恢复（清计数与冷却、补「已恢复」通知）；否则走用户的自动续跑开关（就绪门槛 + 首次启用的只读探针） | 告警模块只恢复它自己关掉的；首次开启要过探针 |
| pause | `scheduler.setAuto(i,false)` | `AutomationHost.setSchedule(false)`（同时作废还在探测中的开启请求） | 与界面开关同一条路 |
| 截图 | MuMu 截图，主进程 sharp | `AdbDevice.screencapRaw` + 工作线程编码（1280 宽，q70），模拟器没在运行时先拒绝 | DECISIONS A.6 |
| 重启游戏 | 第二层任一预留模板命中都点顶号框坐标 | 只在 `tpl_dlg_kicked` 命中时点；进程在但被切到后台时用 monkey 切回前台；维护 / 更新公告单独报错 | 那个坐标只对顶号框校准过 |
| 资源统计 / 今日统计 | 直接调 | 端口 `readResources` / `dailyStatsText`（`BotService.setPorts`），没接线时回「还没有接入」 | 统计与资源模块并行移植 |
| 截图留底 | `<dataDir>/shots/bot/` | `automation/wanlong/bot-shots/`（0600，14 天 / 300 张），「不留痕」时不存 | 本仓库数据目录与留痕策略 |
| 轮询 | 串行处理每条更新 | 快的部分（鉴权、应答按钮）立刻做，慢动作排队（停止 / 重启时丢弃未开始的，执行前按最新设置复核）；启动时丢弃积压；每次最多 50 条 | 回调 10 秒内必须应答 |
| 重载 | 每次保存告警设置都重启 | 只在机器人自己的设置（开关 / Token / Chat ID / 授权用户）变了才重启 | 改别的设置不打断手机上正在排队的请求 |

## 给后续模块的接口

- `BotService`（`main/index.ts` 的 `// ── bot (Telegram) ──`，变量名 `remoteBot`）：`actions`（`BotActionPort`）、`start / stop /
  restart / reload / status / testConnection / dispose`（保存设置后用 `reload()`，只在机器人自己的设置变了才重启），**`setPorts({ readResources, recordSnapshot?, dailyStatsText })`** 给统计 / 资源模块
  在自己的区段里接线（`readResources` 已经记快照就不要再给 `recordSnapshot`）。
- IPC（`shared/ipc/bot.ts`）：`botPerform(action, index | null)` → `BotActionResult`（`photo.jpeg` 是 `Uint8Array`）、`botInstances()`、
  `botStatus()`；事件 `bot-status`。旧的 `remoteBotConfig / saveRemoteBotConfig / testRemoteBot` 仍可用（设置保存在告警配置里）。
- 契约与纯函数：`@/shared/bot`（`parseCallbackData`、`buildCallbackData`、`BOT_MENU_BUTTON`、`renderAccountList`、`renderShotCaption`、
  `shotFilename`、`botActionAllowed` …）。
- `@avdm/automation/wanlong`：`recoverGame(io)`、`RECOVER_GAME_DEFAULTS`、`RECOVER_KICKED_DIALOG`、`RECOVER_NETWORK_LOST`。

## 验证

```bash
pnpm --filter @avdm/wanlong-assistant exec vitest run test/bot-actions.test.ts test/telegram-bot.test.ts \
  test/shared-bot.test.ts test/bot-device.test.ts test/bot-alerts-wiring.test.ts
pnpm --filter ./packages/automation exec vitest run test/wanlong-recover-game.test.ts
```

没有在真机上验证过的：真实 Telegram 往返与「重启游戏」在真实顶号 / 断线弹窗上的点击（需要用户自己的模板集与 Bot）。
