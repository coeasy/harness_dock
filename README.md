<div align="center">

<img src="apps/tauri/src-tauri/icons/app-icon.png" width="88" alt="HarnessDock icon" />

# HarnessDock

**DeepSeek Harness 的 Full-only Tauri 2 桌面 / 移动客户端**

*官方 Harness Web UI · 桌面内置固定 Runtime · 移动端安全 Remote Gateway · 插件故障隔离*

</div>

## 当前版本

- **HarnessDock v0.2.4**：Tauri 2 主线，Windows/macOS/Linux 默认且仅发布 Full Runtime 桌面包。
- Electron Thin/Full 构建逻辑暂时保留在 `apps/desktop` 作为兼容与迁移参考，**不进入正式 candidate / Release**；稳定后可独立删除。
- 上游 DeepSeek Harness 固定为 `dsh-v0.1.2-alpha.1`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`。

## 平台矩阵

| 平台 | Runtime | 正式资产 |
| --- | --- | --- |
| Windows x64 | 内置 Full Runtime + Remote Gateway | NSIS `.exe` |
| Linux x64 | 内置 Full Runtime + Remote Gateway | `.deb` + `.AppImage` |
| macOS x64 | 内置 Full Runtime + Remote Gateway | `.dmg` |
| macOS arm64 | 内置 Full Runtime + Remote Gateway | `.dmg` |
| Android arm64 | Remote-only | release-optimized `.apk` + `.aab` |
| iOS Simulator arm64 | Remote-only | Simulator `.zip` |

## v0.2.4 安装与升级体验

- 统一 1024x1024 HarnessDock 品牌源图，candidate 自动生成桌面、Android、iOS 所需图标。
- Windows NSIS 安装器和卸载器显式使用 HarnessDock 图标，并使用品牌化 header/sidebar；CI 会检查最终安装器 PE 图标资源，不允许回退到默认 NSIS 图标。
- Windows 保持 `com.harnessdock.client` 应用标识与 current-user 安装模式，可直接覆盖升级现有 v0.2.x；禁止意外降级安装。
- WebView2 bootstrapper 随 Windows 安装器嵌入，缺少 WebView2 时无需再先下载 bootstrapper 本体。
- Runtime/插件异常不会使宿主应用退出；第三方插件可进入 degraded quarantine 或临时安全配置，Web 仍默认打开；系统 Node 启动异常会自动回退随包 Node。
- 外壳设置作为独立按需插件窗口，只在 Harness 顶部按钮或应用菜单点击后显示，不抢占 Web 首屏。
- 桌面端 Harness 使用自定义标题栏：设置、最小化、最大化/还原、隐藏到系统托盘；关闭窗口不会误杀 Runtime，托盘“退出 HarnessDock”才会执行完整退出清理。
- 启动先显示可操作控制页和启动动画，再异步启动 Runtime；更新检查只在设置页主动点击时执行，失败会留在界面内并给出重试路径。

## 架构

```text
Desktop (Windows/macOS/Linux)
  Tauri Host
    +-- pinned Full dsh Runtime (loopback)
    +-- isolated official Harness WebView
    +-- Gateway sidecar
    +-- plugin failure quarantine/recovery

Mobile (Android/iOS)
  Tauri pairing UI
    +-- HTTPS/WSS --> HarnessDock Gateway --> desktop/server dsh
```

移动端不会内嵌桌面 Node Runtime；远程 Harness/Gateway 页面也不会获得本地 Tauri IPC 权限。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test
cd apps/tauri && cargo check
```

正式发布以 `.github/workflows/tauri-candidate.yml` 为唯一候选构建：它固定上游 commit、生成四个平台 Runtime、执行真实 smoke、构建五个桌面资产和移动端 developer preview，并验证品牌图标。`release.yml` 只接受当前 main 同一 SHA 的 candidate + CI 全绿结果，发布 13 个非空资产和 `SHA256SUMS`。

Android 候选使用 release profile（`opt-level=z`、Thin LTO、去符号、单 codegen unit、`panic=abort`），并在上传前检查 APK/AAB 包体和最大 native `.so`。旧版 debug APK 的主要体积来自未剥离符号的 `libharnessdock_tauri.so`，不是移动端业务资源。

## 签名状态

当前公开 CI 包尚未启用 Windows Authenticode、Apple Developer ID/notarization、Google Play production signing 或 App Store/TestFlight provisioning。GitHub Release 提供 SHA-256 校验值。

## License

MIT。DeepSeek Harness 与其他第三方依赖遵循各自许可证和商标规则。
