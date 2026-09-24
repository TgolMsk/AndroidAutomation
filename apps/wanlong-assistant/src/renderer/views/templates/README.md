# 模板库页面（templates）

移植自 wanlong-panel 的 `TemplateEditor.tsx`，用本应用自己的 CSS（`TemplatesView.css`，类名前缀 `template-`）。

- `TemplatesView.tsx`：页面入口，接上当前游戏 / 实例与 AI 建议的跨页流程（`state/template-flow`）。脚本页的「从画面截取」不再跳到这里，而是在脚本页自己的弹窗里走同一个 `saveAutomationTemplate`（见 `views/scripts/README.md`）。
- `TemplateEditor.tsx`：模板集切换 / 新建 / 载入文件夹 / 导入合并；模板列表（σ 与透明底徽章、尺寸｜ROI｜阈值摘要、每行「立即验证」）；详情卡；只读截图 → 拉截取框（至少 8×8）与默认 ROI；固定 ID（覆盖已有 ID 需再确认）、备注、标签；1~3 帧差分透明底（350ms 防抖预览、覆盖率解读，保存时把差分帧交给主进程重算）；方差守卫的中文指导；缺失模板快捷列表（关键 / 可选 / 字形数字）与完整编译检查。
- `TemplateList.tsx`：左侧模板列表。一套模板动辄 130 多张（一半以上是只给读数用的数字字形），平铺会一路往下翻，调试时找不到要改的那张，所以：
  - **分类筛选**：默认「界面模板（不含数字字形）」，也可选某一类界面（资源统计 / 弹窗与异常 / 导航与主界面 / 搜索面板 / 资源点卡片 / 部队管理 / 创建部队与行军 …）、全部数字字形或某一套字形（如 `dig_panel_level`），选过的分类记在 `localStorage['wl.templates.filter']`（读写全部 try/catch）；
  - **搜索**：名称 / ID / 标签 / 备注 / 分类名，多个词都要命中；当前分类搜不到而别的分类有时，给「在全部模板里找到 N 个」；
  - **分页**：每页 `TEMPLATE_PAGE_SIZE`（12）张，`‹ 1 2 … n ›` 翻页；列表 `position: sticky`，往下编辑时列表不跟着滚走；
  - **缩略图**：只加载当前页的图（`thumb-cache.ts`：按 ID + `updatedAt` 缓存 object URL，换实例 / 模板集时统一 revoke）；
  - 从外面选中的模板（保存、缺失模板快捷项、AI 建议、刷新）会自动翻到它所在的页，被当前分类或搜索挡住时切到它自己的分类。
- `template-groups.ts`：纯函数，分类规则只有这一份（模板库列表与脚本编辑器的模板选择器共用）：先看标签（内置集按界面打了标签），再看 ID 前缀，
  最后看名称开头的「界面词」（「资源统计-行标签」→ 资源统计），都没有归「未分组」；数字字形（`digit` 标签或 `dig_` 前缀）永远单独一类、按字形集再分。
  不落盘：改模板的标签或名称就会换组，旧模板集同样适用。测试见 `test/template-groups.test.ts`。
- `template-editor.ts`：纯函数（文案、判据、保存草稿），测试见 `test/template-editor.test.ts`。
- `ResourceTemplatesCard.tsx` + `resource-templates.ts`（万龙觉醒）：「资源统计模板」清单（已有 / 缺 / 待补裁、还缺什么就读不了表）、
  按规格从截图文件夹或当前画面一键裁（`avdm.resourcesSeedTemplates`）、每行「手动裁」预填编辑器；CSS 前缀 `res-tpl-`，
  说明见 `src/main/resources/README.md`，测试见 `test/resource-templates.test.ts`。

边界：页面只调用 `avdm.*Template*` 方法；截图只读、需要游戏在前台；保存 / 删除会先关掉该实例的自动续跑（主进程），并推送 `templates-changed`。导入合并同理：补进了模板的模板集，绑定它的每个实例都不能在运行、自动续跑会被关掉（结果里的 `pausedSchedules`），当前模板集被改动时页面和保存一样通知采集页重新校准。去底预览与保存时的差分掩码在模板工作线程里算，不占主线程。页面不做分辨率特判，只在截图小于模板集参考分辨率时给出提示。
