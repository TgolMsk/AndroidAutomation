# 账号与登录（accounts）

移植自 wanlong-panel 的 `store/accounts.ts`、`login/coordinator.ts`、`login/nativeUi.ts`、`login/phoneDriver.ts`、
`login/verify.ts` 与 `main/index.ts` 的 `assertInstanceAutomationReady`。实例生命周期只走 `@avdm/core`。

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 渲染进程也会引用的契约（账号、登录会话、预览输入、就绪判定）。只有类型与纯常量 |
| `store.ts` | `~/.avdm/automation/accounts.json`（v2，读 v1 时自动升级）：跨进程文件锁、0600、原子写、4 MB 上限 |
| `index.ts` | `AccountManager`：账号编辑（与采集 / 计划共用实例租约）、改绑确认、自动化就绪闸门、登录向导协调 |
| `native-ui.ts` | UIAutomator 读取与万龙 SDK 手机号 / 验证码控件驱动；`LoginUserError` = 可以原样展示的错误 |
| `drivers.ts` | 每个游戏的登录适配器：SDK 命令 + 主界面判定模板（城内 A/B + 世界地图 A/B + 放大镜） |
| `home-verify.ts` / `home-match.ts` / `home-verify-worker.ts` | 登录检查：一帧只读截图，在工作线程里匹配主界面模板，任一在自身阈值上命中即通过 |
| `login-preview.ts` / `login-preview-worker.ts` | 登录抽屉内嵌画面的 JPEG 编码：常驻工作线程（首帧启动、空闲 20 秒退出），主线程不做 sharp 缩放 |
| `legacy.ts` | 旧版 `accounts.json` 预览；导入由 `AccountManager.importLegacyAccounts` 完成（可带脚本编号对照表） |

## 规则（照原版，目标仓库的加固全部保留）

- 一个实例（每个游戏）只绑一个账号；绑定记录实例的创建时间，编号被新实例复用时绑定作废、需重新登录。
- **改绑必须显式确认**：目标实例已有账号时 `accountBind` 返回 `ACCOUNT_SLOT_TAKEN`，界面确认后带 `takeOver: true` 重发；
  被顶掉的账号解除绑定、改为待登录并停用，该实例的采集调度关闭。原版是静默抢占，这里改为确认后抢占。
  ★ 占用检查在任何副作用之前：被拒绝（或用户在确认框取消）的改绑不会关掉任何实例的采集调度。
- 实例行「新建账号并绑定」走 `accountCreateAndBind`：一次事务里创建并绑定，编号由界面生成并在重试时复用；
  绑定被拒时不留下空账号，回复丢失后重试也不会多建一个（原版 `account:save` 带实例编号）。
- 普通编辑不能伪造登录状态；只有登录向导「检查主界面」通过后才启用账号；启用不会自动打开采集。
- 改名、备注、默认脚本不碰设备，只受「正在登录」约束（原版 `account:save` 的 `assertEditable`），采集或计划占着实例时也能改；
  绑定 / 解绑 / 删除 / 启停仍要拿实例租约。
- ★ 绑定会让账号变成「待登录」（同一实例原样重绑且已检查的除外），就绪闸门随后会拒绝该实例的每次自动续跑：
  所以绑定时若目标实例开着该游戏的自动采集，就先把它关掉，并在 `notice` 里告诉用户（改绑离开的原实例同样关闭并提示）。
- 登录向导：`preparing → starting → awaitingLogin → verifying → completed / cancelled / failed`。开始时同步登记会话
  （`loginActiveOn(index)` 立即为真：同进程的采集就绪闸门、基础实例克隆 / 取消、运行监控立即看到「正在登录」），
  随后（读完实例状态、关掉该实例的调度之后）取得跨进程实例租约并一直持有到结束。
  ★ 脚本计划目前**没有**接这个同步登记：计划只看账号是否已启用、已登录，并靠同一把实例租约互斥。登记与取得租约之间
  若有计划先拿到租约，登录会以「实例正被采集、脚本计划或模板操作占用」失败（安全，不会两个写入者），稍后「继续登录」即可。
  计划模块移植时应在开跑前调用 `assertInstanceAutomationReady(gameId, index)`（或 `loginActiveOn`）来提前让路。
  基础实例在任何副作用之前被拒绝；该实例没有模板集（登录检查无从进行）时也在取得租约之前拒绝，
  因为向导持有租约期间无法为实例选择模板集。新账号由界面生成 UUID，失败后「继续登录」复用同一账号。
- 启动实例（`starting`）期间「稍后继续」、关闭抽屉或退出应用立即生效，不必等开机完成（已发出的开机不撤销）。
- 游戏只用 monkey 拉起（`startApp(pkg)` 不带 activity）。
- 预览输入（点击 / 滑动 / 按键 / 数字）与 SDK 命令在同一队列里串行，每次都复核阶段、实例身份；点击和数字要求游戏在前台，
  按键不要求（便于从系统对话框「返回」）。坐标是 2560×1440 参考坐标，按真实截图尺寸换算。
- ★ 手机号和验证码只存在于调用期间：会话只返回掩码号码；core 的 adb 错误会带完整命令行（含号码），所以设备错误一律换成固定中文，
  只有 `LoginUserError` 原样返回。登录画面不保存、不发给 AI。
- 就绪闸门 `assertInstanceAutomationReady(gameId, index)`：基础实例、登录进行中、绑定账号待登录或实例已替换时拒绝；
  未绑定账号的实例放行。`AutomationHost` 在启用 / 恢复自动续跑、每次读部队面板与每次开跑前取它的判定 `readiness(gameId, index)`
  （组合根接到 `automationReadiness` 钩子），关闭调度永远不经过它。
  ★ 定时唤醒被闸门判为「不就绪」不算失败（原版告警铁律 1）：宿主抛 `AUTOMATION_NOT_READY`，ETA 调度器立即
  `setAuto(false, 原因)` 暂停该实例（失败计数清零，不走 8 次退避、不报「连续失败」），落盘后经 `onSchedulePause` 记一条
  「自动续跑已暂停（不计为失败）」提醒；手动开跑 / 启用调度时照常把原因抛给界面。闸门本身出错（例如账号文件读不出）才按普通失败计数、退避。
- 旧版 `accounts.json` 导入只增不改：新账号记下旧编号（`legacyId`），再次导入同一文件时这些行在预览里标为「已导入过」、
  应用时跳过并映射到已有账号（`idMap` 仍然完整，供计划导入使用）。文件缺失 / 无权限 / 不是文件都给中文提示。
- 采集配置跟随账号（DECISIONS B「调度器」）：`gatherConfigFor(gameId, index)` 读绑定账号（按实例身份校验）里的
  `scriptParams.gather.configJson`，`saveGatherConfig(accountId, config | null)` 写回。调度器模块已经把采集设置改成
  「先读绑定账号、没有再回落到实例文件」（`AutomationHost.settings` / `saveSettings`、采样与每轮开跑，端口
  `accountGatherConfig` / `saveAccountGatherConfig`），所以组合根接上了 `instanceGatherConfig`（`AutomationHost.instanceGatherConfig`）：
  绑定会把实例上的配置搬进账号（账号已有配置时不覆盖并提示），解绑时提示配置留在账号里。

## 与原版的差异

- 原版「无 setup 的旧账号不受登录检查约束」不移植：目标仓库所有账号都必须通过登录检查才能启用（旧账号导入后为待登录）。
- 并发开机上限由 core 的准入控制负责（`ADMISSION_DENIED`），不再在协调器里另算。
- MuMu 实例身份换成 AVD 的 `record.createdAt`；手机号 SDK 控件表见 `docs/AUTOMATION.md`「万龙登录控件」。
