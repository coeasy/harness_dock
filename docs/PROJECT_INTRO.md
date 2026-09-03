# HarnessDock 项目介绍

<div align="center">

<img src="../apps/tauri/src-tauri/icons/app-icon.png" width="96" alt="HarnessDock icon" />

**HarnessDock — 深潜工作台**

*DeepSeek Harness 的一键桌面停靠入口*

> 免责声明：本项目为独立的第三方客户端，与 DeepSeek 官方无隶属或背书关系；DeepSeek 及相关标识为 DeepSeek 官方商标。

</div>

## 项目定位

HarnessDock 是 DeepSeek Harness 的 Tauri 原生薄壳。它不 fork 或重写官方 Web UI，只负责启动版本锁定的 dsh Runtime、校验 loopback 地址，并在原生窗口中加载官方 Harness Web。

v0.2.0 只有一个桌面宿主：`apps/tauri`。启动后首个业务界面直接是 Harness Web；设置、诊断、插件恢复和更新均是按需的外壳能力，不会抢占正常首屏。VS Code/Cursor 作为独立编辑器扩展保留，不属于桌面安装包。

## 核心能力

- Tauri 2 Windows、macOS、Linux 桌面客户端；桌面包统一为 Full Runtime，支持离线启动。
- Android/iOS 通过认证 Gateway 连接远程 Runtime，不在移动设备内启动 Node/dsh。
- `@dsh/plugin-harness-shell` 独立发布，提供菜单、最小化、最大化/还原和关闭按钮，以及刷新 Web、重启 Runtime、隔离插件、诊断和 Tauri 更新入口。
- Runtime、Gateway 和 WebView 均有单飞、超时、回收、地址校验和关闭保护；插件故障进入隔离/恢复流程，不修改用户真实配置。
- Tauri updater 只接受 GitHub Release 的签名更新清单；未配置签名发布材料时只提示手动更新，不安装未验证文件。
- `docs-sync`、Runtime、Shell 插件、Tauri 配置和发布清单统一对齐 `v0.2.0` 客户端版本；上游 dsh 版本单独按精确 commit 固定。

## 架构

```text
Tauri Native Host
  ├─ Full dsh Runtime（loopback）
  ├─ Gateway sidecar（受控远程连接）
  ├─ Harness WebView（Runtime ready 后显示）
  ├─ harness-shell plugin + v1 Host Bridge
  └─ signed Tauri updater

Mobile Tauri
  └─ HTTPS/WSS → HarnessDock Gateway → desktop/server Runtime
```

正常桌面链路为：原生启动协调器 → Runtime ready → 校验 Web URL → 打开 Harness Web → 注入 Shell 插件。控制页只用于启动故障恢复或显式诊断，远程页面不会获得本地 Tauri capability。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test
pnpm build
pnpm tauri:check
pnpm tauri:dev
```

跨平台候选包由 `.github/workflows/tauri-candidate.yml` 构建和验证：Windows NSIS、Linux DEB/AppImage、macOS x64/arm64 DMG、Android APK/AAB、iOS Simulator，以及四个平台的 Full Runtime。正式 `release.yml` 只接受同一 main SHA 的全绿 candidate 和 CI，并上传 `SHA256SUMS`。

## 独立 Shell 插件

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

其它 dsh 宿主可以安装该包并读取 `manifest.json`。宿主未实现某个命令时，将 capability 设为 `false`，插件会隐藏该菜单项，同时不影响 Harness Web 启动。

## 版本与发布

```text
HarnessDock / workspace packages  0.2.0
Tauri config / Rust crate         0.2.0
harness-shell plugin              0.2.0
origin clientVersion              0.2.0
```

发布前必须通过 `pnpm check:versions`、`pnpm check:release`、全量测试、Tauri Rust 检查和完整 candidate；桌面更新只由 Tauri updater 负责。

## License

MIT。DeepSeek Harness 与其他第三方依赖遵循各自许可证和商标规则。
