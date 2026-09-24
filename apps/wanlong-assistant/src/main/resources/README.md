# 资源统计读取（道具 → 资源 → 资源统计）

移植自 wanlong-panel `src/main/index.ts` 的 `readResourceStatsForInstance` 接线与 `stats:snapshotNow`。识别与流程本身
（预检 → 打开弹窗 → 读表 → 还原 → 校验）在 `packages/automation/src/wanlong/resources/`，这里只做助手侧的接线。

```
ResourcesService.read(i) (service.ts)       同一实例一次只读一个；成功就记成统计快照；推 resources-reading
  └─ AutomationHost.readResourceStats(i)    实例锁（eta.exclusive '读资源统计'）；忙 = CONCURRENCY_LIMIT，稍后再试
       └─ WanlongGatherRunner.readResources  常驻视觉工作线程里的 'resources' 作业（模板只编译一次）
            └─ vision-worker runResources    必需模板 / 字形集 → 前台 → 主界面门槛 → 主进程批准 → readResourceStatsPanel
```

## 铁律

- **不在主界面就一个动作都不发**：worker 先查必需模板与字形集，再查前台是不是游戏，再要求画面过「资源读取门槛」
  （`probe.ts` 的 `inspectResourceProbe`：采集探针门槛 + 只认世界地图 / 城内，开着部队管理面板一律拒绝）。门槛之前唯一
  允许的输入是点一次弹窗自己的 ×（主进程白名单 `closePopup`，预算 1 次）；门槛不过就留一张 `res-precheck-not-main` 并报错。
- 主进程用同一个门槛批准正式输入，之后每次输入前复核前台包名与实例身份（`record.createdAt`）；读资源**从不**冷启动游戏。
- 批准之后 `readResourceStatsPanel` 负责「读完一定还原」：每次 BACK 后都跟 `dismissNoticeDialog`（只点取消，绝不点确定）。
- 在实例锁里跑：与采样、派兵、机器人截图抢同一把锁。锁被短暂占用（健康探针）时最多等 5 秒；被长时间占用（采样 / 采集一轮）
  时直接答「实例 #N 正在…，读资源统计稍后再试。」（`CONCURRENCY_LIMIT`，不是失败，页面显示为提醒）。脚本 / 登录占着实例时同样拒绝。
- 失败现场（`res-*` 标签）按应用设置的 shotPolicy 留痕：`never` 不存，其余都存（都是失败现场）。
- 精度只有 0.1亿（1000 万）：快照只作对账，绝不用来算日采集量（见 `src/main/stats/README.md`）。

## IPC

`resourcesRead(gameId, index)`（读一次并记成今天的快照）、`resourcesReading(gameId)`（正在读的实例）；事件
`resources-reading`（{ gameId, index, reading }）。`statsSnapshotNow` 走同一条路。

## 与原版的差异

- 原版 `exclusive` 会一直排队等锁；这里只等 5 秒就报「稍后再试」，避免页面按钮卡在一轮十几分钟的采集后面。
- 原版的日切自动快照（resource-stats.json 的 `dailySnapshotBoundary`）只有设计没有实现，这里同样不做。
- 模板不随仓库发：资源统计模板由用户经「导入旧版模板集」或按规格从自己的截图裁（`seedResourceTemplates`）。
