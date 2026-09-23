# AVD 多开管理器 — 设计说明（实现者契约）

目标：在 Apple Silicon macOS 上，基于 Google 官方 Android Emulator（arm64 镜像，HVF 虚拟化，gfxstream→Metal）
自研一个多开管理器，提供 CLI（`avdm`）与 Electron 桌面客户端，二者共用 `@avdm/core`。个人自用。

**硬性约定**
- 所有面向用户的文案（错误信息、CLI 输出、UI）用简体中文；代码标识符/注释用英文。
- 当前可验证的标识包括序列号、Wi-Fi 接口 MAC、Android ID 系统值与每用户 SSAID 种子轮换，以及应用可见的部分 `Build.*` 属性。IMEI、硬件证明、内核/图形/模拟器特征不在当前覆盖范围；不得在 UI 宣称所有应用会读到同一 Android ID 或设备已成为真机。
- 不依赖 Java：不调用 sdkmanager/avdmanager，AVD 文件与 SDK 安装都由本项目直接完成。
- 接受 SDK 许可只能在用户明确同意后发生（CLI 交互确认 / `--accept-licenses`，GUI 勾选同意）。
- 仅 `packages/core/src/types.ts` 定义共享类型；各模块对外签名以 stub 文件为准，不得更改导出签名（可新增内部 helper / 新导出）。
- 运行平台：macOS arm64 优先；Linux/Windows 代码路径尽量不崩（best-effort）。

## 目录
```
packages/core      @avdm/core  (ESM, tsc → dist/)
  src/types.ts constants.ts errors.ts paths.ts settings.ts   ← 已实现（契约）
  src/util/{ini,selector,fs,proc}.ts                         ← 已实现
  src/registry.ts                                            ← core-avd
  src/avd/avdfiles.ts                                        ← core-avd
  src/sdk/{catalog,http,locate,installer}.ts                 ← core-sdk
  src/emulator/{discovery,launcher,console}.ts               ← core-emu
  src/adb.ts src/grpc.ts src/host.ts                         ← core-emu
  src/manager.ts src/scripts.ts                              ← core-manager
  proto/emulator_controller.proto                            ← 官方 proto（Apache-2.0）
  test/*.test.ts (vitest)
packages/cli       @avdm/cli   (commander)                   ← cli
packages/desktop   @avdm/desktop (electron-vite + React)     ← desktop
  src/shared/ipc.ts                                          ← 已定义（IPC 契约）
```

## 管理器目录（~/.avdm，可用 AVDM_HOME 覆盖）
`settings.json`、`instances.json`、`avd/`（作为 ANDROID_AVD_HOME）、`logs/instance-<i>.log`、`logs/scripts/<runId>.log`、
`run/instance-<i>.json`（RunRecord）、`scripts/<id>/script.json`、`cache/downloads/`。

## 端口与命名
index ∈ [0,63]：console = 5554+2i，adb = console+1，grpc = 8554+i，serial = `emulator-<console>`，AVD 名 `avdm_<i>`。

## §registry（core-avd）
- `instances.json` = `RegistryFile {version:1, instances:[]}`；所有写操作 `withFileLock(registryFile + '.lock')` + `atomicWriteJson`。
- 只有**文件不存在**才表示“没有实例”。空文件、只有空白、没有 `instances` 数组都按“已损坏”报错（`INVALID_ARGUMENT`），
  绝不当作空注册表：否则下一次 create 会从 #0 重新分配，压在旧实例的 AVD 上。
- `atomicWriteFile`：写临时文件 → `fsync` → rename（APFS 上掉电/崩溃不会留下 0 字节文件）。
- `withFileLock` 持锁期间每 staleMs/3 刷新锁目录 mtime（长时间的克隆拷贝不会被别的进程当作崩溃遗留的锁而抢走）；`isLockHeld()` 只查不抢。
- `allocate(count, build)`：锁内读取 → 找最小的 count 个空闲 index → `build(i)` → 写回。不足时抛 `NO_FREE_INDEX` 且不写入。
- RunRecord 存 `run/instance-<i>.json`（原子写）；`remove()` 同时删除 run 记录。
  跨进程的“先读后删/改”一律用 `clearRunIf(i, predicate)` / `updateRunIf(i, mutate)`（在 run 锁内重读再比较 pid+startedAt），
  不会误删另一个进程刚写入的新启动记录。RunRecord 另有可选字段：`stopTimeoutMs`（停止请求的时限）、
  `discoveryFile`（模拟器注册后的 discovery 文件）、`crashedAt`（已判定为崩溃）。

## §avd（core-avd）
`<avdHome>/<avdName>.ini`:
```
avd.ini.encoding=UTF-8
path=<avdHome>/<avdName>.avd
path.rel=avd/<avdName>.avd
target=<image.platform>        # e.g. android-35
```
`config.ini`（新建时）：
```
AvdId=<avdName>
avd.ini.displayname=<record.name>
avd.ini.encoding=UTF-8
PlayStore.enabled=<tagId 含 playstore ? true : false>
abi.type=arm64-v8a
hw.cpu.arch=arm64
image.sysdir.1=<image.sysdirRel>        # 相对 SDK 根，带结尾斜杠
tag.id=<tagId>
tag.display=<tagDisplay>
hw.cpu.ncore / hw.ramSize / hw.lcd.width / hw.lcd.height / hw.lcd.density
disk.dataPartition.size=<GB>G
hw.gpu.enabled=yes
hw.gpu.mode=<host|swiftshader_indirect(software)|auto>
hw.keyboard=yes  hw.mainKeys=no  hw.sdCard=no  hw.audioInput=no
hw.accelerometer=yes hw.gyroscope=no hw.sensors.orientation=yes hw.sensors.proximity=no
hw.camera.back=none hw.camera.front=none hw.gps=yes hw.battery=yes
hw.initialOrientation=<width>height ? landscape : portrait>
fastboot.forceColdBoot=no  fastboot.forceFastBoot=yes
showDeviceFrame=no  skin.dynamic=yes  skin.name=<w>x<h>  skin.path=_no_skin
vm.heapSize=512
hw.gltransport.drawFlushInterval=1600   # TapTap 模拟器同值，减少 guest→host flush 通知
runtime.network.latency=none  runtime.network.speed=full
```
- `specToConfig(spec)` 只返回随 spec 变化的键（ncore/ramSize/lcd*/dataPartition/gpu.mode/initialOrientation/skin.name）。
- 克隆：见 stub 注释。qemu-img 路径：`sdk.emulator.qemuImg`（通常 `<sdk>/emulator/qemu-img`）。
  用 `qemu-img info --output=json <file>` 读 `backing-filename` / `backing-filename-format`。
  数据分区扩容仅在克隆/改 spec 时改 config（emulator 启动时自行 resize）。
- `avdDiskUsage` 用 `du -sk`（APFS 克隆会被 du 计为实际占用；可接受，注释说明）。
- `clone --keep-snapshots`：保留的 `snapshots/*/hardware.ini` 里 `avd.id`/`avd.name` 和 `disk.*.path` 仍指向源 AVD，
  真机上 emulator 会报 “hardware cannot load snapshot” 然后冷启动。克隆时把等于源 AVD 名的值改成新名、把源目录内的绝对路径
  改到克隆目录（其余行逐字节保留）；实测改后克隆 2.2s 载入快照、数据正确。客体内 `ro.boot.qemu.avd_name` 仍是源名（来自快照内存）。
- 删除：`deleteAvd` 先把 `<name>.avd` 原子改名为 `<name>.avd.deleting-*` 再递归删除；`remove()` 在 launch 锁内完成这一步。
  中途崩溃留下的 `.deleting-*` 可以放心清理（`purgeRetiredAvds`）。
- 分配到某个编号时若发现**未登记**的 `avdm_<i>.avd`（注册表丢失/重置、旧版本遗留），不删除，移到
  `avd/orphaned/avdm_<i>-<时间>/` 并发 warn 日志；回滚只删除本次调用真正创建出来的 AVD。
- Quick Boot 快照标记 `<avd>/.avdm-snapshot-stale`（见 §manager“快照与磁盘一致性”），随克隆一起复制。

## §sdk（core-sdk）
- Manifest：`https://dl.google.com/android/repository/repository2-3.xml`（emulator、platform-tools），
  系统镜像：`sys-img/<tag>/sys-img2-4.xml`（tag: android→`default`、google_apis、google_apis_playstore）。
  注意 sys-img XML 的 `<archive>` url 是相对 manifest 目录（如 `arm64-v8a-35_r02.zip` → `…/sys-img/android/arm64-v8a-35_r02.zip`）。
  repository2-3.xml 中 url 相对 `…/repository/`。
- 包路径：emulator 的 `<archive>` 带 `<host-os>macosx</host-os><host-arch>aarch64</host-arch>`；
  同一 path 可能有多个 remotePackage（不同 channel），选 channel-0 最高 revision。
- revision 字符串 = major[.minor[.micro[.preview]]]。
- License：`<license id="android-sdk-license" type="text">…</license>`（XML 实体需解码：&lt; &gt; &amp; &quot; &apos; 以及 &#NN;）。
- 下载：curl `--fail --location --retry 3 --connect-timeout 30 -C - -o <part>`，`resolveProxyEnv()`：
  若 env 已有 https_proxy/HTTPS_PROXY/http_proxy/ALL_PROXY 则沿用；否则 macOS 上解析 `scutil --proxy`
  （HTTPSEnable=1 → HTTPSProxy:HTTPSPort；否则 HTTPEnable）。NO_PROXY 包含 localhost,127.0.0.1。
- 校验 SHA-1（node:crypto 流式）。解压：`/usr/bin/unzip -q -o <zip> -d <tmp>`（保留可执行位与 symlink）。
- 安装目标见 `packageInstallDir`；系统镜像 zip 顶层目录名是 abi（`arm64-v8a/`）。
- `locateSdk`：emulator 版本读 `<sdk>/emulator/source.properties` 的 `Pkg.Revision`；
  镜像读 `<dir>/source.properties`（`SystemImage.TagId`、`SystemImage.TagDisplay`、`Pkg.Revision`、`AndroidVersion.ApiLevel`），
  也兼容我们写的 `.avdm-package.json`。遍历 `system-images/*/*/*/` 且含 `system.img` 的目录。
  `acceptedLicenses`：`<sdk>/licenses/` 下文件名列表。

## §emulator（core-emu）
- 启动参数与环境见 `launcher.ts` stub。`-gpu software`（emulator ≥36.4.9 支持，旧版回退 `swiftshader_indirect`）。
- `-no-metrics` 仅在 `emulator -help` 输出包含时添加（`getSupportedFlags` 解析 `-help` 中形如 `^\s+-[a-z0-9-]+` 的行）。
  超时/被杀的 `-help` 只输出了一部分，不缓存（下次重新探测）。
- gRPC 必须带鉴权（fail closed）：`-grpc <port>` 只和 `-grpc-use-token` 一起出现；`-help` 列出该参数，或 emulator 版本
  ≥ `MIN_EMULATOR_VERSION`（36.6.11，所有受支持版本都有）即可；两者都不满足时**不开 gRPC**（管理器退回 adb），
  绝不启动无鉴权、监听 `*:<port>` 的 gRPC。
- 实例日志 `logs/instance-<i>.log` 在启动前超过 1 MB 时轮转为 `.log.1`（覆盖旧的 `.1`）；删除实例/复用编号时两者一起删。
- spawn：`spawn(bin, args, { detached: true, stdio: ['ignore', fd, fd], env })`，fd 为以 'a' 打开的日志文件；`child.unref()`；
  监听 'error' 以在 spawn 失败时 reject；成功以 'spawn' 事件 resolve。
- discovery：见 stub；pid 从文件名 `pid_<pid>.ini` 取；`avd.name`、`port.serial`、`port.adb`、`grpc.port`、`grpc.token`、`avd.dir`、`emulator.version`。
  被 SIGKILL/崩溃的 emulator 会留下 discovery 文件，macOS 又会复用 pid：只有**进程启动时间不晚于文件 mtime**（`ps -o etime=`，
  容差 2s）的条目才算数；`kill(pid,0)` 返回 EPERM（别的用户的进程）一律视为不存活——我们的模拟器都以当前用户运行。
- console：`net.connect(port,'127.0.0.1')`，读到首个 `OK` 后若 banner 含 `auth_token` 则 `auth <token>\n` 等 OK，
  再发命令等 `OK`/`KO:`；`kill` 命令之后连接会被对端关闭，视为成功。

### 真实 Emulator 实测结论（emulator 37.1.11 / AOSP android-35 arm64 / M4 24GB，2026-09-23）
测试时本机同时开着其他应用（负载 3–6）。所有测试都在临时 AVDM_HOME 中进行。

**接口与文件**
- discovery 文件中 **`avd.id` 才是 AVD 名**（`avdm_<i>`），`avd.name` 是显示名（avd.ini.displayname）→ 匹配必须优先用 `avd.id`。
- 仅 `-grpc <port>` 时 gRPC 监听 `*:<port>` 且无鉴权（整台设备可被局域网控制）；加 `-grpc-use-token` 后监听 `127.0.0.1`、
  需要 `authorization: Bearer <grpc.token>`（token 由 emulator 写入 discovery 文件）。launcher 在支持时总是加此参数。
  实例日志里对应 `Started GRPC server at 127.0.0.1:<port>, security: Local, auth: +token`；discovery 文件权限 0600。
  token 不出现在 `list`/`doctor`/`start`/`restart` 的 `--json` 输出、实例日志和 run 记录里（`--json` 只有 `grpcAuth: true/false`）。
- console / adb 端口只绑定 127.0.0.1 / ::1。adb 端口超出 5555–5585 时 emulator 会告警，但仍会主动向 adb server 注册（`adb devices` 可见）。
- `emulator` 启动器会 exec 为 `qemu/darwin-aarch64/qemu-system-aarch64-headless`（`-no-window` 时），PID 不变。
  `--window` 时是带窗口的 `qemu-system-aarch64`（作为前台应用出现在 Dock），两种方式存的快照可以互相加载。
- qcow2 overlay 的 backing 文件是**相对路径**（`userdata-qemu.img` 等），APFS 克隆后天然指向克隆自身的底层文件。
- 关闭窗口 / `adb emu kill` 时 emulator 正常退出（保存快照、退出码 0）并删除自己的 discovery 文件；崩溃/SIGKILL 时文件保留。

**启动与停止**（`avdm start --wait` / `avdm stop` 的总耗时）
- 新 AVD 冷启动 16–17s（emulator 日志 `Boot completed in` 11.8–16.0s）；2 个同时冷启动 17–20s。
  冷启动模式实例的第二次启动 8.7s；改规格后首次启动 12s（emulator 报 “different AVD configuration” 后干净地冷启动，无损坏）；
  `-gpu software`（`hw.gpu.mode=swiftshader_indirect`）冷启动 20s，截图渲染正常。
- Quick Boot 4.6s（快照加载 0.35–0.6s，负载高时 1.3–1.8s）；3 个同时 5.9s；`restart --wait` 8.8s。
  用窗口模式存的快照无窗口启动 2.3s；窗口模式启动 7.4s。
- 优雅停止 1.3–3.3s（窗口模式 4.1s）。冷启动后的第一次保存快照约 1.5s；之后的保存日志显示 “0 ms”（客体内存本来就映射在快照文件上）。
  连续 30 多次启停，快照一直有效。`--cold-boot`（`-no-snapshot`）不存快照，停止 1.9s；AVD 目录 780MB，而带快照的是 2.7GB
  （其中 snapshots/ 1.8GB）。
- 两个 `avdm start 0` 同时执行 → 只启动一个模拟器，两边都报成功；两个 `avdm stop 0` 同时执行也都干净地完成。
  快速连续 stop/start/restart 3 轮：全部成功，没有残留的 run 记录，discovery 目录里只有在运行的那个文件。
  启动中被停止后 `adb devices` 会短暂显示 offline，5s 内消失。
- 冷启动进行到 5–9s 时用 console `kill` 优雅停止，emulator 会把半启动的 VM 存成 `default_boot` 快照；之后每次启动都加载失败
  （`error while loading state for instance 0x0 of device 'goldfish_pipe'`）并卡死在 adb offline，只有删掉该快照才能恢复。
- Quick Boot 会连同磁盘一起回滚（qcow2 内部快照）：崩溃/`kill -9` 后再用快照启动，上次正常关机之后写入的数据全部丢失，
  即使已经 `sync`；用 `-no-snapshot-load` 冷启动则数据还在（约 13s）。（已处理：见 §manager“快照与磁盘一致性”，实测崩溃后的
  自动重启带 `-no-snapshot-load`。）
- 快照加载后 gRPC `getStatus().booted` 立即为 true，但 adb 仍 offline 约 0.6s；从损坏快照恢复的 VM 也会报 booted=true。
- 被 SIGSTOP 冻结的模拟器：`avdm stop` 经 console 超时 → SIGTERM/SIGKILL 仍以 0 退出；`avdm list` 把它显示为“开机中”
  （gRPC 1.5s 超时再加 adb，list 耗时 1.64s），没有“卡死”检测。

**崩溃与监控**
- `kill -9` 之后 `avdm list` 立即显示“异常”，`--json` 带日志末尾。开了自动重启时 `avdm monitor` 在第一次检查（≤5s）就重启，
  15–16s 后回到“运行中”（冷启动）；monitor 启动时已处于“异常”的实例也会被重启。连续崩溃时重启 3 次后第 4 次记录
  “10 分钟内已自动重启 3 次，暂停自动重启”。monitor 收到 SIGINT 干净退出；自动重启进行中按 Ctrl-C，会等这次启动完成
  （约 0.6s）再退出，run 记录完整。
- monitor 每 5s 轮询一次，太短的状态会漏掉（启动和被杀都落在两次检查之间时，只记录到 开机中 → 异常）。
  restart() 会依次经过 异常 → 已停止 → 启动中（外观问题）。

**图形驱动与游戏兼容性（万龙觉醒 1.0.52.18，Unity 2022.3 IL2CPP arm64）**
- 默认 GL 翻译层（`ro.hardware.egl=emulation`）把 GLES 映射到 macOS OpenGL 4.1：客体最高 **GLES 3.0**
  （`ANDROID_EMU_gles_max_version_3_0`），**无 ASTC**。Unity 创建 ES 3.2/3.1 上下文失败（`EGL_BAD_CONFIG: no ES 3.2/3.1 support`），
  回落 ES 3.0 后游戏自检弹“设备不支持当前游戏”。网易易盾（LGNHProtect）初始化成功（code 200），与模拟器检测无关。
- `-feature GuestAngle`：客体用 ANGLE（`ro.hardware.egl=angle`）跑在客体 Vulkan 上（gfxstream → MoltenVK → Metal，Vulkan 1.3.0），
  得到 **GLES 3.1** + `GL_KHR_texture_compression_astc_ldr`，游戏通过自检进入用户协议界面。系统镜像已自带 ANGLE 库。
- 切换驱动后旧 Quick Boot 快照不兼容（`The emulator has the feature: 102, which is missing in the snapshot`），emulator 自动冷启动，数据保留。
- 因此 `InstanceSpec.glDriver` 默认 `angle`（launcher 传 `-feature GuestAngle`；`translator` 传 `-feature -GuestAngle`；software GPU 不传）。
  `avdm diagnose <i> [包名]` 可只读检查 GLES/ASTC/Vulkan/ABI/内存与应用最近崩溃。

**帧率与稳定性（万龙觉醒最低画质，世界地图场景，SurfaceFlinger 帧呈现时间统计）**

| 配置 | 平均帧率 | p50 / p90 / p99 帧时间 | >50ms 帧 | 备注 |
|---|---|---|---|---|
| 无窗口 8核/8G + 桌面实时画面（设置菜单场景） | 30 | 33 / 50 / 67ms | 12–14/127 | 实时画面经 gRPC 传原始帧（约 32MB/s）且限 30fps，观感再打折 |
| 原生窗口 8核/8G，关 VulkanNativeSwapchain，flush 1600 | 36–40 | 21–24 / 43–47 / 57–81ms | 2–11/126 | 加载快（90s 进地图） |
| 原生窗口 4核/4G，同上 | 29–30（锁 30） | 33 / 34–50 / 50–74ms | 2–14/126 | 多数时段很稳；加载明显慢；主机内存压力回到 normal |

- 原生窗口 + VulkanNativeSwapchain（默认开）：游戏创建 VkDevice（ASTC 走 GPU 解压管线）后 emulator `abort()`（crashpad minidump）。
  关掉后窗口模式两次都能进游戏；其中一次加载时渲染线程在 `on_vkWaitForFences` 空转 100% 卡死（偶发，重启游戏即恢复）。
  → launcher：有窗口时自动 `-feature -VulkanNativeSwapchain`。
- emulator 崩溃后，下一次**有窗口**启动会弹“发送崩溃报告？”同意对话框并阻塞启动（表现为 240s 启动超时）；
  → launcher：支持时总是 `-crash-report-mode never`（不弹框、不上传）。
- 主机侧 MoltenVK 不暴露原生 ASTC，gfxstream 用 GPU 管线解压 ASTC（日志 `ASTC emulation:on … ASTC decoder: NewRgb`），有额外开销。

**画面、截图与输入**
- gRPC 帧总是面板原始方向：竖屏 720×1280 的实例帧就是 720×1280；Android 旋转后帧仍是面板方向，触控也要用面板坐标
  （rotation 1 时 `px = W − ly`、`py = lx`）。桌面端实时画面据此转正显示并反向映射触点，实测旋转后点到的位置正确。
- gRPC 截图只给 `width`（或只给 `height`）时**不缩放**，返回原始尺寸；两者都给时按“放进这个框、保持比例”缩放
  （`avdm screenshot --width 320` 经 `fitScreenshotBox` 得到 320×180）。
- `getScreenshot`，1280×720、内容滚动中、host GPU，50 次（p50 / p95）：RGB888 原始 6.9 / 9.9ms，RGB888 640×360 2.3 / 3.6ms，
  PNG 原始 12.7 / 13.5ms，PNG 320×180 1.5 / 2.2ms。1920×1080 时 RGB888 15–25ms、PNG 约 60ms（1.46MB）。
  带壁纸的主屏幕（静止，20 次）：PNG p50 30ms（software GPU 35ms），RGB888 p50 7.5ms（8.8ms）。PNG 耗时随内容变化很大（13–60ms）。
  `adb exec-out screencap -p` ≈278ms；gRPC `sendTouch` 按下+抬起 2–3ms。
- `streamScreenshot`，单实例、客体内 `input swipe` 循环滚动设置页，各 10s（只滚动本身 qemu CPU 43%）。`timestampUs` 是
  epoch 微秒，延迟 = 收到时间 − timestampUs：

  | 请求 | 帧 | fps | 吞吐 | 延迟 p50 / p95 | qemu CPU | 客户端 CPU |
  |---|---|---|---|---|---|---|
  | rgb888 只给 width（1280 或 640） | 1280×720 | 58–60 | 161–165 MB/s | 5.5 / 8–10ms | 69–70% | 15–18% |
  | rgb888 框 640×360 | 640×360 | 59.7 | 41 MB/s | 2.2 / 2.9ms | 53% | 6% |
  | png 只给 width 640 | 1280×720 | 59.9 | 3.7 MB/s | p50 11.6ms | 101% | 2% |
  | png 框 640×360 | 640×360 | 59.9 | 1.6 MB/s | p50 3.8ms | 57% | 1% |
  | png 原始 | 1280×720 | 57 | 3.5 MB/s | 11.7 / 20.6ms | 107% | 2% |

  画面静止时 8s 只来 1 帧（按变化推送）。gRPC 可达 60 fps，桌面端最多 30 fps（`MIN_FRAME_INTERVAL_MS` 33）。
  同一进程 3 路流，每路仍约 60 fps：rgb888 只给 width → 1280×720，合计 496 MB/s、客户端 CPU 46%、qemu 各 69–75%、延迟 4–5ms；
  rgb888 框 640×360 合计 124 MB/s、客户端 14%、qemu 各 41–44%、延迟 1.4–1.7ms；png 框 640×360 合计 5 MB/s、客户端 3%、
  qemu 各 51–56%。所以桌面端请求时要同时给 width 和 height。
- `sendKey`（设置页搜索框）：keypress a / A / 1 / 空格、keydown+keyup b / B / !（B 不需要 Shift）、Backspace、Enter 都正常；
  GoBack / GoHome / AppSwitch 正常（多任务界面有截图为证）；“中”和文本里的中文被静默丢弃。
- `adb shell input text` 遇到中文直接抛 Java NullPointerException；`%s` 一律变成空格且无法转义；Tab 等控制字符被丢弃
  （空格、单双引号、`` & ; | $ ` ( ) < > * ? ~ # ! `` 和反斜杠正常）。`planInputText` 按此处理：中文拒绝，`%s` 拆开发送，Tab/换行改为按键。

**克隆**
- APFS 克隆 0.13–0.15s。默认克隆（不带快照）冷启动 8.8–12.8s；源实例停止前写入的标记文件在所有克隆里都在（停止前 `sync` 生效），
  网络正常。`--keep-snapshots` 修正前冷启动 11.7s（hardware.ini 不匹配），修正后 2.2s 载入快照（见 §avd）。
- 克隆一个崩溃（kill -9）的实例：锁文件和 hardware-qemu.ini 被排除，已 sync 的数据在、未 sync 的数据丢失（符合预期），
  冷启动 10.1s，无 qcow2 错误，源实例保持“异常”。
- 冷启动的克隆 `ro.boot.qemu.avd_name` 是各自的 AVD 名。客体序列号 `EMULATOR37X1X11X0` 在所有实例上相同（官方模拟器行为，本项目有意不改）。
- 改规格（1920x1080 / 320dpi / 4096MB / 4 核）后客体内 `wm size` 1920x1080、density 320、MemTotal 4015044 kB、nproc 4。

**资源与准入**
- 3GB 配置实例**冷启动** 2 分钟后 RSS 1061MB、footprint 1158MB（HVF 按需分配）；**Quick Boot 启动**的实例 `ps` RSS 只有
  320–494MB，但 footprint 2147–2369MB、top MEM 2.7–3.0GB（客体内存是 mmap 的快照 ram.bin，`ps` RSS 严重低估；vm_stat 仍把它
  算进 inactive，“可用内存”因此偏高）。AVD 目录（含 Quick Boot 快照）≈2.7–3.5GB。
- 3 个默认规格实例空闲时 qemu 合计 17–19% 单核 CPU（每个 5–8%）。3 个 Quick Boot 实例时内存压力从 normal 升到 warn、
  swap 用了 3.8/5.1GB，而 hostStats 的 availableMemMb 仍有 5664–5951MB：按旧规则（可用 − 1843 ≥ 保留 2048）第 4 个会被放行，
  `doctor` 只提示“内存压力 偏高”。现在的准入规则（Quick Boot 按 0.8×内存估算；warn 且在用 swap 且已有实例在运行时拒绝）会拒绝它。
- `avdm doctor`：12 项通过、1 项警告（未装 scrcpy）；可用 9.0GB 时提示“约还可启动 3 个默认规格实例”。

**桌面端（真机）**
- 主窗口显示真实实例的缩略图和正确状态；实时画面窗口显示真实画面，静止时帧率标签显示“画面静止”（旧版显示 “0 fps”）。
- 竖屏 720×1280 实例在设置页旋转到横屏（ROTATION_90）后，实时画面窗口变成横向并正着显示；在窗口里点“Network & internet”
  （逻辑坐标 309,606）确实打开了对应的子页面。
- 窗口被其他窗口完全遮住时 Chromium 会暂停 requestAnimationFrame，画布不会更新（经 CDP 自动化时要先把窗口置前）。

## §adb（core-emu）
- 始终用 SDK 的 `platform-tools/adb`；每次调用 `execFileText`；`-s <serial>`。
- `devices -l` 解析：`<serial>\t<state> key:value …` 或多空格分隔。
- `screencapPng` 用 `execFileBuffer(adb, ['-s', s, 'exec-out', 'screencap', '-p'])`。
- `text()`：空格→`%s`，对 `\ ' " ( ) & < > | ; * ~ $ \` ` 转义，按 shell 单参数传递。`planInputText()` 先拆分：
  非 ASCII 直接拒绝（中文提示“暂不支持输入中文等非 ASCII 字符”）；字面量 `%s` 拆成两次 `input text`（“…%” + “s…”）；
  Tab/换行改为 `input keyevent 61/66`；其余控制字符拒绝。每个字符都会被输入，不会静默丢弃。

## §grpc（core-emu）
- `@grpc/proto-loader` `loadSync(protoPath, { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true })`，
  服务 `android.emulation.control.EmulatorController`；`grpc.credentials.createInsecure()`，目标 `localhost:<port>`；
  有 token 时每次调用附 metadata `authorization: Bearer <token>`。
- `getScreenshot`：`ImageFormat{ format: PNG|RGBA8888|RGB888, width, height, display }`；返回 `Image.format.width/height`（新）或 `Image.width/height`（旧，已弃用）。
  真机只在 width 和 height **都给**时缩放（放进框内、保持比例）。要 W 像素宽的画面，用 `fitScreenshotBox({width: W}, 面板尺寸)`
  补出另一边（向上取整，保证 W 是生效的一边），再把两者一起发送；`streamScreenshot` 同理。
- `sendKey`：`KeyboardEvent{ eventType, key, text }`（W3C key 名）。`sendTouch`：`TouchEvent{ touches:[{x,y,identifier,pressure}] , display }`。
- `setVmState`：`VmRunState{ state }`。
- 所有 unary 调用带 deadline（默认 5s）。

## §host（core-emu）
见 stub。`vm_stat` 首行 `page size of 16384 bytes`；行格式 `Pages free:  12345.`。

## §manager（core-manager）
- `open()`：`resolvePaths` → 建目录 → `loadSettings` → `locateSdk(settings.sdkRoot)` → Registry → ScriptRunner（事件转发为 manager 事件）。
- 状态计算见 `manager.ts` 类注释；`list()` 一次性读取 discovery（`listRunningEmulators()`）与所有 run 记录，
  对 process-up 的实例并发查询 boot（gRPC getStatus 1.5s 超时 → 失败则 adb getprop），结果缓存 boot=true（同 pid）避免重复查询。
- 状态变化时 emit `'instance-state'`（monitor 与 start/stop 流程都要 emit）。
- 匹配 discovery 条目：条目带 `avd.dir` 时（当前所有版本都带）以目录为准，与本 home 的 `avd/avdm_<i>.avd`（含 realpath，
  兼容软链接的 AVDM_HOME）不符就**不是我们的**，除非 pid 正是我们启动的那个；只有不带 `avd.dir` 的旧版本才退回“名字 + 控制台端口”。
  另一个 AVDM_HOME（桌面端 ~/.avdm 与 CLI/测试的临时 home）用的是同样的 `avdm_<i>` 名字和端口，只看名字和端口会把对方的模拟器
  当成自己的并去停止它。启动时对方占着端口 → 报端口冲突（带对方的 AVD 目录）。
- run 记录里的 pid 只有在进程启动时间不晚于 `startedAt`（+2s）时才算我们的；否则是被复用的 pid（重启 Mac、SIGKILL 之后常见），
  按崩溃处理，且**永远不会向它发信号**。`signalTree` 拒绝 pid ≤ 1 与自身进程。
- 开机判定 `probeBoot`：gRPC 可达时，booted=false 为确定的“未开机”；booted=true 还要 adb `getprop sys.boot_completed`=1
  才算 running（没装 platform-tools 时只看 gRPC）；gRPC 不可达时由 adb 决定；两者都不可达为 unknown。超过 bootTimeoutSec 后：
  确定“未开机” → 立即报启动超时；unknown/adb 未就绪要持续 30s（本进程内）才报，避免新启动的 monitor 因一次探测失败
  就把运行了几个小时的实例判成超时并自动重启。启动超时的日志里有快照加载失败时，错误信息附带“停止后再启动会自动冷启动并重建快照”。
- 进程退出分类：有停止请求 → 已停止；模拟器注册过（run 记录的 `discoveryFile`）且自己删掉了 discovery 文件 → 用户主动关闭
  （关窗口、`adb emu kill`、客体关机）→ 已停止，不自动重启；否则为崩溃（`crashedAt` 持久化，之后别的 emulator 启动时清理掉
  残留文件也不会变成“正常退出”）。进程还在但 discovery 文件已被撤下 → 停止中（正在保存快照）。
- 停止请求超过其时限（`stopTimeoutMs`，默认 60s）+45s 仍未完成且本进程没有在停止它 → 状态 error“停止未完成”（不自动重启）；
  再次 stop 会重新执行停止，start 会撤销这个遗留的停止请求。
- `create()`：校验镜像已安装（`IMAGE_MISSING` 提示运行 `avdm sdk install`）→ `allocate`（record.provisioning=true）→
  `createAvd` → provisioning=false；失败回滚删除记录与文件。名称默认 `<prefix>-<index>`，prefix 默认“实例”。
- 名称：create/clone/update 共用校验，禁止换行等控制字符（会在 config.ini 里注入新键），最长 64 个字符；前缀最长 61 个字符（`前缀-63`）。
- `clone()`：源必须 stopped（`INSTANCE_RUNNING`）；复制 spec/image，`clonedFrom`；逐个 `cloneAvd`。
- `update()`：spec 变更需 stopped；`validateSpec`；`updateAvdConfig`。改 bootMode 时标记快照过期。
- 跨进程互斥：`run/launch.lock` 包住 准入+端口检查+spawn+写 run 记录；clone 在整个拷贝期间持有源实例的
  `run/instance-<i>.busy` 锁，remove 在删除期间持有自身的 busy 锁，二者都在 launch 锁内复查“没有在运行”；launch 在锁内看到
  busy 锁就拒绝（“正在被克隆或删除”）。spec 变更的“检查未运行 + 写 config.ini”也在 launch 锁内完成。
- `start()`：见 stub；写 RunRecord（pid、ports、argv、startedAt）；emit state；`wait` 时 `waitForBoot`。
  启动前确认 console/adb/grpc 端口未被占用（被非本实例占用 → `INVALID_ARGUMENT` 说明哪个端口冲突）。
- `stop()`：见 stub；最终 `clearRunIf`（只删自己停掉的那次启动的记录），emit state。尚未开机完成（starting/booting/启动超时，
  或 gRPC 说已开机但 adb 一直不在线）的实例直接 SIGKILL，**不发 console kill**（否则会存下半启动的快照）；探测给不出答案时
  最多重试 3 次，仍 unknown 则走优雅停止。已在进行的优雅停止遇到 `stop --force`（或 `rm --force`）会立即升级为 SIGKILL。
  确认进程退出后删除它残留的 discovery 文件。
- 快照与磁盘一致性：每次 launch 在 spawn 前写入 `<avd>/.avdm-snapshot-stale`；只有 emulator 有序退出（未被 SIGKILL、自己撤下
  discovery 文件）**且**本次会话内写过 `snapshots/default_boot/snapshot.pb`（退出时的保存）才删除它。下次 launch 若标记还在且
  有快照、又是 quick 模式 → 加 `-no-snapshot-load`（从当前磁盘冷启动，退出时照常保存新快照），并在日志里说明。
  这样崩溃、强制停止、启动中停止、从损坏快照恢复失败之后都不会再加载过期/损坏的快照（不会回滚数据，也会自动修复坏快照）。
- 准入：`running`= 状态非 stopped/error 的实例数；`hostStats().availableMemMb`。预计常驻：冷启动 0.6×内存，会恢复 Quick Boot
  快照的实例 0.8×内存。内存压力 critical → 拒绝；warn 且在用 swap、且已有实例在运行 → 拒绝（`memoryReserveMb=0` 时不做这项）。
- `screenshot()`：gRPC PNG（width 可选，按实例分辨率补成 width×height 框）→ 失败回退 `adb screencapPng`。
- `openScrcpy()`：`settings.scrcpyPath` 或 PATH 中 `scrcpy`（也查 /opt/homebrew/bin、/usr/local/bin），
  参数 `-s <serial> --window-title "<name> (#i)" --no-audio`，env `ADB=<sdk adb>`，detached。
- monitor：`setInterval` + 防重入；自动重启计数窗口 10 分钟最多 3 次。
- `acceptLicenses(ids, shownTexts?)`：记录的是用户看到的文本——传入 `shownTexts`（如 `plan.licenses`）时逐字比对当前清单，
  不一致就 `LICENSE_NOT_ACCEPTED`；不传时用 planSdkInstall 最近一次使用的清单（不受 10 分钟 TTL 影响、不会偷偷重新下载）。
- 安装/替换 `emulator` 时，除本 home 的运行中实例外，discovery 里任何可能在用这个 SDK 的其他模拟器（Android Studio AVD、
  其他 AVDM_HOME；按 `cmdline` 的可执行文件路径判断，判断不了按“在用”）也会让安装被拒绝。

## §scripts（core-manager）
见 `scripts.ts` stub。runId = `<scriptId>-<index>-<yyyyMMddHHmmss>-<rand4>`。进程组 detached=true 以便整组 kill。
macOS 上脚本的 PATH 末尾补上 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`（从 Finder/Dock 启动的应用只有 launchd 的精简 PATH）。
`createExample()` 生成 `scripts/hello-adb/{script.json, main.py}`：main.py 仅用标准库 + subprocess 调 `$AVDM_ADB`，
打印 `getprop ro.product.model` 与屏幕尺寸（`wm size`），然后点击屏幕中心一次，逐行输出日志。

## §cli（cli）
可执行 `avdm`（commander），所有命令支持 `--json`（输出机器可读）。命令：
```
avdm doctor                                   # SDK/emulator 版本(≥36.6.11)/adb/HVF(accel-check)/镜像/主机资源 体检
avdm sdk images [--preview]                   # 远端可用 arm64 镜像（标记已安装）
avdm sdk install [pkg...] [--accept-licenses] # 默认 emulator platform-tools DEFAULT_IMAGE；显示许可全文→交互 y/N 确认；进度条
avdm sdk status                               # 已安装组件
avdm create [-n 1] [--name 前缀] [--image pkg] [--cores 2] [--ram 3072] [--res 1280x720] [--dpi 320] [--data 16]
            [--gpu host|software|auto] [--window] [--cold-boot] [--auto-restart]
avdm clone <src> [-n 1] [--name 前缀] [--keep-snapshots]
avdm list|ls [--json]                         # 表格：# 名称 状态 serial 规格 镜像 pid
avdm start <sel> [--wait] [--window] [--force] [-j 3]
avdm stop <sel> [--force] [-j 8]
avdm restart <sel>
avdm rm <sel> [--force] [-y]
avdm set <sel> [--name] [--notes] [--cores] [--ram] [--res] [--dpi] [--data] [--gpu] [--window|--headless] [--cold-boot|--quick-boot] [--auto-restart|--no-auto-restart]
avdm shell <sel> -- <cmd...>                   # 并发执行，输出按 [#i] 前缀
avdm install <sel> <apk...>
avdm app start|stop <sel> <package>  |  avdm app list <index>
avdm screenshot <sel> [-o dir] [--width N]
avdm tap <sel> <x> <y> | swipe <sel> x1 y1 x2 y2 [ms] | key <sel> <code> | text <sel> <text>
avdm view <index>                             # scrcpy
avdm logs <index> [-n 200] [-f]
avdm monitor                                  # 前台健康监控 + 自动重启，打印事件
avdm script list | run <id> <sel> [-- args] | example
avdm settings [get [key] | set <key> <value>]  # value 按 JSON 解析失败则当字符串
```
`<sel>`：`all`、`0`、`0,2,5`、`1-4`。批量操作打印每个实例 ✓/✗ 结果，任一失败则退出码 1。
长操作显示简单进度（TTY 下单行刷新）。`sdk install` 同意许可前**必须**打印许可全文（或提示保存路径并分页）并等待 `y`。

## §desktop（desktop）
electron-vite：`src/main/index.ts`（主进程，持有 AvdManager，注册 `avdm:<method>` handlers，启动 monitor，
转发事件到所有窗口）、`src/preload/index.ts`（contextBridge 暴露 `window.avdm: AvdmApi`）、`src/renderer`（React 19）。
安全：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，CSP 限制 `default-src 'self'; img-src 'self' blob: data:`。
proto：主进程启动时 `setEmulatorProtoPath()` 指向打包进 out/ 的 proto（electron-vite 构建时复制
`packages/core/proto/emulator_controller.proto` 到 `out/main/`；开发模式直接用 core 包内路径）。
验证钩子（仅用于测试/文档截图）：`AVDM_SCREENSHOT_PATH=<png>` 窗口加载后等待 `AVDM_SCREENSHOT_DELAY_MS`（默认 3000）
截图并退出；同时设 `AVDM_OPEN_LIVE=<i>` 则打开并截取 #i 的实时画面窗口。
与 CLI 同步：主进程用 fs.watch 监视 `instances.json`、`run/`、discovery 目录与 `settings.json`（去抖 300ms，3s 轮询兜底），
约 1s 内刷新；开机完成等不改文件的状态变化仍靠健康检查（`healthIntervalSec`）。
退出：`before-quit` 里先取消并等待正在进行的 SDK 安装、释放管理器（最多 5s），然后 `app.exit(0)`（信号触发的退出被
preventDefault 之后再调 `app.quit()` 只会关窗口、进程不退出，实测 Electron 44 / macOS）。

UI（中文，深色主题，参考雷电多开器的布局）：
- 顶栏：应用名“AVD 多开管理器”、主机资源（可用内存/已分配/负载、运行数/上限）、按钮：新建、批量启动、批量停止、安装 APK、运行脚本、设置。
- 首次启动/缺组件：SDK 向导（显示将下载的组件与大小 → 展示许可全文，每个许可单独勾选“我已阅读并同意许可 <id>”，
  只记录勾选了的许可，并把显示过的全文传给 `acceptLicenses` 逐字比对 → 下载进度 → 完成）。安装在主进程里进行，
  重新打开的向导会接上正在进行的安装。
- 实例墙：卡片网格（可切换列表视图），卡片含缩略图（运行中约每 2s 刷新）、复选框、状态点+文字、名称（可重命名）、#index、serial、规格摘要；
  操作：启动/停止/重启、实时画面（独立窗口）、scrcpy、更多（克隆、编辑配置、查看日志、删除）。全选/反选。
- 实时画面窗口：按设备比例的 canvas，鼠标按下/拖动/抬起 → liveTouch（映射到设备坐标），滚轮忽略；
  键盘 → liveKey（W3C key 名）；工具条：返回(GoBack)、主页(GoHome)、多任务(AppSwitch)、截图、置顶。
  帧请求总是同时给 width 和 height（见 §grpc），最多 30 fps；画面按变化推送，静止时显示“画面静止”，10s 无帧时用小截图探测，
  连续两次失败才判定断流。窗口隐藏/最小化时不发送帧。Android 旋转时帧仍是面板方向：主进程约每秒经 adb 读取显示方向，
  渲染端把画面转正、触点反向映射回面板坐标，窗口改成对应方向。中文等非 ASCII 输入/粘贴会被拒绝并提示（adb/gRPC 限制）。
- 对话框：新建（数量、名称前缀、镜像下拉=已安装镜像、CPU、内存、分辨率预设：1280x720 横屏/1920x1080 横屏/720x1280 竖屏/1080x1920 竖屏/自定义、DPI、数据盘、GPU、无窗口、冷启动、崩溃自动重启）、
  克隆、编辑配置、设置（SDK 路径、默认镜像、最大运行数、内存保留、启动超时、代理、scrcpy 路径）、脚本（列表、对选中实例运行、运行记录与实时输出、停止、打开脚本目录、生成示例）、日志抽屉。
- 所有操作结果以 toast 呈现；批量操作汇总成功/失败数。

## §testing
- vitest，测试放 `packages/core/test/`。用临时目录作为 AVDM_HOME 与假 SDK：
  `emulator` 为 bash 脚本（解析 -avd/-port/-grpc，写 discovery 文件到测试指定目录——为此 manager/discovery 需支持
  通过环境变量 `AVDM_DISCOVERY_DIR` 覆盖 discovery 目录；`-help` 时输出若干 flag 行；收到 SIGTERM 退出），
  `adb` 为 bash 脚本（`-s X shell getprop sys.boot_completed` → 1 等）。
- 单测：ini、selector、catalog 解析（用裁剪后的真实 XML 片段）、license hash、packageInstallDir、avd config 生成、克隆排除规则、
  registry 并发 allocate、launcher planLaunch、discovery 解析、状态机、admission。
- 假 SDK 实现为 Node 脚本（`test/fixtures/fake-sdk`，由 `test/helpers/fakeSdk.ts` 的 `createFakeSdk()` 复制到临时目录）。
  假 emulator 的截图是按请求尺寸合成的“主屏幕”（按实例着色、`#<index>`、时钟、最近触点），PNG/RGB888/RGBA8888 均为真实像素；
  `FAKE_SCREEN_FPS=<n>` 让 streamScreenshot 持续推帧（默认推 3 帧后保持空闲，单测依赖此行为）。
  假 emulator 认 `-no-snapshot-load`，并在日志里写 `(fake) cold boot` / `(fake) loading quick boot snapshot default_boot`；
  假 adb 读取 discovery 键 `fake.boot_at`（开机完成时刻）与 `fake.adb_offline=1`（所有设备命令报 “device offline”）。
  注意：假 emulator 的截图在只给 width 时也会按比例缩放，而真机不会（见 §grpc），调用方始终应传完整的框。
- 端到端（仓库根 `scripts/`，Node ≥22.18 直接 import `fakeSdk.ts`）：`pnpm e2e:cli`（真实 `avdm` 二进制跑完整命令序列）、
  `pnpm e2e:desktop`（构建后的 Electron 经 `--remote-debugging-port` + CDP 驱动 IPC 与界面）、
  `pnpm screenshots`（重新生成 `docs/screenshots/{main,live,wizard}.png`）。
