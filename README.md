<div align="center">

<img src="apps/tauri/src-tauri/icons/app-icon.png" width="112" alt="HarnessDock icon" />

# HarnessDock v0.1.5

**DeepSeek Harness 的跨平台原生客户端**

[DeepSeek Harness 官方项目](https://github.com/deepseek-ai/deepseek-harness) · [下载最新版](https://github.com/coeasy/harness_dock/releases/latest) · [项目文档](docs/README.md) · [v0.1.5-rc.2 发布说明](.github/release-notes/v0.1.5-rc.2.md)

</div>

> HarnessDock 是独立的非官方客户端，不 fork、不重写 DeepSeek Harness Web UI。它为官方 Harness Runtime / Web 提供安装、原生宿主、生命周期保护、桌面外壳与移动端 Gateway。

## 当前版本

| 项目 | 当前值 |
| --- | --- |
| HarnessDock | `0.1.5` |
| 发布通道 | `rc`（发布候选） |
| 当前发布 tag | `v0.1.5-rc.2` |
| DeepSeek Harness Runtime | `dsh-v0.1.5-rc.2` |
| Runtime commit | `fb2c4b9e698e30edb738bca4cf0618587db7d203` |
| 桌面宿主 | Tauri 2 |
| 桌面 Runtime | Full / sealed / 首启零下载 |
| 移动 Runtime | Remote Gateway only |

正式 `v0.1.5` 保持不可变；当前修复线使用 `v0.1.5-rc.2` 候选标签重新构建并验证完整资产，不覆盖稳定 tag。

## 核心架构

```text
HarnessDock
  ├─ Tauri Native Host
  ├─ Sealed Node + pinned dsh Runtime
  │    └─ dsh --profile <profile>
  ├─ Runtime generation / RuntimeLease
  ├─ Host Protocol v2 / Capability Broker
  ├─ Harness WebView
  ├─ Harness Shell
  ├─ Plugin Recovery / Rescue Web / Quarantine
  └─ Remote Gateway (mobile)
```

桌面安装包内置受版本约束的 Node 与 dsh Runtime。正常启动不会重新探测或下载系统 Node，而是直接启动封装 Runtime，等待当前 generation 的可信 `ready.json`，验证 PID、nonce、imageIdentity 与本地 origin 后进入 Harness Web。

受管桌面 WebView 的 Runtime ACL 始终精确绑定当前 lease 的 `http://127.0.0.1:<managed-port>`，不会扩展为任意 localhost / loopback origin。

Android / iOS 不在设备中启动 Node/dsh，只作为 Remote Gateway 客户端工作。

## dsh Profile 启动

从 `v0.1.5-rc.2` 候选线开始，HarnessDock 不再把 Runtime profile 固定为不可配置的 `web`。在 **插件诊断 / Diagnostics → dsh 启动配置** 中可以设置：

| 配置 | 说明 |
| --- | --- |
| Profile | 对应官方 `dsh --profile <name>`，默认 `web` |
| DSH_HOME | 可选绝对路径；留空沿用 dsh 的系统环境/默认目录 |
| Auto | 先启动所选 profile；`web` 保持正常插件恢复；非 web 失败时转 Rescue Web |
| Direct | 仅启动所选 profile 一次，失败原样返回，适合诊断自定义 profile |
| Safe / Rescue Web | 固定官方 `web`，本 generation 隔离外部/用户插件；配置清单损坏时才回退私有 `DSH_HOME` |

Profile 名称直接遵循 DeepSeek Harness 的 profile 目录语义：

```text
$DSH_HOME/
  cordis.patch.yml
  profiles/
    web/
    my-profile/
      package.json
      cordis.patch.yml
```

HarnessDock 支持官方 profile 名称以及用户创建的自定义 profile。需要注意：HarnessDock 是 Harness Web 客户端，所选 profile 必须最终提供兼容的 Web surface/ready contract；`headless`、SDK 或 ACP 类 profile 本身并不等价于桌面 Web profile。需要精确调试这些 profile 时可使用 Direct 模式观察真实启动错误。

### 为什么不允许直接替换 dsh 可执行文件？

公开设置只允许改变 `profile` 与 `DSH_HOME`，不会把任意外部 dsh 路径注入生产启动链。原因是桌面客户端依赖以下安全合同：

- sealed Runtime `imageIdentity`；
- 精确 dsh tag/commit；
- Runtime generation + 随机 nonce；
- 受管 PID 与 `127.0.0.1` origin；
- 当前 `RuntimeLease` 才能控制 Harness WebView。

任意外部 executable 会绕过这些发布和身份保证。如果未来增加 External Runtime，将作为显式 Developer Mode 单独设计，不混入默认用户启动路径。

## 启动、诊断与恢复顺序

默认 `web + Auto`：

```text
启动 HarnessDock
  -> 读取一次启动配置
  -> 启动 sealed dsh --profile web
  -> ready / RuntimeLease 校验
  -> Harness Web

浏览器插件故障
  -> Host Protocol v2 typed diagnostic command
  -> RuntimeLease / origin / generation / capability 校验
  -> 精确记录 suspected plugin
  -> Diagnostics 告知用户问题插件

需要救援
  -> Rescue Web 使用官方 web profile
  -> 按配置来源隔离全部第三方/用户插件（仅当前 generation）
  -> 保留可用的 DSH_HOME / 模型与基础设置
  -> 配置清单损坏时才使用 private-home hard rescue
  -> 用户修复插件
  -> 恢复全部插件并正常重启
  -> Safe -> Auto
  -> 正常模式重新验证
```

正常自动 quarantine 仍保持保守，不会因为名称伪装而把用户来源插件当成官方插件，也不会 blanket-disable 官方 DeepSeek Web 行。Rescue Web 的隔离来自权威配置来源 provenance，而不是仅根据 package name 判断。

浏览器侧插件故障上报不再拥有独立 direct Tauri IPC。上报只允许传递规范化插件标识符，原始堆栈、URL、本地路径或可能含 token 的错误文本不会作为诊断 payload 穿过 WebView → Host 边界。

## WebView 兼容与首屏 handoff

- 老版本 WebView2 通过真实 `%IteratorPrototype%` 兼容层获得 `Iterator` global，PDF.js 6.x 对 `Iterator.prototype` 的扩展可被内置迭代器继承。
- 官方 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 在正常模式保持启用，不使用 Rescue Web 掩盖官方兼容问题。
- Harness 首屏使用原地 loading card，只有检测到有意义的 Harness/error 内容连续存在两个 compositor frame 后才 handoff。
- 不使用任意固定延迟、不创建第二个 Harness WebView，也不通过持续 blur/filter 动画掩盖空白帧。

## 桌面外壳

HarnessDock 只在 Harness Web 外提供必要宿主能力：

- 刷新 Harness Web；
- 重启 Runtime；
- Rescue Web 隔离第三方插件启动；
- 恢复全部插件并正常重启；
- Gateway；
- 插件诊断与 dsh 启动配置；
- 最小化、最大化 / 还原；
- 关闭时清理全部受管进程。

远程 Harness Web 不直接获得高权限 Tauri IPC。浏览器诊断仅通过 Host Protocol v2 的 HarnessWeb 专属 capability，并继续受 RuntimeLease、origin、generation、surface 与 request-id 去重约束；Profile/DSH_HOME 写入、插件管理、更新安装、退出等高权限能力仍只属于本地受信 surface。

## 平台与安装包

| 平台 | Release 资产 | Runtime 模式 |
| --- | --- | --- |
| Windows x64 | `HarnessDock-0.1.5-windows-x64-setup.exe` | Sealed local |
| Linux x64 | `.deb` / `.AppImage` | Sealed local |
| macOS Apple Silicon | `macos-arm64.dmg` / `.app.tar.gz` | Sealed local |
| macOS Intel | `macos-x64.dmg` / `.app.tar.gz` | Sealed local |
| Android arm64 | `.apk` / `.aab` | Remote Gateway |
| iOS Simulator | `ios-arm64-simulator.zip` | Remote Gateway |

### Windows

下载 `HarnessDock-0.1.5-windows-x64-setup.exe`，使用 PowerShell 校验：

```powershell
Get-FileHash .\HarnessDock-0.1.5-windows-x64-setup.exe -Algorithm SHA256
```

### macOS

Apple Silicon 选择 `HarnessDock-0.1.5-macos-arm64.dmg`，Intel 选择 `HarnessDock-0.1.5-macos-x64.dmg`。当前候选发布未 notarize，请只从本仓库 Release 下载并与 `SHA256SUMS` 对照。

### Linux

Debian / Ubuntu：

```bash
sudo apt install ./HarnessDock-0.1.5-linux-x64.deb
```

AppImage：

```bash
chmod +x HarnessDock-0.1.5-linux-x64.AppImage
./HarnessDock-0.1.5-linux-x64.AppImage
```

### Android / iOS

移动端需要连接可信 HTTPS HarnessDock Gateway。不要把本地 Runtime/Gateway 端口裸露到不可信公网。

## Release 规则

`v0.1.5-rc.2` 作为当前发布候选执行完整发布门禁；稳定 `v0.1.5` 不移动、不覆盖：

1. 从 `release-manifest.json` 的精确上游 tag/commit 构建 official dsh source closure；
2. 为 Windows / Linux / macOS 分别生成 sealed Runtime；
3. 执行普通 CI、Host Protocol、Runtime/Surface/Gateway/Update actor 测试；
4. 执行 Windows/macOS/Linux Rust 与 Android/iOS smoke；
5. 执行 Windows clean one-click 构建、安装和 Harness Web startup proof，以及 macOS/Linux POSIX one-click Runtime/Rust gates；
6. main 上由 `tauri-candidate` 构建所有目标资产；
7. Windows 执行同 SHA installed packaged-startup gate；
8. 只有同一个 main SHA 上所有 required workflows 绿色，`release` 才允许组装资产、重新验证 sealed Runtime identity、校验 SHA-256 并发布 GitHub prerelease。

当前 Runtime 精确固定到上游 `dsh-v0.1.5-rc.2`。如果 npm 上 `@deepseek-ai/dsh` 的 umbrella 包落后于该 Git tag，HarnessDock 仍以不可变的上游 Git tag/commit 构建 Runtime，而不会伪造不存在的 npm tarball/integrity。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test
pnpm tauri:check
```

Windows 本地快速客户端：

```powershell
pnpm local:client
```

完整构建：

```powershell
pnpm local:build
```

更多架构、发布、Gateway 与重构文档见 [`docs/`](docs/README.md)。

## License

MIT。DeepSeek、DeepSeek Harness 及相关名称和标识归其权利人所有。
