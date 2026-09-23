# macOS Apple Silicon 预览版

下载 `AVDM-*-mac-arm64.dmg`，打开后将“AVD 多开管理器”拖到“应用程序”，再启动应用。安装包自带桌面客户端，不需要安装 Node.js 或 pnpm。

首次在没有 Android SDK 的 Mac 上启动时，应用内会打开 SDK 向导。阅读并同意相应许可后，向导从 Google 下载约 1.1 GB 的 Android Emulator、Platform-Tools 和 ARM64 系统镜像。下载完成后在主界面创建实例即可使用；已有兼容 SDK 的 Mac 可以直接使用。

当前预览包使用临时签名，没有 Developer ID 签名和公证。macOS 可能阻止首次打开，需要在“系统设置 → 隐私与安全性”中允许打开。安装包只支持 Apple Silicon，不包含 Google SDK 或系统镜像，也不包含游戏 APK。
