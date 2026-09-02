<div align="center">

<img src="apps/tauri/src-tauri/icons/app-icon.png" width="88" alt="HarnessDock icon" />

# HarnessDock

**DeepSeek Harness 的 Full-only Tauri 2 桌面 / 移动客户端**

*官方 Harness Web UI · 桌面内置固定 Runtime · 移动端安全 Remote Gateway · 插件故障隔离*

</div>

## 当前版本

- **HarnessDock v0.2.0**：Tauri 2 主线，启动即进入 Harness Web；Windows/macOS/Linux 默认发布 Full Runtime 桌面包。
- Electron 客户端、Electron Builder、Electron 更新器和 Electron E2E 已从 v0.2.0 移除；正式客户端、启动、退出、更新和发布门禁统一由 Tauri 承担。
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

## v0.2.0 安装与升级体验

- 统一 1024x1024 HarnessDock 品牌源图，candidate 自动生成桌面、Android、iOS 所需图标。
- Windows NSIS 安装器和卸载器显式使用统一 HarnessDock 图标；CI 会检查最终安装器 PE 图标资源，不允许回退到默认 NSIS 图标。
- Windows 保持 `com.harnessdock.client` 应用标识与 current-user 安装模式，可直接覆盖升级现有 v0.2.x；禁止意外降级安装。
- WebView2 bootstrapper 随 Windows 安装器嵌入，缺少 WebView2 时无需再先下载 bootstrapper 本体。
- Runtime/插件异常不会使宿主应用退出；第三方插件可进入 degraded quarantine 或临时安全配置，Web 仍默认打开。Full Runtime 默认只使用随包固定 Node，不再信任用户 PATH；仅显式设置 `HARNESSDOCK_NODE_BIN` 或 `HARNESSDOCK_USE_SYSTEM_NODE=1` 时尝试兼容系统 Node，覆盖无效则安全回退随包 Node。
- 插件诊断作为独立按需窗口，只在 Harness `菜单`、托盘或应用菜单中明确点击后显示，不抢占 Web 首屏；窗口居中、紧凑并在页面加载完成后显示。
- 桌面端 Harness 使用自定义标题栏：`菜单`、最小化、最大化/还原、隐藏到系统托盘；刷新、Runtime 重启、清除插件隔离并重启、插件诊断和自动更新统一收敛到菜单。系统托盘不可用时，窗口关闭会转为受管退出，不会留下无法重新打开的后台进程。
- 启动、刷新和重启都使用可见执行态；导航期间由本地 splash 显示动画和状态，页面加载成功后自动回到 Harness Web，失败则回到恢复入口而不是白屏。
- 启动只显示本地 splash，后台控制页和插件诊断均不抢占首屏；自动更新统一从主界面菜单、托盘或应用菜单进入，失败会留在界面内并给出明确降级路径。
- Runtime 子进程异常退出会被及时识别；重复启动受到保护；重启 Runtime 前会先关闭 Gateway，避免复用失效的上游地址。
- 顶部入口明确命名为“菜单”，并统一承载 Web 刷新、Runtime 重启、插件隔离恢复、插件诊断和自动更新；插件诊断保持只读、按需打开。
- `@dsh/plugin-harness-shell` 是独立可发布的 dsh 外壳插件；Tauri 通过 v1 Host Bridge 接入，能力由原生 Tauri 命令统一提供，未实现的菜单项会隐藏；插件入口自身采用 fail-open，宿主 service 注册失败不会阻断 Runtime/Harness Web。
- 桌面启动由原生协调器直接启动 Runtime，Harness Web 完成绘制后才显示；白板、启动超时和窗口切换期间自动退出均进入可操作恢复路径。
- 桌面 Harness Shell 权限只授予受管的 `http://127.0.0.1:<ephemeral-port>` Runtime origin；localhost、IPv6、HTTPS alias 与其它本机服务均不获得外壳 IPC。
- 桌面受管 loopback Harness WebView 只获得事件订阅、标题栏拖拽和显式 `harness-shell` Host Bridge 命令；不再授予整组 `core:default` 能力。

完整的 v0.2.0 外壳重构与发布前验收方案见 [`docs/plan/v0.2.0-shell-first-implementation.md`](docs/plan/v0.2.0-shell-first-implementation.md)。

## 架构

```text
Desktop (Windows/macOS/Linux)
  Tauri Host
    +-- pinned Full dsh Runtime (loopback)
    +-- isolated official Harness WebView
    +-- independent harness-shell plugin + versioned Host Bridge
    +-- Gateway sidecar
    +-- plugin failure quarantine/recovery

Mobile (Android/iOS)
  Tauri pairing UI
    +-- HTTPS/WSS --> HarnessDock Gateway --> desktop/server dsh
```

移动端不会内嵌桌面 Node Runtime；Gateway/移动端远程页面不会获得本地 Tauri IPC 权限。桌面受管 loopback Harness WebView 仅获得最小化的 `harness-shell` capability，用于标题栏、事件订阅和明确列出的 Host Bridge 命令。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test
cd apps/tauri && cargo check
```

正式发布以 `.github/workflows/tauri-candidate.yml` 为唯一候选构建：它固定上游 commit、生成四个平台 Runtime、执行真实 smoke、构建五个桌面资产和移动端 developer preview，并验证品牌图标。`release.yml` 只接受当前 main 同一 SHA 的 candidate + CI 全绿结果，发布 20 个非空资产（含四个 Tauri updater 签名目标、四个平台 Runtime、移动包、`latest.json` 与 `SHA256SUMS`），并要求每类候选资产唯一匹配；Runtime 发布包只能从候选 artifact 根 `manifest.json` 对应目录生成。

Android 候选使用 release profile（`opt-level=z`、Thin LTO、去符号、单 codegen unit、`panic=abort`），并在上传前检查 APK/AAB 包体和最大 native `.so`。旧版 debug APK 的主要体积来自未剥离符号的 `libharnessdock_tauri.so`，不是移动端业务资源。

## 签名状态

当前公开 CI 包尚未启用 Windows Authenticode、Apple Developer ID/notarization、Google Play production signing 或 App Store/TestFlight provisioning。GitHub Release 提供 SHA-256 校验值。

## License

MIT。DeepSeek Harness 与其他第三方依赖遵循各自许可证和商标规则。
