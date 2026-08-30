<div align="center">

<img src="apps/tauri/src-tauri/icons/icon.png" width="88" alt="HarnessDock icon" />

# HarnessDock

**DeepSeek Harness 的 Tauri 2 桌面 / 移动客户端**

*官方 Harness Web UI · 桌面本地 Runtime · 移动端安全远程 Gateway · 不 fork 上游 SPA*

> **免责声明**：HarnessDock 是独立第三方客户端，与 DeepSeek 官方无隶属或背书关系；DeepSeek 及相关标识属于其权利人。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-blue)
![host](https://img.shields.io/badge/host-Tauri%202-24C8DB)
![runtime](https://img.shields.io/badge/dsh-pinned%20official%20runtime-8A2BE2)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

## 当前版本

- **HarnessDock v0.2.0**：Tauri 2 主线。
- **HarnessDock v0.1.2**：最后一个 Electron 稳定基线，仅保留兼容与历史参考。
- 上游 DeepSeek Harness 固定为 `dsh-v0.1.2-alpha.1`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`。

HarnessDock 不重写 DeepSeek Harness SPA。桌面端启动固定版本的官方 `dsh` Runtime，并把官方 Harness UI 放在隔离的 WebView 中；Android/iOS 不在手机内运行桌面 Node/dsh，而是通过 HarnessDock Gateway 连接桌面或服务器 Runtime。

## v0.2.0 平台矩阵

| 平台 | Host | Runtime 模式 | CI 产物 |
| --- | --- | --- | --- |
| Windows x64 | Tauri 2 | 本地 + Remote Gateway | NSIS `.exe` |
| Linux x64 | Tauri 2 | 本地 + Remote Gateway | `.deb` + AppImage |
| macOS x64 | Tauri 2 | 本地 + Remote Gateway | `.dmg` |
| macOS arm64 | Tauri 2 | 本地 + Remote Gateway | `.dmg` |
| Android arm64 | Tauri 2 | Remote-only | debug `.apk` + `.aab` |
| iOS Simulator arm64 | Tauri 2 | Remote-only | Simulator `.app` 压缩包 |
| VS Code / Cursor | Extension | Host Runtime | `.vsix`（仓库继续维护） |

> Android/iOS v0.2.0 是原生构建通过的 developer preview。Android 尚未使用 Google Play 正式签名；iOS 当前是 Simulator 构建，不是 App Store/TestFlight IPA。

## 架构

```text
                         HarnessDock v0.2.0

 Desktop                                             Mobile
 Windows / macOS / Linux                            Android / iOS
          |                                              |
          v                                              v
   Tauri local main UI                           Tauri pairing UI
          |                                              |
          | local IPC only                               | HTTPS / WSS
          v                                              v
 Runtime Controller -------- HarnessDock Gateway <--- paired session
          |
          +---- Gateway sidecar
          |
          +---- pinned official dsh Runtime
          |       |
          |       v
          |   dsh web on loopback
          |       |
          v       v
       isolated Harness WebView
       (no local Tauri capability)
```

### 桌面端

桌面 Tauri Host 负责：

- 启动 / 停止固定版本的本地 DeepSeek Harness Runtime；
- 建立官方 dsh launch-token → HttpOnly Web Session；
- 打开独立 `harness` WebView 展示官方 Harness UI；
- 启动受控 Gateway sidecar；
- 生成一次性配对码、列出设备、撤销设备 Session；
- 保持远程 Harness 页面与本地 Tauri IPC 权限隔离。

### Android / iOS

移动端只实现 Remote Runtime：

1. 校验 HTTPS HarnessDock Gateway；
2. 使用一次性 pairing code 完成显式配对；
3. 获得 Gateway HttpOnly Session；
4. 通过同一 Gateway 代理 HTTP / WebSocket 到桌面 dsh；
5. 手机端不能覆盖或读取桌面 dsh 的上游认证 Cookie。

这种设计避免在 iOS/Android 内嵌桌面 Node Runtime，同时保持官方 Harness Web UI 的行为一致。

## 安全边界

v0.2.0 明确区分三类认证 / 权限：

- **Tauri local IPC**：只授权本地 `main` 管理窗口；
- **Gateway Session**：用于已配对移动设备；
- **dsh upstream Web Session**：由桌面 Host 持有并转发，移动端不能注入或替换。

`apps/tauri/src-tauri/capabilities/local-main.json` 不配置 remote origin，因此远程 Harness/Gateway 页面不会获得本地 Tauri command 权限。

## 仓库结构

```text
apps/
  tauri/                         v0.2.0 Windows/macOS/Linux/Android/iOS Host
  desktop/                       v0.1.x Electron legacy baseline
  vscode/                        VS Code / Cursor extension

packages/
  bootstrap/                     Host contract + Gateway + pairing/session
  client-runtime/                pinned dsh Runtime lifecycle
  plugin-embedded-client/        embedded client plugin
  docs-sync/                     upstream pin / origin metadata

.github/workflows/
  tauri-ci.yml                   快速五端编译 / parity gate
  tauri-candidate.yml            正式候选构建：Runtime + Desktop + Android + iOS
  release.yml                    仅发布 exact-main 已全绿 candidate
```

## 开发环境

基础开发需要：

- Node.js 22+
- pnpm 10
- Rust stable
- 对应平台的 Tauri 2 原生依赖

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test

cd apps/tauri
cargo check
```

完整桌面安装包包含官方固定 Runtime，构建过程还需要准备上游 dsh runtime closure。**`.github/workflows/tauri-candidate.yml` 是正式发布构建的参考实现**，它会固定上游 Git commit、构建 official profile、生成四个平台 Runtime、做真实 Runtime smoke，再执行 Tauri bundling。

## Tauri 原生构建

在已经准备好 Tauri resources / Runtime 的环境中：

```bash
cd apps/tauri

# Windows
cargo tauri build --bundles nsis

# Linux
cargo tauri build --bundles deb,appimage

# macOS
cargo tauri build --bundles dmg
```

移动端：

```bash
cd apps/tauri

cargo tauri android init --ci
cargo tauri android build --debug --apk --aab --target aarch64 --ci

cargo tauri ios init --ci
cargo tauri ios build --debug --target aarch64-sim --ci
```

详见 `apps/tauri/README.md`。

## Release 纪律

v0.2.0 的正式发布采用两阶段 gate：

```text
exact main SHA
    |
    v
Tauri Candidate
    |-- version / release contract
    |-- full tests
    |-- pinned upstream official build
    |-- 4 runtime bundles
    |-- 4 desktop runtime smoke tests
    |-- Windows / Linux / macOS Tauri packages
    |-- Android APK + AAB
    |-- iOS Simulator build
    v
candidate-gate = success
    |
    v
release.yml verifies candidate SHA == main SHA == tag SHA
    |
    v
GitHub Release + SHA256SUMS
```

`release.yml` 不重新走另一套 Electron 构建链，也不会接受其他 commit 的 artifact。

## 签名状态

当前公开 CI：

- 尚未启用 Windows Authenticode；
- 尚未启用 Apple Developer ID / notarization；
- Android 为 debug developer preview；
- iOS 为 Simulator developer preview；
- GitHub Release 会提供 `SHA256SUMS`，同时 GitHub Assets 提供 SHA-256 digest。

生产商店分发需要在后续接入对应开发者证书与签名密钥。

## 数据目录

DeepSeek Harness 数据与凭证仍遵循上游规则，默认使用官方 `~/.dsh/` 数据目录。HarnessDock 不迁移、不复制用户模型凭据到移动端。

## License

MIT. 具体第三方依赖、DeepSeek Harness 与商标使用遵循各自许可证和权利声明。
