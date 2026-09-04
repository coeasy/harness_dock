# HarnessDock 项目介绍

<div align="center">

<img src="../apps/tauri/src-tauri/icons/app-icon.png" width="96" alt="HarnessDock icon" />

**HarnessDock — 深潜工作台**

*DeepSeek Harness 的一键桌面停靠入口*

> 本项目为独立第三方客户端，与 DeepSeek 官方无隶属或背书关系；DeepSeek 及相关标识归其权利人所有。

</div>

## 当前版本

HarnessDock 当前产品版本为 **v0.1.2**，当前内置 Runtime 精确锁定：

```text
dsh-v0.1.2-rc.1
a66e4702047846cdaa10c66c9d3df3951f5ea70d
```

HarnessDock 产品版本跟随 pinned dsh 的基础 SemVer；上游 prerelease 后缀仅作为 Runtime provenance 保存。完整规则见 [`VERSIONING.md`](./VERSIONING.md)。

## 项目定位

HarnessDock 是 DeepSeek Harness 的 Tauri 原生 Native Host。它不 fork 或重写官方 Web UI，只负责托管版本锁定的 Runtime、保护进程生命周期、校验 loopback 地址，并在原生窗口中加载 Harness Web。

`apps/tauri` 是唯一桌面应用宿主。桌面启动后第一个业务界面就是 Harness Web；设置、诊断、插件恢复、Gateway 和更新检查均为按需能力，不会抢占正常首屏。VS Code/Cursor 扩展作为独立宿主保留，不属于桌面安装包。

## 核心能力

- Windows、macOS、Linux：Tauri 2 Full Runtime 桌面客户端，安装包内置 Node + dsh + 必要 Runtime Tool，支持首启零下载。
- Android/iOS：Remote Gateway 客户端，不在移动设备内启动 Node/dsh。
- `@dsh/plugin-harness-shell`：独立可发布外壳，提供菜单、最小化、最大化/还原、关闭、刷新 Web、重启 Runtime、隔离插件、Gateway 与诊断入口。
- Runtime/Surface/Gateway/Update：通过 generation、lease、Host Kernel、Reconciler 和 Actor 状态机统一管理并发与恢复。
- Shell fail-open：可选 Shell 注入失败时恢复系统原生窗口控件，Harness Web 仍可使用。
- Runtime 隔离：第三方插件故障进入有界恢复/隔离路径，不让插件异常直接结束主客户端。
- WebView origin 限制：桌面 Harness Web 只允许当前 RuntimeLease 对应的 `127.0.0.1` origin。
- 发布可复现：Release manifest、origin、Runtime tag/commit、版本号和 candidate SHA 都进入发布门禁。

## 正常桌面链路

```text
Tauri setup
  -> Host Kernel / startup coordinator
  -> sealed Full Runtime
  -> RuntimeActor / RuntimeLease
  -> isolated Harness WebView
  -> Harness Web
  -> optional Harness Shell
```

Runtime 或 WebView 首次加载失败时进入 Recovery；Tray、Updater、原生菜单或 Shell 等可选组件初始化失败采用 fail-open，不得阻止 Harness Web 启动。

## 外壳操作

正常 Harness Web 顶部外壳提供窗口操作和受控业务命令。业务操作通过 Host Protocol 进入 Host Kernel/Reconciler，不直接让远程 Web 文档获得高权限本地 API。

主要操作包括：刷新 Web、重启 Runtime、隔离插件启动、Gateway、插件诊断、最小化、最大化/还原、关闭以及受控退出。高权限清理/更新安装能力只允许可信本地 Surface 调用。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm check:embedded-runtime
pnpm test
pnpm build
pnpm tauri:check
pnpm tauri:dev
```

`check:versions` 保证 root/workspace/Tauri/Rust/Shell/origin/manifest/UI 版本一致；`check:release` 继续验证 HarnessDock 与 pinned dsh 基础 SemVer 对齐，以及 Runtime version/tag/commit 一致。

## 发布

当前 v0.1.2 使用测试版发布通道，目标 tag：`v0.1.2-beta.1`。

`.github/workflows/tauri-candidate.yml` 构建和验证 Windows NSIS、Linux DEB/AppImage、macOS x64/arm64 DMG 与 app archive、Android APK/AAB、iOS Simulator，以及四个平台 Full Runtime bundle。

`.github/workflows/release.yml` 只接受**同一个 main SHA**上的绿色 `ci` 与 `tauri-candidate`，并发布 15 个不可变 beta 资产及 `SHA256SUMS`。当前 beta 不启用操作系统代码签名、Apple notarization 或 Tauri `latest.json/.sig` 自动更新资产；未配置正式签名通道前采用 GitHub Release 手动下载安装。

## 独立 Harness Shell

```text
packages/plugin-harness-shell/
  manifest.json
  lib/index.js
  web/shell.js
```

构建：

```bash
pnpm --filter @dsh/plugin-harness-shell build
```

宿主缺少某项 capability 时应隐藏对应操作；Shell 本身永远不是 Runtime 启动前置依赖。

## License

MIT。DeepSeek Harness 与其它第三方依赖遵循各自许可证和商标规则。
