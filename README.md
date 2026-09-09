<div align="center">

<img src="apps/tauri/src-tauri/icons/app-icon.png" width="112" alt="HarnessDock icon" />

# HarnessDock v0.1.5

**DeepSeek Harness 的跨平台原生客户端**

把 DeepSeek Harness 稳定地带到 Windows、macOS、Linux 桌面，并通过 Remote Gateway 延伸到 Android / iOS。

[DeepSeek Harness 官方项目](https://github.com/deepseek-ai/deepseek-harness) · [下载最新版](https://github.com/coeasy/harness_dock/releases/latest) · [项目文档](docs/README.md) · [v0.1.5 发布说明](.github/release-notes/v0.1.5.md)

![Version](https://img.shields.io/badge/version-v0.1.5-blue)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android%20%7C%20iOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — **Everything is a Plugin.**  
> HarnessDock 不 fork、不重写 DeepSeek Harness Web UI，而是为官方 Harness Runtime / Web 提供独立的跨平台 Native Host、生命周期保护、桌面外壳和移动端 Gateway 能力。

> **第三方项目声明**：HarnessDock 是独立的非官方客户端，与 DeepSeek 官方无隶属或背书关系。DeepSeek、DeepSeek Harness 及相关名称和标识归其权利人所有。

---

## HarnessDock 是什么？

DeepSeek Harness 本身提供强大的 Harness Runtime、Web 与插件生态。HarnessDock 解决的是另一个问题：**如何把它变成一个可以直接安装、直接启动、长期稳定运行的跨平台客户端。**

在桌面端，HarnessDock 使用 Tauri 2 作为原生宿主，把版本锁定的 Node、dsh Runtime 和必要 Runtime Tool 一起封装到安装包中。用户安装后直接启动 HarnessDock，客户端自动启动内置 Runtime，完成健康检查后立即进入 Harness Web，不需要先打开设置页，也不要求用户额外安装 Node、dsh 或 pnpm。

```text
启动 HarnessDock
      ↓
Tauri Native Host
      ↓
Sealed Node + pinned dsh Runtime
      ↓
Runtime ready / RuntimeLease
      ↓
受限本地 WebView
      ↓
DeepSeek Harness Web
      ↓
可选 Harness Shell / Gateway / Diagnostics
```

**一句话理解：HarnessDock 不是另一个 Harness，而是 DeepSeek Harness 的安装、运行与跨平台承载层。**

---

## 为什么使用 HarnessDock？

### 1. 安装后直接进入 Harness Web

Windows、macOS、Linux 桌面版本默认启动链路只有一个目标：**尽快、安全地打开 Harness Web。**

- 不先进入设置页；
- 不要求用户手动启动 dsh；
- 不要求用户配置本地 Web 地址；
- Runtime ready 后直接创建 Harness WebView；
- Runtime 或 WebView 异常时进入 Recovery，而不是留下空白窗口或直接退出。

### 2. 桌面版内置完整 Runtime

桌面安装包采用 **Full / sealed Runtime**：

- 内置受版本约束的 Node；
- 内置 pinned dsh Runtime；
- 内置必要 Runtime Tool；
- 首次启动不下载 Node / dsh；
- 客户端运行时不依赖用户系统 PATH 中的 Node；
- Runtime image 会进行来源与完整性身份校验。

这意味着普通用户安装客户端后即可使用，不需要自己维护一套 Node + dsh 开发环境。

### 3. 原生桌面外壳

HarnessDock 在 Harness Web 之外只提供必要的宿主能力，不改变 Harness Web 主业务界面：

| 功能 | 说明 |
| --- | --- |
| 菜单 | 打开宿主操作入口 |
| 刷新 Web | 重新加载当前 Harness Web |
| 重启 Runtime | 有界停止当前 Runtime，并创建新的 Runtime generation |
| 隔离插件启动 | 在第三方插件异常时使用受控隔离恢复路径 |
| Gateway | 为移动端或远程访问提供受控 Gateway 能力 |
| 插件诊断 | 查看插件 / Runtime 相关诊断信息 |
| 最小化 | 原生窗口最小化 |
| 最大化 / 还原 | 原生窗口状态切换 |
| 关闭 / 退出 | 受控关闭窗口并清理受管后台进程 |

独立 `@dsh/plugin-harness-shell` 只是一层可选控制外壳。Shell 注入失败时，HarnessDock 会恢复原生窗口 decorations，**不会因为可选 Shell 故障阻断 Harness Web。**

### 4. Runtime 生命周期保护

桌面客户端不仅负责“启动一个进程”，还负责完整生命周期：

- Runtime generation / lease 防止旧进程重新接管新会话；
- Refresh / Restart 等操作使用互斥与 single-flight 控制，避免重复并发命令；
- Windows 使用 Job Object 管理受控子进程树；
- macOS / Linux 使用独立 process group，并执行有界 TERM → KILL 退出流程；
- 应用退出阶段拒绝再创建新的受管后台进程；
- Runtime、Gateway、Surface、Update 使用统一 Host Kernel / Reconciler 管理状态。

### 5. 插件故障不应该拖垮客户端

DeepSeek Harness 的核心理念是插件化。HarnessDock 因此把“插件异常”和“主客户端可用性”分离：

- 第三方插件异常进入受控隔离 / Recovery；
- 必要时可以使用临时 clean profile 恢复 Harness Web；
- 不直接修改用户真实配置；
- 可选插件、Tray、Updater、Shell 等异常采用 fail-open；
- 主业务目标始终是让 Harness Web 保持可进入、可恢复。

### 6. WebView 与本地权限边界

桌面 Harness WebView 只允许当前 RuntimeLease 对应的受管本地 origin：

```text
http://127.0.0.1:<managed-port>
```

Runtime generation、origin 与 navigation 必须一致。远程 Web 文档不会直接获得完整 Tauri 高权限 API，宿主操作通过受控 Host Protocol 进入 Native Host。

### 7. Android / iOS 使用 Remote Gateway

移动设备不适合直接承载完整 Node + dsh 桌面 Runtime，因此 HarnessDock 在移动端采用不同架构：

```text
Android / iOS Client
        ↓ HTTPS
Trusted HarnessDock Gateway
        ↓
Desktop / Server Runtime
        ↓
DeepSeek Harness
```

Android / iOS **不会在设备内启动 Node / dsh**。移动端只连接可信 HTTPS Gateway，桌面 Runtime 与移动客户端保持职责分离。

---

## 当前版本

| 项目 | 当前值 |
| --- | --- |
| HarnessDock | `0.1.5` |
| 发布通道 | `stable` |
| 当前发布 tag | `v0.1.5` |
| DeepSeek Harness Runtime | `dsh-v0.1.5-alpha.1` |
| Runtime commit | `5dda764ed3aa172535a7967b06ff95d9cbfe536a` |
| 桌面宿主 | Tauri 2 |
| 桌面 Runtime | Full / sealed / 首启零下载 |
| 移动 Runtime | Remote Gateway only |

HarnessDock 产品版本与当前 pinned dsh 的**基础 SemVer**对齐：

```text
dsh-v0.1.5-alpha.1 -> HarnessDock 0.1.5
dsh-v0.1.3-beta.2  -> HarnessDock 0.1.3
dsh-v1.0.0         -> HarnessDock 1.0.0
```

上游 `alpha / beta / rc` 后缀会继续保存在 Runtime provenance 中，但不附加到 HarnessDock 产品版本。

---

## 平台支持与下载

最新版统一从 [GitHub Releases](https://github.com/coeasy/harness_dock/releases/latest) 下载。

| 平台 | 推荐安装包 | Runtime 模式 | 当前状态 |
| --- | --- | --- | --- |
| Windows x64 | `HarnessDock-0.1.5-windows-x64-setup.exe` | Full local | 可安装，未签名 |
| Linux x64 | `.deb` / `.AppImage` | Full local | 可安装，未签名 |
| macOS Apple Silicon | `macos-arm64.dmg` | Full local | 可安装，未 notarize |
| macOS Intel | `macos-x64.dmg` | Full local | 可安装，未 notarize |
| Android arm64 | `.apk` / `.aab` | Remote Gateway | 非商店签名 |
| iOS Simulator | `ios-arm64-simulator.zip` | Remote Gateway | 仅 Simulator |

### 直接下载 v0.1.5

- **Windows x64**：[`HarnessDock-0.1.5-windows-x64-setup.exe`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-windows-x64-setup.exe)
- **Linux x64 / DEB**：[`HarnessDock-0.1.5-linux-x64.deb`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-linux-x64.deb)
- **Linux x64 / AppImage**：[`HarnessDock-0.1.5-linux-x64.AppImage`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-linux-x64.AppImage)
- **macOS Apple Silicon / DMG**：[`HarnessDock-0.1.5-macos-arm64.dmg`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-macos-arm64.dmg)
- **macOS Intel / DMG**：[`HarnessDock-0.1.5-macos-x64.dmg`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-macos-x64.dmg)
- **Android arm64 / APK**：[`HarnessDock-0.1.5-android-arm64-release.apk`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-android-arm64-release.apk)
- **Android arm64 / AAB**：[`HarnessDock-0.1.5-android-arm64-release.aab`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-android-arm64-release.aab)
- **iOS Simulator**：[`HarnessDock-0.1.5-ios-arm64-simulator.zip`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/HarnessDock-0.1.5-ios-arm64-simulator.zip)
- **完整性校验**：[`SHA256SUMS`](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/SHA256SUMS)

> 当前 v0.1.5 尚未启用 Windows Authenticode、Apple notarization、正式移动商店签名和 Tauri `latest.json/.sig` 自动更新资产。请优先从本仓库 Release 下载，并使用 `SHA256SUMS` 校验。

---

# 安装与使用

## Windows 10 / 11 x64

### 安装

1. 打开 [最新 Release](https://github.com/coeasy/harness_dock/releases/latest)。
2. 下载 `HarnessDock-0.1.5-windows-x64-setup.exe`。
3. 建议先使用 PowerShell 校验 SHA-256：

```powershell
Get-FileHash .\HarnessDock-0.1.5-windows-x64-setup.exe -Algorithm SHA256
```

将结果与 Release 中的 `SHA256SUMS` 对照。

4. 双击安装程序。HarnessDock 使用 current-user 安装，不需要把系统 Node / dsh 安装到全局环境。
5. 当前版本没有 Authenticode 签名，因此 Windows SmartScreen 可能显示“Windows 已保护你的电脑”。确认安装包来自本仓库 Release 且 SHA-256 匹配后，可选择 **更多信息 → 仍要运行**。
6. 安装完成后从开始菜单或桌面入口启动 HarnessDock。

### 第一次启动

正常流程是：

```text
启动 HarnessDock
  -> 启动内置 Runtime
  -> Runtime 健康检查
  -> 创建 Harness WebView
  -> 直接进入 Harness Web
```

无需手动启动 Node、dsh，也无需先打开设置页。

### 日常使用

顶部外壳可以执行刷新 Web、重启 Runtime、隔离插件启动、Gateway、插件诊断、最小化、最大化 / 还原和关闭等操作。

关闭应用时 HarnessDock 会进入受控退出流程，并清理属于当前客户端的受管 Runtime / Gateway 子进程。

### 卸载

在 Windows **设置 → 应用 → 已安装的应用** 中找到 HarnessDock 并卸载即可。

---

## macOS Apple Silicon / Intel

### 选择正确版本

- Apple Silicon（M1 / M2 / M3 / M4 等）：下载 `HarnessDock-0.1.5-macos-arm64.dmg`
- Intel Mac：下载 `HarnessDock-0.1.5-macos-x64.dmg`

### 安装

1. 从 [GitHub Release](https://github.com/coeasy/harness_dock/releases/latest) 下载对应 DMG。
2. 可先校验 SHA-256：

```bash
shasum -a 256 HarnessDock-0.1.5-macos-arm64.dmg
```

Intel 版本请替换为对应文件名，并与 `SHA256SUMS` 对照。

3. 打开 DMG，将 HarnessDock 复制到 `Applications`。
4. 当前版本尚未进行 Apple notarization。首次启动如果被 Gatekeeper 阻止，请确认文件来自本仓库并完成哈希校验，然后可以：
   - 在 Finder 中按住 Control 点击 HarnessDock，选择 **打开**；或
   - 进入 **系统设置 → 隐私与安全性**，对 HarnessDock 选择 **仍要打开 / Open Anyway**。
5. 启动后无需单独配置 Runtime，HarnessDock 会自动启动内置 dsh 并进入 Harness Web。

### 使用与退出

功能与 Windows 桌面端一致：刷新、Runtime 重启、插件隔离、Gateway、诊断、窗口控制等都在原生外壳中完成。

退出 HarnessDock 时会同步终止受管 Runtime，避免残留后台进程。

---

## Linux x64

HarnessDock 同时提供 DEB 和 AppImage。

### 方式 A：Debian / Ubuntu 使用 DEB

1. 下载：

```text
HarnessDock-0.1.5-linux-x64.deb
```

2. 安装：

```bash
sudo apt install ./HarnessDock-0.1.5-linux-x64.deb
```

3. 安装完成后从桌面应用菜单启动 HarnessDock。
4. 客户端会自动使用安装包内置 Runtime，不要求系统提前安装 Node / dsh。

卸载时可以通过系统软件管理器，或使用发行版对应的包管理命令完成。

### 方式 B：使用 AppImage

1. 下载：

```text
HarnessDock-0.1.5-linux-x64.AppImage
```

2. 增加执行权限：

```bash
chmod +x HarnessDock-0.1.5-linux-x64.AppImage
```

3. 直接运行：

```bash
./HarnessDock-0.1.5-linux-x64.AppImage
```

### 校验文件

```bash
sha256sum HarnessDock-0.1.5-linux-x64.AppImage
```

或：

```bash
sha256sum HarnessDock-0.1.5-linux-x64.deb
```

将输出与 Release 中的 `SHA256SUMS` 对照。

---

## Android arm64

Android 版本是 **Remote Gateway 客户端**，不是桌面 Full Runtime 的移动移植版。

### 安装 APK

1. 从 [GitHub Release](https://github.com/coeasy/harness_dock/releases/latest) 下载 `HarnessDock-0.1.5-android-arm64-release.apk`。
2. 如果 Android 阻止侧载，请只在确认 APK 来自本仓库 Release 后，为当前下载来源临时允许“安装未知应用”。
3. 安装并打开 HarnessDock。

`.aab` 主要用于分发 / 商店或测试流程，普通用户手动安装优先使用 `.apk`。

### 使用

Android 设备不会启动 Node / dsh，需要连接一个已经运行的 HarnessDock Gateway：

1. 在受信任的桌面端或服务器环境运行 HarnessDock / Harness Runtime。
2. 从桌面 HarnessDock 菜单进入 **Gateway** 能力。
3. 为移动端提供受信任的 **HTTPS** Gateway 地址。
4. Android 客户端连接该 Gateway 后访问 Harness。

不要把本地 Gateway 端口直接裸露到不可信公网。远程访问应使用受信任的 HTTPS Tunnel、Reverse Proxy 或等价的 TLS 终止方案。

---

## iOS Simulator

当前 Release **只提供 iOS Simulator 构建**，不提供真机 IPA，也不代表已经通过 App Store 签名 / 审核。

### 安装

1. 在 macOS 上安装 Xcode 并启动一个 iOS Simulator。
2. 下载 `HarnessDock-0.1.5-ios-arm64-simulator.zip`。
3. 解压得到 Simulator 应用包。
4. 可以把 `.app` 拖入已启动的 Simulator，或使用：

```bash
xcrun simctl install booted /path/to/HarnessDock.app
```

5. 在 Simulator 中启动 HarnessDock。

### 使用

iOS Simulator 与 Android 一样采用 Remote Gateway 模式，需要连接可信 HTTPS HarnessDock Gateway，不会在 Simulator 中启动 Node / dsh。

---

## 移动端 Gateway 使用原则

桌面端与移动端的职责不同：

| 能力 | Windows / macOS / Linux | Android / iOS |
| --- | --- | --- |
| 本地 Node | 内置 | 不运行 |
| 本地 dsh Runtime | 内置 | 不运行 |
| Harness Web | 本地受管 Runtime | 经 Gateway 访问 |
| Gateway Server | 可提供 | 作为客户端连接 |
| 适合离线本地运行 | 是，使用已内置 Runtime | 否，需要可达 Gateway |

Gateway 的设计目标是“把已经受控运行的 Harness 安全地延伸到移动端”，而不是直接把桌面本地端口暴露到公网。

---

## 更新 HarnessDock

当前 v0.1.5 不启用签名自动更新资产，因此客户端更新流程是：

1. 检查是否有新版本；
2. 前往 [GitHub Releases](https://github.com/coeasy/harness_dock/releases/latest)；
3. 下载对应平台的新安装包；
4. 使用 `SHA256SUMS` 校验；
5. 手动安装更新。

正式代码签名与签名自动更新通道启用前，不应把当前更新检查理解为“后台静默自动安装”。

---

## Release 完整性校验

每个正式 Release 都提供 `SHA256SUMS`。推荐在安装前进行校验。

### Windows PowerShell

```powershell
Get-FileHash .\HarnessDock-0.1.5-windows-x64-setup.exe -Algorithm SHA256
```

### macOS

```bash
shasum -a 256 HarnessDock-0.1.5-macos-arm64.dmg
```

### Linux

```bash
sha256sum HarnessDock-0.1.5-linux-x64.AppImage
```

[v0.1.5 SHA256SUMS](https://github.com/coeasy/harness_dock/releases/download/v0.1.5/SHA256SUMS)

---

## 与 DeepSeek Harness 的关系

官方项目：**[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**

DeepSeek Harness 提供 Harness Runtime、Web 与插件生态；HarnessDock 不尝试替代或重新实现这些核心能力。

HarnessDock 的职责边界是：

```text
DeepSeek Harness
  ├─ Runtime / dsh
  ├─ Harness Web
  └─ Plugin ecosystem
          ↑
          │ pinned runtime contract
          │
HarnessDock
  ├─ Native desktop host
  ├─ Runtime lifecycle
  ├─ Window / shell controls
  ├─ Plugin isolation / recovery
  ├─ Gateway
  ├─ Diagnostics
  └─ Packaging / release gates
```

当前 v0.1.5 精确锁定 `dsh-v0.1.5-alpha.1 @ 5dda764ed3aa172535a7967b06ff95d9cbfe536a`，从而让客户端安装包、Runtime provenance 与发布资产保持可追踪。

---

## 架构原则

### 桌面：Harness Web 是唯一正常主业务 Surface

```text
Tauri setup
  -> Host Kernel / startup coordinator
  -> sealed Full Runtime
  -> RuntimeActor / RuntimeLease
  -> validate loopback origin
  -> Harness WebView
  -> Harness Web visible
  -> optional Harness Shell
```

Recovery、Gateway、Diagnostics、Update 都是按需能力，不应该抢占正常首屏。

### Shell fail-open

Harness Shell 是独立可选插件。Shell 失败时回退原生窗口控件，不允许可选 UI 故障阻断 Harness Web。

### Runtime identity

只有与当前 `platform / arch / clientVersion / dshVersion / tag / commit / layout / schema / image identity` 完整匹配的 Runtime 才允许复用。

### 发布同源

正式 Release 只接受同一个 `main` SHA 上生成并通过验证的 candidate 资产，避免跨提交拼装安装包。

---

## 本地一键构建

普通用户下载 Release 即可，不需要源码构建。

如果你要开发 HarnessDock 或构建自己的客户端，先安装当前平台的 Rust / Tauri 2 系统依赖，然后在仓库根目录使用一键入口。

### Windows

```bat
scripts\build.bat
```

### macOS / Linux

```bash
./scripts/build.sh
```

一键构建会：

1. 优先复用满足版本门禁的本机 Node；缺失或版本不兼容时使用校验过的 portable Node；
2. 使用根 `packageManager` 锁定的精确 pnpm；
3. 构建 embedded client 与 Harness Shell；
4. 执行 Tauri Rust host check；
5. 准备并验证当前平台 sealed Runtime；
6. 实际启动 dsh，完成 Harness Web token → cookie → HTML 健康验证；
7. 仅在真正生成安装包时使用锁定的 Tauri CLI；
8. 输出当前平台原生安装包 / Bundle。

常用模式：

```text
scripts\build.bat --check-only
scripts\build.bat --force-runtime
scripts\build.bat --source-runtime --force-runtime

./scripts/build.sh --check-only
./scripts/build.sh --force-runtime
./scripts/build.sh --source-runtime --force-runtime
```

默认产物目录：

```text
Windows: apps/tauri/src-tauri/target/release/bundle/nsis/
macOS/Linux: apps/tauri/src-tauri/target/release/bundle/
```

> 源码构建时使用的系统 Node / pnpm / Rust / Tauri 仅属于**构建工具链**。最终安装后的 HarnessDock 始终使用安装包内经过 identity 校验的 sealed Node + dsh Runtime，不依赖用户系统 Node。

---

## 开发

当前开发工具链：

- Node.js `^22.19.0` 或 `>=24`
- pnpm：以根 `package.json#packageManager` 为准，当前 `10.12.1`
- Rust：由 `rust-toolchain.toml` 固定
- Tauri CLI：由 `scripts/versions.json` 固定，当前 `2.11.4`
- Tauri 2 平台系统依赖

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

---

## 发布门禁

v0.1.5 的正式发布必须在同一个 `main` SHA 上满足：

1. `ci` 全绿；
2. `tauri-candidate` 全绿；
3. root / workspace / Tauri / Rust / Shell / origin / manifest 版本一致；
4. Runtime 精确锁定 `dsh-v0.1.5-alpha.1 @ 5dda764e...`；
5. HarnessDock 产品版本与 pinned dsh 基础 SemVer 一致；
6. Windows / Linux / macOS / Android / iOS 候选产物全部生成并验证；
7. Release 资产全部来自同一个绿色 candidate；
8. Windows 安装包完成真实安装启动 smoke，并到达 `primary_visible`；
9. 本地构建链变更通过 `local-one-click-build` clean-clone 门禁。

---

## 文档

- [文档索引](docs/README.md)
- [项目介绍](docs/PROJECT_INTRO.md)
- [Tauri 客户端说明](apps/tauri/README.md)
- [版本策略](docs/VERSIONING.md)
- [v0.1.5 发布说明](.github/release-notes/v0.1.5.md)
- [DeepSeek Harness 官方项目](https://github.com/deepseek-ai/deepseek-harness)

`docs/` 中部分文件名包含 `v0.2.x`，它们是 Native Host 重构阶段留下的历史架构设计稿，不代表当前产品版本。当前活动版本以根 `package.json`、`release-manifest.json` 与本 README 为准。

---

## License

HarnessDock 使用 MIT License。

DeepSeek Harness 与其它第三方依赖遵循各自许可证、版权与商标规则。
