# 万龙助手界面外壳

- `App.tsx`：左侧七个一级入口、顶部状态条（当前游戏、全局当前实例、在线 / 执行中（采集 + 排队或运行中的脚本）、角标）、组内页面切换、内容区（记住常驻页面各自的滚动位置）。`#/live/<i>` 仍由 `main.tsx` 路由到实时画面。
- `navigation.ts`：`NAVIGATION`（每个 ViewKey 只出现一次）、`sectionForView`、页面记忆（`localStorage['wl.view']`，读写全部 try/catch）、`RETIRED_VIEWS`。
- `views/registry.tsx`：ViewKey → 页面组件；`needsGame`（游戏模块未就绪时显示载入状态）、`keepAlive`（首次访问后隐藏保留：采集草稿与探针、计划与调度设置草稿、脚本编辑器草稿；隐藏时 `visible=false`，页面应暂停轮询）。持有未保存草稿的新页面也要设 `keepAlive`，否则切页即丢。
- `state/`：`navigation`（当前页）、`activity`（采集运行与自动续跑，事件 + 15 秒兜底轮询）、`selection`（全局游戏 / 实例选择，`useSelectionLock` 在设备操作期间锁住实例选择器）、`plan-runs`（当前游戏的脚本执行记录，顶部「执行中」与执行监控共用）、`template-flow`（AI 模板建议 → 模板库；脚本截取 → 模板库 → 回到脚本；模板变更通知采集页作废探针）、`plan-import`（旧版脚本 / 计划导入会话，脚本页与任务计划页共用，旧 ID → 新 ID 映射不丢）、`badges`（顶部角标）。
- `badge-sources.tsx`：常驻的角标来源组件列表；需要全局角标的模块把自己的组件追加进 `BADGE_SOURCES`，组件内调用 `useShellBadge(...)`。已有：游戏模块 / 实例列表读取失败；后台服务启动失败（`hooks/useServiceFailures`：挂载时读一次 `appServiceFailures()` 再跟 `service-failures` 事件，弹一次提示、角标指向设置页的「后台服务未启动」卡片）。
- `format.ts`：游戏相关时间一律 `beijingTime()`（转调 `src/shared/time.ts`），不用 `toLocaleString()`。

## 新增一个页面

1. 在 `navigation.ts` 的 `ViewKey` 与对应分组的 `views` 里加一项（中文标签）。
2. 新建 `views/<区域>/<Xxx>View.tsx`（+ 同名 `.css`，类名用该页面自己的前缀，只用设计令牌），组件签名 `(props: ViewProps)`，
   通过 `useSelection()` / `useActivity()` / `useNavigation()` 取游戏、实例与跳转，不自己选实例。
3. 在 `views/registry.tsx` 登记（`Record<ViewKey, …>`，漏登记编译失败）。
4. 需要跨页跳转时调用 `useNavigation().navigate('<ViewKey>')`；进行设备操作时 `useSelectionLock(busy ? '原因' : null)`。
