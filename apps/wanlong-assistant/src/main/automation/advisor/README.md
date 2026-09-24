# AI 视觉顾问（只出主意）

移植自 wanlong-panel `src/main/ai/advisor.ts` / `client.ts` / `risk.ts` / `store.ts` 与 `src/shared/ai.ts`。
这个目录**只出主意、不动手**：没有点击、按键、模板写入接口。会点设备的执行器是另一个模块
`../ai-recover/`（见那里的 README），两者通过 `consultFrame` / `claimConfirmation` / `note` 三个方法衔接。

| 文件 | 职责 |
|---|---|
| `src/shared/ai.ts` | 契约（纯模块，渲染进程也用）：`AdvisorConfig` 与唯一权威默认值 `defaultAiConfig()`（百炼兼容地址 + `qwen3.8-flash`、40 s、20 次/时、20 s 冷却、1280 px、refine 开、autoHarvest 开、**autoActions 关**）、唯一取值范围 `AI_RANGE`（每小时次数 0 = 不限）、`AI_PRESETS`（四家平台）、归一化 / 合并（apiKey 三态）/ 打码视图 / 体检 / 洗凭据、枚举与中文标签、记录与状态类型 |
| `types.ts` | 主进程侧类型（`FrameConsultInput` / `AdvisorNote` / `AdvisorPromptProfile` …），并转出 shared 契约 |
| `profiles.ts` | 按游戏的提示词：万龙沿用原版原文（12 类界面、第 N 次尝试、复核后缀、更新 / 顶号指引）；其它游戏用本仓库原来的中性提示词 |
| `client.ts` | OpenAI 兼容 `chat/completions`：从不抛异常；失败分 10 类并给中文指引（404 区分模型名 / 地址层级、超时带秒数与调参建议、`bad_request`）；截图编码、`encodeCropPng`（精定位裁图，<480 宽放大 2 倍）、合成测试图与放宽后的「认出 W」判定 |
| `risk.ts` | 回复解析（去掉所有 ``` 围栏、三种框写法、框尺寸闸门）、`riskRejection`（原版语义，不依赖模型自报标签）、`confidenceFloor`（确认 ≥ 0.85）、`backNoneNeedsAttention`（主界面例外） |
| `store.ts` | `~/.avdm/automation/advisor.json`（0600、原子写、跨进程文件锁、≤ 1 MB；超出时丢最早的记录，保存配置（总开关、Key）永远不受记录多少影响）；读取容错：损坏 / 版本不符 / 过大的文件改名为 `advisor.json.corrupt-<时刻>` 留证，从默认值启动并在状态里给出提示 |
| `index.ts` | `AdvisorService`：配置、限频、两阶段问询（整帧 JPEG → 解析 → 换算到参考坐标 → 可选局部放大精定位）、确认去重、记录、状态、测试 |

## 规则

- **精定位**（refine）只在「自动处理」打开时用于自动链路（关着时框只会被记录，多问一次是白花钱）；手动分析照常精定位。
- **限频是熔断**：每小时额度（所有实例合计，0 = 不限）+ 每实例冷却；只算真正发出的第一阶段问询（精定位不另算）。
  点击前的复核（`recheck`）跳过冷却但计入额度。额度与冷却落盘，重启后仍有效（本仓库的加强）。
- **未启用时自动链路连 skipped 都不记**（原版铁律 4）；手动「只读分析」是用户操作，照旧记一条「未问询」。
- **凭据**：Key 只在 `advisor.json`；过 IPC 只有 `AdvisorConfigView`（长度 ≤ 4 的 Key 也只显示 `••••`）；推送
  `ai-config-changed` 只推打码视图；每条记录的文本在写入前再洗一次；日志统一经应用日志并登记了 Key 去敏。
  服务端的错误说明会回显（截短到 200 字、去掉控制字符、洗掉 Key），便于用户按提示排错；不回显原始响应体。
- **测试连接**：合成 PNG（红色 W）；回答是单独的 W、或「字母是 W」这类明确句式才算通过（不是原版的 `includes('W')`，
  英文的拒答里常有 W）。测试不占也不受每小时额度限制（原版行为）。
- **坐标**：自动链路（`consultFrame`）返回参考坐标（`space: 'reference'`）；手动分析返回截图像素（`space: 'frame'`），
  安全的关闭建议附带模板候选，模板编辑器必须重新截图、由用户核对后才保存。
- **推送事件**：`ai-consulted`（每条记录，含被拦下的）、`ai-config-changed`。

## 与原版的差异

- 配置文件在 `~/.avdm/automation/advisor.json`（0600），不是 `<dataDir>/ai.json`；旧 `ai.json` 不自动导入。
- 只接受 HTTPS（本机回环可用 HTTP），地址里不得带用户名 / 密码 / 查询参数；补丁里未知字段或类型不对直接拒绝；配置不完整不能打开总开关。
- 新增 `autoActions`（默认关，DECISIONS A.3）：关着时仍按原版流程问询，只记录建议，不点击。`autoHarvest` 只在它打开时生效。
- 界面分类是原版万龙 12 类与本仓库通用分类（gameplay / login）的并集，按游戏档案决定给模型哪几类。
- 手动「只读分析」与模板候选是本仓库新增的人工路径，保留。
