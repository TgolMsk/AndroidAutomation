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
  ★ 这条由主进程 RPC 层强制（`vision-pool.ts` 的 `RESOURCES_WHITELIST_BUDGET`）：资源作业在门槛前连采样 / 采集那套
  恢复动作（盲按 BACK、取消退出框、AI 顾问）也一次都不给，不只靠 worker 自觉。
- 主进程用同一个门槛批准正式输入，之后每次输入前复核前台包名与实例身份（`record.createdAt`）；读资源**从不**冷启动游戏。
- 批准之后 `readResourceStatsPanel` 负责「读完一定还原」：每次 BACK 后都跟 `dismissNoticeDialog`（只点取消，绝不点确定）。
- 在实例锁里跑：与采样、派兵、机器人截图抢同一把锁。锁被短暂占用（健康探针）时最多等 5 秒；被长时间占用（采样 / 采集一轮）
  时直接答「实例 #N 正在…，读资源统计稍后再试。」（`CONCURRENCY_LIMIT`，不是失败，页面显示为提醒）。脚本 / 登录占着实例时同样拒绝。
- 失败现场（`res-*` 标签）按应用设置的 shotPolicy 留痕：`never` 不存，其余都存（都是失败现场）。
- 精度只有 0.1亿（1000 万）：快照只作对账，绝不用来算日采集量（见 `src/main/stats/README.md`）。

## IPC

`resourcesRead(gameId, index)`（读一次并记成今天的快照）、`resourcesReading(gameId)`（正在读的实例）、
`resourcesSeedTemplates(gameId, index, source, overwrite?)`（裁资源统计模板，见下）；事件
`resources-reading`（{ gameId, index, reading }）。`statsSnapshotNow` 走同一条路。

## 资源统计模板（原版 `seedResourceTemplates`）

模板不随仓库发。模板库页的「资源统计模板」清单（`renderer/views/templates/ResourceTemplatesCard.tsx`）列出规格
（`RESOURCE_TEMPLATE_CATALOG` = `game-data/wanlong/resource-stats.json` 的手抄件）里的每一张：已有 / 缺 / 待补裁
（`dig_resstat_5` / `_8` / `_comma` 与单位「万」在参考截图里没有素材），以及还缺什么就读不了表（两张必需界面模板、单位「亿」、
至少一个数字字形）。三种补法：

- **从截图文件夹裁**：选一个文件夹（旧面板的 `docs/game/shots/resources/`，或自己截的），按文件名认帧
  `res_02_items.png` / `res_04_stats.png` / `res_05_back1.png` / `res_06_back2.png`（或 `items.png` / `stats.png` /
  `back1.png` / `worldmap.png`，不分大小写，不跟符号链接，单张 ≤ 40 MB；`seed-frames.ts`）。
- **用当前画面裁**：把游戏停在某个画面，选「当前画面是 …」后裁（只读截图，前台必须是游戏）。
- **手动裁**：点清单里的一行，编辑器按固定 ID、名称、标签、备注建好新模板，读取画面后自己框。

一键裁走 `AutomationHost.seedResourceTemplates`：和保存模板同一套规矩 —— 实例上没有自动化在跑、自动续跑先关掉（模板变了
要重新校准）、持设备租约、每张都经 `TemplateLibrary.save`（方差守卫、原子写）、裁完发一次 `templates-changed`
（视觉工作线程里的采集模板与单位字缓存随之作废）。截图须是 16:9 整帧（2560×1440 最准），坐标按比例换算。
模板集里已有的 ID 默认不动，勾「覆盖已有」才按截图重裁；一张失败不影响其它张。

## 与原版的差异

- 原版 `exclusive` 会一直排队等锁；这里只等 5 秒就报「稍后再试」，避免页面按钮卡在一轮十几分钟的采集后面。
- 原版的日切自动快照（resource-stats.json 的 `dailySnapshotBoundary`）只有设计没有实现，这里同样不做。
- 模板不随仓库发：资源统计模板由用户经「导入旧版模板集」或模板库页的「资源统计模板」清单按规格从自己的截图裁
  （原版是 `npm run check:resources -- --seed` 从仓库里的截图裁）。
