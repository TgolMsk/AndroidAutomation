# 基础实例与批量克隆（instances）

移植自 wanlong-panel 的 `instanceProvisioner.ts`（基础实例 + 克隆部分）与 `handlers/instance.ts` 的 `instance:base / setBase / create`。
实例的创建、删除、启动仍归 `@avdm/core` 与模拟器管理器；这里只做游戏相关的「基础实例」。

- `base-store.ts`：`~/.avdm/automation/<gameId>/base-instance.json` = `{version:1, base:{index,name,createdAt,setAt}|null}`，
  跨进程锁、0600、原子写。★ 文件损坏时报错并保留原文件，任何设置 / 克隆都不会覆盖它。
- `provisioner.ts`：`InstanceProvisioner`
  - `view(gameId)` 按实时实例校验：基础实例被删除或编号被新实例复用（创建时间不同）时自动取消，并在返回值 `cleared` 里说明一次。
  - `setBase(gameId, index | null)`：不接受创建中、已绑定账号或正在登录 / 采集 / 运行计划的实例；设置时关闭该实例的自动续跑。
  - `cloneFromBase(gameId, { count 1–8, expectedBaseIndex, rotateIdentity })`：基础实例必须存在、身份一致且已关机；
    按每个副本 4 GB 预检磁盘；持有源实例的设备租约（登录 / 采集 / 计划都拿不到）后调用 `AvdManager.clone`
    （同一个源一次复制、失败整体回滚）；默认给每个副本新的设备标识；副本继承基础实例的模板集与采集设置。
  - 设置与克隆互斥（同步占位），并通过 `instance-base-changed` 推送。
- 基础实例不能登录、不能绑定账号、不能运行自动化：见 `automation/accounts` 的就绪闸门。

原版的「部分成功时用列表差集报告新编号」不移植：core 的克隆是原子的，失败会回滚，不会留下半成品。
