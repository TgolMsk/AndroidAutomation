# 资源统计（`@avdm/automation/wanlong` · resources）

读游戏里「道具 → 资源 → 资源统计」那张 4 行 × 2 列的表（金币 / 木材 / 铁矿石 / 魔水 × 道具总量 / 资源总量），
返回 `ResourceSnapshot`。规格：`packages/automation/game-data/wanlong/resource-stats.json`。

## 边界

| 文件 | 纯 / 有副作用 | 内容 |
|---|---|---|
| `contract.ts` | 纯 | 资源类型、`ResourceSnapshot`、`PANEL_AMOUNT_PRECISION`、`parseCnAmount` / `formatCnAmount` / `CN_AMOUNT_CASES`、`renderResourceSnapshotText`、`normalizeResourceSnapshot` |
| `layout.ts` | 纯 | `RESOURCE_STATS_LAYOUT` / `rowRoi`（JSON 的手抄件，测试断言一致） |
| `ids.ts` | 纯 | 模板 id（与旧版一致）、字形集名、模板目录手抄件、`resourceSeedPlan` |
| `pure.ts` | 纯 | 上面三个的出口，供 `@avdm/automation/wanlong/pure` 整体转出（渲染进程 / 机器人可用） |
| `templates.ts` | 读模板集、sharp | 单位字 shrink=1 加载（按目录缓存、定义一变自动失效）、`seedResourceTemplates`（走 `TemplateLibrary.save`） |
| `read.ts` | 视觉 + 设备端口 | `readResourceStatsFromFrame`（纯识别）、`mergeSnapshots`、`readResourceStatsPanel`（完整流程） |

本目录不认识 Electron、IPC、存储与告警：快照落盘、日桶、面板按钮、机器人命令由助手的统计模块接线；
`readResourceStatsPanel` 在 worker 里跑，设备端口与采集流程是同一个 `GatherIo`（`createGatherIo` 包 device-RPC）。

## 铁律

1. **精度只有 0.1亿（1000 万）**：快照只作日切快照与粗对账，**不能拿来算日采集量**（日采集量 = 派兵记账的储量之和）。显示一律带「≈」与精度说明（`PANEL_PRECISION_NOTE`）。
2. **预检不过一个动作都不发**：前台不是游戏 / 有「注意」框 / 不在世界地图或城内 / 压着卡片、部队面板、搜索面板、创建部队页 ⇒ 直接抛中文错误。唯一例外：主界面被活动弹窗盖住时，只点弹窗自己的 ×。
3. **必需模板或字形集缺失时在动手之前拒绝**（`TEMPLATE_NOT_FOUND`，提示去模板库导入）。
4. **读完一定还原**：BACK →（标题仍在则点 X）→ BACK → 用主界面模板校验；不行再走 G0 阶梯。**每次 BACK 之后紧跟 `dismissNoticeDialog`（只点取消，绝不点确定）**。导航失败也要还原，还原失败的说明追加到原错误里。
5. **单位字（亿/万）绝不进字形集**：整字 matchIn 定位后把数字 ROI 截到它左边，否则「亿」会被拆成 1 / 小数点。
6. **缺字位宁可读不出也不给错值**：单字形接受阈值 0.9，缺 5/8/逗号/「万」时该格为 null，原文与原因写进 warnings。
7. **调用方必须持有实例设备租约**（与采集 / 采样 / 脚本同一把锁），截图熔断 30 张。

## 与旧版的差异

- 模板来自调用方给的模板集目录（`templateDir`），不再有全局模板库；单位字缓存按目录 + 定义签名自动失效。
- `seedResourceTemplates` 不再读仓库里的截图：调用方按「帧角色」（items / stats / back1 / worldMap）提供用户自己的整帧 PNG，
  坐标按帧尺寸换算（16:9 任意分辨率）；一张失败不影响其它张，失败原因逐条返回。
- 资源中文名只有一份（取自 `config.ts` 的 `RESOURCE_LABEL`）。
