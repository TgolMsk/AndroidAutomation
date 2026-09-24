# 数据统计（每日统计）

移植自 wanlong-panel `src/shared/stats.ts`、`src/main/stats/{index,reduce,store,ipc}.ts` 与页面
`src/renderer/src/features/stats/`。契约（日桶类型、七种事件、文案渲染）在 `src/shared/stats.ts`，北京时间只有一份实现
`src/shared/time.ts`。

```
StatsService (service.ts)      收事件 → 当天事实（内存）→ 防抖落盘 → 推 stats-today；北京 0 点换日；只读查询
  ├─ StatsStore (store.ts)     automation/games/<gameId>/stats/days/<YYYY-MM-DD>.json + pauses.json + migration.json
  ├─ aggregateDay (aggregate.ts)  一天的事实 → DailyStats（原版 reducer + rolloverDay，读时计算，纯函数）
  ├─ facts.ts                  事实类型与逐条容错解析
  ├─ events.ts                 钩子载荷 → StatsEvent（哪些算失败、什么是一趟、什么是暂停、哪些告警算数）
  ├─ pause-reality.ts          pauseStates 端口：调度器的自动开关 + AVD 是否还在 → 核对还开着的暂停
  └─ migrate.ts                一次性导入旧 insights 日账（automation/insights/days）
```

## 口径（与原版一致）

- **日桶按北京日期**切（`cstDateKey`），宿主时区不影响；三种时区下结果相同（`test/stats-offline.test.ts`）。
- **派兵**：`AutomationHost` 的 `onDispatched`（出错收场的那一轮派出去的也算）。储量读到的计入预计采集量，读不出的计
  `unknownStorageDispatches`。★ 资源统计表（精度 0.1亿）只作快照对账，绝不拿来算日采集量。
- **失败 / 熔断分开计**：`outcome === 'error'` 计失败轮（包括「压根没跑起来」的那一轮），`circuitBroken` 只计熔断；
  `GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED` 不计失败（专用「需要人处理」告警负责）。
- **完成趟数**：调度器 `onMarchGone`（上次采样在外、这次不见了的队伍）。资源按原版的链找：事件自带 → 派兵记账按坐标反查
  （跨天、重启后从昨天和今天的派兵事实重建）→ 该实例当天派得最多的资源 → 全局派得最多的资源 → 都没有就丢弃并记一条说明，绝不瞎猜。
- **告警**：只数告警模块（`src/main/alerts`，FailureTracker 的结论 / 卡死 / 顶号 / 需要人处理）的告警结论。告警模块经
  `ledgerAlertOf()` → `InsightsService.recordAlert()` 把每条结论写进日账，新写入的一条通过 `insights.onAlertStored` 转成
  `alertRaised` 事件（按 id 只数一次）。`countsAsAlert` 仍排除旧日账里每轮一条的「运行失败」与每次熔断一条的「采集熔断」——
  熔断不是失败、不发告警，已经按 `circuitBreaks` 计过，导入旧日账时同样排除。
- **暂停时长**：★ 唯一来源是调度器 `onAutoChanged`（自动开关真的翻转时）。重复的「暂停」不会把起点往后挪，没有暂停时的
  「恢复」被忽略；跨 0 点时前一天算到 24:00，后一天从 00:00 接着算（`pauseCarry` 事实）。助手关着跨过几天，重启时补齐每一天。
  过去的某一天**永远不会**显示「暂停中」（原版这里会算出 +Infinity）。
  ★ 暂停跨重启保存（原版重启即丢），所以要核对：启动时读回的暂停先不往缺席的日子里补，等调度器恢复完开关后
  `reconcilePauses()`（`pauseStates` 端口）逐个核对 —— 实例已删（`gone`）或自动开关其实开着（「恢复」事实丢了，`resumed`）
  的暂停就地结束（今天还开着的记一条「恢复」到此刻），之后不再补记；其余照常补齐缺席的日子。每次北京 0 点换日前也核对一遍，
  运行中被删掉的实例不会每天多出 24 小时暂停。端口失败或 15 秒没答复就按原样记账。
- **快照**：每天最多 48 张（保留最新），同一张快照（实例 + 时刻）只记一次。
- **账号名 / 实例身份**：每条事实记下当时实例的 `record.createdAt` 与绑在这台 AVD 上的账号名（缓存 1 分钟）。
  同一编号的 AVD 被删掉重建，旧实例当天的数字单独成一行（`key = <index>@<createdAt>`，`replaced: true`），不会并进新实例，也不会借用旧账号名。
  暂停属于编号（自动开关按编号），总是记在该编号当前那一行；但暂停事实只有与那一行是同一台 AVD 时才给它账号名。

## 存储

- 一天一个文件：`{ version: 1, gameId, dateKey, facts: [...] }`，0600 原子写，写入在跨进程文件锁里按事实 id 合并
  （重复投递不会重复计数，两个进程写同一天不会丢）。
- 读取宽容：文件不存在 = 空；JSON 坏了 / 版本不认识 / 过大 = 这一天按空账显示并警告，下次写入前把原文件改名为
  `<key>.json.corrupt-<时刻>` 保留备查；单条坏记录跳过并计数，其余照常统计。绝不因为一条坏数据让整个范围读不出来。
- 保留 90 天（启动与每次换日时清理）。
- `pauses.json`：还没恢复的暂停（重启、跨天续算用）。`migration.json`：旧 insights 日账的导入进度；截止时刻在导入前先定下
  （取「现在」与钩子记下的第一条事实中较早者），所以导入中断重来也不会和钩子记下的重复。

## 生命周期

- `record()` 同步、绝不抛；事件在内部链上按序应用（先查实例身份与账号名）。`start()` 之前到的事件等它，`stop()` 之后丢弃并警告。
- 查询（`daily` / `range`）在 `start()` 之前到也等它（最多 60 秒），不报「尚未启动」：外壳会记住上次的页面，窗口一开
  「数据统计」页就可能来查。`restore()` 里数据统计排第一个启动；页面在一次没拉全之后，下一次推送或 60 秒轮询会整页重拉。
- 今天的事实 1 秒防抖落盘；更早日期的事实直接补进那天的文件；更晚日期的事实先换日。
- `stats-today` 推送 1 秒节流；北京 0 点（+1 秒）的定时器换日并立刻推新的一天（空桶，页面据此跟过去）。

## IPC

`statsDaily(gameId, dateKey?)`、`statsRange(gameId, from, to)`（最多 366 天）、`statsSnapshotNow(gameId, index)`；
事件 `stats-today`（DailyStats）与 `stats-snapshot`（{ gameId, dateKey, snapshot }）。非法日期统一报
「日期格式应为 YYYY-MM-DD，收到：…」，`from > to` 报「起始日期 … 晚于结束日期 …。」，错误码随信封带到渲染进程。

## 给机器人（第三波）

`stats.today()` + `renderDailyStatsText(today, { formatClock: formatCstClock })` 就是原版「📈 今日统计」/`/stats` 的回复；
读资源走 `ResourcesService.read(i)`（会自动记快照），回复用 `renderResourceSnapshotText`。
