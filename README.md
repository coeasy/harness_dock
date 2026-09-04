# HarnessDock v0.1.2

> DeepSeek Harness 的跨平台原生客户端外壳。桌面端启动即进入官方 Harness Web，外壳只负责 Runtime 生命周期、窗口操作、插件隔离恢复、Gateway、诊断与发布更新边界。

> 本项目为独立第三方客户端，与 DeepSeek 官方无隶属或背书关系。DeepSeek、DeepSeek Harness 及相关标识归其权利人所有。

## 当前版本

| 项目 | 当前值 |
| --- | --- |
| HarnessDock | `0.1.2` |
| 发布通道 | `beta` |
| 当前发布 tag | `v0.1.2-beta.2` |
| 内置 DeepSeek Harness Runtime | `dsh-v0.1.2-rc.1` |
| Runtime commit | `a66e4702047846cdaa10c66c9d3df3951f5ea70d` |
| 桌面宿主 | Tauri 2 |
| 桌面 Runtime | Full / sealed / 首启零下载 |
| 移动端 Runtime | Remote Gateway only |

### 版本规则

从 v0.1.2 起，HarnessDock 的产品版本与**当前锁定的最新 dsh 基础 SemVer**对齐：

```text
dsh-v0.1.2-rc.1  -> HarnessDock 0.1.2
dsh-v0.1.3-beta.2 -> HarnessDock 0.1.3
dsh-v1.0.0         -> HarnessDock 1.0.0
```

`rc / beta / alpha` 后缀属于上游 Runtime 的精确来源信息，不附加到 HarnessDock 产品版本。发布门禁会同时检查客户端版本、Runtime version/tag/commit、Shell 版本和下载 URL，防止再次出现版本线错位。

## 产品定位

HarnessDock 不 fork、不重写 DeepSeek Harness Web UI。桌面端只做 Native Host：

```text
HarnessDock
  -> sealed Node + pinned dsh Runtime
  -> Runtime ready / RuntimeLease
  -> isolated loopback WebView
  -> official Harness Web
  -> optional Harness Shell controls
```

正常启动不进入设置页。Runtime 就绪后直接打开 Harness Web；Recovery、Gateway、Diagnostics 和 Update 都是按需 Surface，不得成为主界面的前置依赖。

## 核心能力

- **启动即用 Harness Web**：Windows、macOS、Linux 启动后自动拉起安装包内置 Runtime 并显示 Harness Web。
- **Full Runtime 桌面包**：Node、dsh 与必要 Runtime Tool 随安装包分发；首次启动不下载 Node/dsh，离线环境仍可启动已内置的 Harness Web。
- **桌面外壳操作**：菜单、刷新 Web、重启 Runtime、隔离插件启动、Gateway、插件诊断、最小化、最大化/还原、关闭与受控退出。
- **Shell fail-open**：独立 `@dsh/plugin-harness-shell` 注入失败时恢复原生窗口边框，不允许可选 Shell 故障阻断 Harness Web。
- **Runtime 隔离恢复**：第三方插件故障进入受控隔离/恢复路径，不直接修改用户真实配置，也不会让可选插件异常退出客户端。
- **进程生命周期保护**：Runtime/Gateway 使用 generation、lease、single-flight 与退出保护；Windows 使用 Job Object，Unix 使用独立 process group，减少后台孤儿进程。
- **受限 WebView**：桌面 Harness WebView 只接受当前受管 `http://127.0.0.1:<port>` Runtime origin。
- **移动端 Remote Gateway**：Android/iOS 不在设备内启动 Node/dsh，只连接可信 HTTPS Gateway。
- **独立 Shell 插件**：`packages/plugin-harness-shell` 可独立构建/发布，宿主能力缺失时隐藏对应操作而不是阻断 Web。

## 平台与交付

| 平台 | 交付物 | Runtime 模式 | v0.1.2 beta 状态 |
| --- | --- | --- | --- |
| Windows x64 | NSIS Setup | Full local | unsigned test build |
| Linux x64 | DEB / AppImage | Full local | unsigned test build |
| macOS x64 | DMG / app archive | Full local | unsigned, not notarized |
| macOS arm64 | DMG / app archive | Full local | unsigned, not notarized |
| Android arm64 | APK / AAB | Remote Gateway | release-optimized, non-store signing |
| iOS Simulator | ZIP | Remote Gateway | Simulator only |

当前 beta 发布不启用 Tauri 自动更新签名资产，也不生成 `latest.json`。正式签名通道启用前，更新检查只引导用户进入 GitHub Release，下载后可使用 `SHA256SUMS` 校验完整性。

## 安装与使用

### Windows

下载 `HarnessDock-0.1.2-windows-x64-setup.exe` 并按当前用户安装。安装程序使用 HarnessDock 自有图标；CI 会直接校验最终 NSIS PE 图标资源，防止回退为默认图标。

### Linux

优先使用发行版对应的 DEB，或直接运行 AppImage。桌面包已包含 Full Runtime，不要求系统预装 Node 或 dsh。

### macOS

按 CPU 架构选择 x64 或 arm64 DMG。v0.1.2 beta 未做 Apple notarization，因此仅作为测试候选分发。

### Android / iOS

移动端不包含桌面 Runtime，需要连接桌面端/服务器端 HarnessDock Gateway。不要把本地 Gateway 端口直接暴露到不可信公网；远程访问应通过受信任的 HTTPS Tunnel / Reverse Proxy。

## 桌面外壳

主 Harness Web 顶部提供：

- 菜单
- 刷新 Web
- 最小化
- 最大化 / 还原
- 关闭

菜单业务操作通过 Host Protocol 进入统一 Host Kernel/Reconciler，而不是由远程 Web 页面直接持有高权限 Tauri API。插件异常、Tray/Updater/菜单初始化异常采用 fail-open 策略，不得阻断正常 Harness Web 启动。

## 开发

要求：

- Node.js `^22.19.0` 或 `>=24`
- pnpm `10.12.1`
- Rust toolchain 由 `rust-toolchain.toml` 固定
- Tauri 2 系统依赖

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

## 发布门禁

v0.1.2 beta 只有在同一个 `main` SHA 上满足以下条件才允许发布：

1. `ci` 全绿；
2. `tauri-candidate` 全绿；
3. 根版本、workspace、Tauri、Rust crate/Cargo.lock、Shell、origin、Release manifest 全部为 `0.1.2`；
4. pinned Runtime 精确为 `dsh-v0.1.2-rc.1 @ a66e470...`；
5. HarnessDock 产品版本等于 pinned dsh 的基础 SemVer；
6. Windows/Linux/macOS/Android/iOS 候选产物全部生成并通过校验；
7. 发布资产来自同一个绿色 candidate，不允许用不同 SHA 的产物覆盖。

当前 beta 契约发布 15 个资产：桌面/移动端候选包、4 个平台 Runtime bundle 与 `SHA256SUMS`。

## 文档

- [文档索引](docs/README.md)
- [项目介绍](docs/PROJECT_INTRO.md)
- [Tauri 客户端说明](apps/tauri/README.md)
- [v0.1.2 发布说明](.github/release-notes/v0.1.2.md)
- [v0.1.2 beta.2 启动链路修复说明](.github/release-notes/v0.1.2-beta.2.md)
- [v0.1.2 beta.1 历史说明](.github/release-notes/v0.1.2-beta.1.md)

`docs/` 中仍保留部分文件名含 `v0.2.x` 的历史架构设计稿，用于记录 Native Host 重构过程；这些文件名**不再代表 HarnessDock 当前产品版本**。当前活动产品版本以根 `package.json`、`release-manifest.json` 和本页为准。

## License

MIT。DeepSeek Harness 与其它第三方依赖遵循各自许可证和商标规则。
