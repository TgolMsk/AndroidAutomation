# 万龙觉醒 · 游戏数据契约（文档，不参与运行）

这里的 JSON 是从旧版万龙面板移植过来的**规格说明**：真机实测的坐标、状态机、模板清单、识别参数与配置 schema。
运行期代码不读它们（坐标等关键数值在 `src/wanlong/**` 里手抄一份），但**改数值必须两边同时改**，
有手抄件的地方由 vitest 做一致性断言（例如 `test/wanlong-resources-layout.test.ts` 对 `resource-stats.json`）。

| 文件 | 内容 | 对应代码 |
|---|---|---|
| `gather-config.schema.json` | 自动采集配置 schema（draft-07，version 2） | `src/wanlong/config.ts`（`normalizeGatherConfig`） |
| `gather-flow.json` | G0~G16 采集状态机、锚点与偏移、字形识别规则 | `src/wanlong/gather/*` |
| `gather-templates.json` | 采集用模板清单（id、裁剪框、搜索范围、必需/可选） | `src/wanlong/gather/templates.ts` |
| `resource-stats.json` | 「道具 → 资源 → 资源统计」表格识别契约 | `src/wanlong/resources/*` |
| `beasts.json` | 野兽（抓宠）名单与选择器几何 | 暂无代码（抓宠功能块的规格） |
| `troop-panel.json` | 「部队管理」面板：入口图标位置（务必点 x=2522）、标题栏 N/M 区域、每行布局、实测到的状态词、调度器怎么用这些数据 | `src/wanlong/scheduler/troopPanel.ts`（`ENTRY_TAP`、行 ROI、`rowY()` 等） |
| `stamina-config.schema.json` | 统帅体力读数的配置结构（开关检测、阈值）；采样器 `readOptionalFields` 读两名统帅体力时参考 | `src/wanlong/scheduler/troopPanel.ts` |

坐标一律是 **2560×1440 参考分辨率**。AVD 分辨率不同由 `createGatherIo` / `prepareFrame` 在设备边界换算，
建议把 AVD 建成 2560×1440（至少 1920×1080），否则字形识别的可靠性要在真机上重新验证。
部队面板的采样器（`troop-panel.json`）与代码不一致时以代码为准，并回来更新这里。

## 脱敏说明

- 联盟缩写一律换成示例值：`XYZ1`（他方联盟）、`ABC1`（本方联盟）。
- 模板集 id、本地数据目录写成占位符 `<模板集ID>`、`~/.avdm/automation/templates/wanlong/<模板集ID>`。
- 真机截图文件名一律换成画面描述（例如「部队管理面板」真机帧）；截图、模板图片、账号资料**不入仓库**。
  `resource-stats.json` 的 `shot` 字段是**帧角色**（`items` / `stats` / `back1` / `worldMap`），
  与 `src/wanlong/resources/ids.ts` 的 `ResourceSeedFrame` 一致，`seedResourceTemplates` 按角色接收用户提供的整帧 PNG。
- **绝不**往这里放模板图片、真机截图、游戏美术、账号信息或登录 XML。
