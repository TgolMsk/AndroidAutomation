# AI 执行器与「认不出界面」路由（会动设备）

移植自 wanlong-panel `src/main/ai/recover.ts` / `harvest.ts` 与 `src/main/index.ts` 的 `recoverUnknownWithUpdate` /
`gatherAdvisor` / `aiRecoverForScheduler` / `aiAssistForRun`。只读顾问在 `../advisor/`；本目录是**单独的、经过验证的执行器**。

| 文件 | 职责 |
|---|---|
| `recover.ts` | `aiRecoverUnknownScreen`：问询 → 风险闸门 → 前台检查 → 点击前新截图 + 目标稳定（确认：新截图二次评估 + 60 s 去重）→ 点目标框中心 → 等 900 ms → 复验 → 自学关闭模板 → 一条记录。从不抛异常 |
| `frame-diff.ts` | `meanAbsDiff`（shrink 4，< 6 = 画面没变）与 `stableTarget`（shrink 2，框外扩 160/240/80，均差 < 3 且变化像素 < 1.5 %） |
| `harvest.ts` | 关闭按钮自学：`tpl_btn_close_popup` → `_ai2` … 最多 8 张，16..420 px，裁剪外扩 3 px，`defaultRoi` 外扩 max(160, 2×)，标签 `ai-harvest` / `popup-close`，经模板库保存（方差守卫、原子写） |
| `update.ts` | `WorkerUpdateRecovery`：游戏数据模块的 `GameUpdateRecovery`（识别 → 点前重新识别、只点一次 → 最长 15 分钟可取消的等待、绝不重复点），识别部分交给实例的视觉工作线程回答（查询 `update`） |
| `service.ts` | `AiRecoveryService`：三条链路共用的路由 |

## 三条链路（主进程 `index.ts` 的「ai」段落接线）

| 链路 | 入口 | 已知界面判据 | 需要人处理时 |
|---|---|---|---|
| 采集 G0（盲按 BACK 之前）与开跑前的恢复阶梯 | `AutomationHost.setPorts({ adviseUnknownScreen })` → 视觉作业的 `advise` 请求 | 实例工作线程的 `recognize`（`isRecognizableScreen`） | 抛 `AI_RISK_BLOCKED` / `GAME_UPDATE_REQUIRED`：调度器暂停并告警；手动一轮由 `onNeedsAttention` 端口告警 |
| 调度采样（顶号探针之后） | `eta.setHooks({ onUnrecognizedFrame })` | 同上 | 同上；其它错误记 warn 按未处理继续 |
| 脚本执行（某步重试耗尽） | `ScriptRunner.setAiAssist` | 这一步本来在等的模板（`expectTemplateIds` 在模板集里的那几张） | `requiresAttention`（这一步判失败、不再重试）；`onNeedsAttention` 端口暂停该实例的自动采集并告警 |

顺序与原版一致：**先**交给游戏更新处理（AI 关着也跑；模板集里没有更新模板时静默跳过），**再**问 AI；AI 判定是低风险资源更新
（`download_update`，已点或建议不动）时复用更新等待，返回 `'updated'`。`GAME_UPDATE_REQUIRED` / `AI_RISK_BLOCKED` 先交给
`onNeedsAttention`，再原样上抛——调用方绝不在它们之后按 BACK。脚本链路的前提是 AI 顾问启用且计划配置 `aiAssist` 不为 false（原版）。

★ 顶号探针属于告警模块：它接线时把探针放在 `aiRecovery.recoverForSampler` 之前（原版顺序：顶号探针 → 更新 → AI），
命中就返回 `true`，不再问 AI。

## 安全边界

1. **`autoActions` 默认关**（DECISIONS A.3）：关着时执行器只问询并记录建议（`advised` / `blocked` / `no_action`），不点、不暂停，
   也不凭 AI 的一句话启动更新等待；调用方的兜底阶梯照常继续。
2. 只执行 `tap_close` / `tap_cancel` / `tap_confirm`；`back` / `none` 交回调用方自己的 BACK 阶梯（「BACK 之后必须取消退出框」只写一份）。
   本模块从不按键。风险较高的 `back` / `none` 在非主界面上要求人处理；模型认出是世界地图 / 城内 / 部队面板时绝不因此暂停（2026-09-18 教训）。
3. 确认动作：置信度 ≥ max(0.85, 配置)，点击前用新截图再问一次（跳过冷却、计入额度），按钮文字与后果必须一致，再核对画面稳定、前台包名，
   同一实例同一正文与按钮 60 秒内只点一次；确认按钮不学成模板。更新已在下载时（`allowUpdateConfirm = false`）绝不再确认。
4. 每次截图与点击都在该实例的设备车道上执行，并复核实例身份（`record.createdAt`）；每次点击前复核前台包名是游戏本身。
   坐标只在点击前从参考坐标换算到设备像素。
5. 点完必须复验：画面没变当没发生；变了但认不出只算 `applied`（重新判断）；回到已知界面才算 `verified`，才允许自学模板。
6. 模板匹配（复验、查重、更新识别）一律问实例的常驻视觉工作线程（只读查询，作业等待钩子时也能回答）；主线程不跑 OpenCV。
   帧比较用视觉层的 `prepareFrame`（参考尺寸的点采样或 sharp 的异步缩放）。
7. 脚本链路自己限时 170 秒（脚本线程 180 秒后不再等 AI），到点即中止，不会在脚本继续执行时还在点屏幕；
   因此脚本期间遇到的长时间游戏更新会在 170 秒后按未处理返回（原版会继续等，但脚本那边早已放弃）。

## 与原版的差异

- 执行器在主进程运行（原版也在主进程），但所有 OpenCV 匹配都交给实例的视觉工作线程；更新识别为此新增了只读查询 `update`
  （`scheduler/vision-protocol.ts` / `vision-worker.ts`，`WanlongGatherRunner.updateCheck`、`AutomationHost.checkGameUpdate`、
  `AutomationHost.matchTemplatesIn`）。
- 脚本链路的「已知界面」用实例工作线程按 shrink 2 编译的模板判断（原版按应用设置的 shrink），每张模板用它自己的搜索范围。
- 自学模板经 `AutomationHost.saveTemplateToSet` 保存（不拿设备租约、同样的库规则），它发出的模板变更通知会让所有视觉工作线程丢弃编译缓存、界面刷新模板页。
- 未验证：真机上 AVD 分辨率（如 960×540）下 16 px（参考坐标）最小模板、稳定与变化阈值是否仍合适，需要真机帧再确认。
