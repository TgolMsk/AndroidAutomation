# 模板库页面（templates）

移植自 wanlong-panel 的 `TemplateEditor.tsx`，用本应用自己的 CSS（`TemplatesView.css`，类名前缀 `template-`）。

- `TemplatesView.tsx`：页面入口，接上当前游戏 / 实例、AI 建议与「从画面截取」两条跨页流程（`state/template-flow`）。
- `TemplateEditor.tsx`：模板集切换 / 新建 / 载入文件夹 / 导入合并；模板列表（σ 与透明底徽章、尺寸｜ROI｜阈值摘要、每行「立即验证」）；详情卡；只读截图 → 拉截取框（至少 8×8）与默认 ROI；固定 ID（覆盖已有 ID 需再确认）、备注、标签；1~3 帧差分透明底（350ms 防抖预览、覆盖率解读，保存时把差分帧交给主进程重算）；方差守卫的中文指导；缺失模板快捷列表（关键 / 可选 / 字形数字）与完整编译检查。
- `template-editor.ts`：纯函数（文案、判据、保存草稿），测试见 `test/template-editor.test.ts`。

边界：页面只调用 `avdm.*Template*` 方法；截图只读、需要游戏在前台；保存 / 删除会先关掉该实例的自动续跑（主进程），并推送 `templates-changed`。导入合并同理：补进了模板的模板集，绑定它的每个实例都不能在运行、自动续跑会被关掉（结果里的 `pausedSchedules`），当前模板集被改动时页面和保存一样通知采集页重新校准。去底预览与保存时的差分掩码在模板工作线程里算，不占主线程。页面不做分辨率特判，只在截图小于模板集参考分辨率时给出提示。
