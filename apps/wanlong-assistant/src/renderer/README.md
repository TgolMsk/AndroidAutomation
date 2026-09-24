# 万龙助手界面外壳

- `App.tsx`：左侧七个一级入口、顶部状态条（当前游戏、全局当前实例、在线 / 执行中（采集 + 排队或运行中的脚本）、角标）、组内页面切换、内容区（记住常驻页面各自的滚动位置）。`#/live/<i>` 仍由 `main.tsx` 路由到实时画面。
- `navigation.ts`：`NAVIGATION`（每个 ViewKey 只出现一次）、`sectionForView`、页面记忆（`localStorage['wl.view']`，读写全部 try/catch）、`RETIRED_VIEWS`。
- `views/registry.tsx`：ViewKey → 页面组件；`needsGame`（游戏模块未就绪时显示载入状态）、`keepAlive`（首次访问后隐藏保留：采集草稿与探针、计划与调度设置草稿、脚本编辑器草稿；隐藏时 `visible=false`，页面应暂停轮询）。持有未保存草稿的新页面也要设 `keepAlive`，否则切页即丢。
- `state/`：`navigation`（当前页）、`activity`（采集运行与自动续跑，事件 + 15 秒兜底轮询）、`selection`（全局游戏 / 实例选择，`useSelectionLock` 在设备操作期间锁住实例选择器）、`plan-runs`（当前游戏的脚本执行记录，顶部「执行中」与执行监控共用）、`template-flow`（AI 模板建议 → 模板库；模板变更通知采集页作废探针 —— 脚本页的「从画面截取」在自己的弹窗里存模板并插块，同样发这个通知）、`plan-import`（旧版脚本 / 计划导入会话，脚本页与任务计划页共用，旧 ID → 新 ID 映射不丢）、`badges`（顶部角标）。
- `badge-sources.tsx`：常驻的角标来源组件列表；需要全局角标的模块把自己的组件追加进 `BADGE_SOURCES`，组件内调用 `useShellBadge(...)`。已有：游戏模块 / 实例列表读取失败；后台服务启动失败（`hooks/useServiceFailures`：挂载时读一次 `appServiceFailures()` 再跟 `service-failures` 事件，角标指向设置页的「后台服务未启动」卡片）；主进程提示 `AppToasts`（挂载时读一次 `appRecentToasts()` 补上窗口加载前发出的提示，再跟 `app-toast` 事件，按 id 去重，服务启动失败与自检问题的提示都从这里弹）。
- `format.ts`：游戏相关时间一律 `beijingTime()`（转调 `src/shared/time.ts`），不用 `toLocaleString()`。
- `views/update/`：应用内更新的渲染侧（`update-store.ts` 单一状态源、`UpdatePanel` 完整 / 紧凑两种形态、`SidebarUpdate` 左下角版本号与红点）；设置页的「版本与更新」卡在 `views/settings/UpdateCard.tsx`。主进程侧见 `src/main/update/README.md`。

## 新增一个页面

1. 在 `navigation.ts` 的 `ViewKey` 与对应分组的 `views` 里加一项（中文标签）。
2. 新建 `views/<区域>/<Xxx>View.tsx`（+ 同名 `.css`，类名用该页面自己的前缀，只用设计令牌），组件签名 `(props: ViewProps)`，
   通过 `useSelection()` / `useActivity()` / `useNavigation()` 取游戏、实例与跳转，不自己选实例。
3. 在 `views/registry.tsx` 登记（`Record<ViewKey, …>`，漏登记编译失败）。
4. 需要跨页跳转时调用 `useNavigation().navigate('<ViewKey>')`；进行设备操作时 `useSelectionLock(busy ? '原因' : null)`。

## 共用组件（`components/`，样式在 `components/ui.css`，前缀 `wl-ui-`，只用设计令牌）

- `Card`：页面分区卡片（原 GlassCard）：`title` / `icon` / `extra`（标题右侧操作）/ `footer` / `variant: panel | solid | sunken` / `padding: lg | sm`。
- `StatTile` + `MetricStrip`：关键数字磁贴（标签 < 数字 < 标题三档字号，调用处不要改字号）与自动换行的一排。
- `SemanticTag` / `RunStatusTag` / `RunStatusDot` / `InstanceStateTag` / `StatusTag`：全助手唯一一套状态药丸与配色；
  运行状态文案沿用原版（排队中 / 启动中 / 执行中 / 已暂停 / 停止中 / 已完成 / 失败 / 已中止，`RUN_STATUS_TEXT`），一个字都不要改。
- `HealthBadge`：顶部「环境正常 / N 项异常 / 自检未完成」徽标 + 弹出层；`compact={false}` 在设置页铺开。数据来自 `hooks/useAppHealth`（共享外部存储）。
- `InstanceLifecycleGuard`：`useInstanceLifecycleGuard()` → `{ guard, dialog }`。实例页在关闭 / 重启 / 删除前调用
  `guard({ action, indices, run })`：先问主进程 `instanceOccupancy(i)`（采集、自动续跑、脚本计划、登录、其他进程的租约），有人在用就弹确认框。

## 设置页（`views/settings/`）

卡片注册表在 `cards.ts`（`SETTINGS_CARDS`，每张卡一个文件）。「版本与更新」（`key: 'update'`）已换成应用内更新的 `UpdateCard`；通知与推送、机器人、AI、导入旧版数据目前是占位卡（`SlotCards.tsx`，说明配置在哪并给跳转）；
负责的模块把同 `key` 的那一行换成自己的卡片组件即可，不用改 `SettingsView.tsx`。应用设置读写走 `hooks/useAppSettings`（`saveAppSettings(patch)`，主进程严格校验）。

- 「设备工具」（`DeviceToolsCard`，原版同名卡）：选一个运行中的实例 →「安装 APK…」（`pickApks` → 有采集 / 登录 / 脚本在用时先确认 → `appInstallApk`，排在该实例的设备通道里）。
  卡内的扩展位在 `device-tool-slots.tsx`（`DEVICE_TOOL_SLOTS`）：`ime` 是脚本引擎的「安装并启用中文输入法」组件 `views/runs/ImeTool.tsx`（props：所选实例 `index`、卡片是否正忙 `busy`；与「启动执行」弹窗用同一对 `imeStatus` / `imeSetup` 通道）。
- 「数据目录」：路径可以直接选中复制，复制按钮走主进程剪贴板（`appCopyText`，壳层拒绝了渲染进程的剪贴板权限）；下方列出各实例选用的模板集（`appTemplateSets`，用壳层 `revealPath` 在访达中显示）。
  没有模块写入的位置带「待接入」标记（`AppPathEntry.pending`）。
- 「功能设置」：任务计划、采集配置、模板集这几类设置在各自页面，这里给跳转。

