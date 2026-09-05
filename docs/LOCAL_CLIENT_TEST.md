# HarnessDock 本地一键构建与启动测试

HarnessDock 桌面端只保留 Tauri。普通用户从源码构建客户端时，不需要预先手工准备 `apps/tauri/src-tauri/resources/dsh-runtime`，也不需要先理解 DeepSeek Harness 的 release pack 流程。

## 一键构建自己的客户端

### Windows x64

克隆仓库后，在仓库根目录直接双击或执行：

```bat
scripts\build.bat
```

脚本会自动完成：

1. 检查源码构建所需 Node；
2. 如果系统 Node 缺失或版本不满足要求，下载项目固定版本的 portable Node，并用官方 `SHASUMS256.txt` 校验 SHA-256；
3. 通过 `bootstrap.mjs` 准备 pnpm 10 和 workspace dependencies；
4. 构建 embedded client 与独立 Harness Shell 插件；
5. 为当前 `win32-x64` 准备 sealed/full Harness Runtime；
6. 优先复用已经验证过的本地 Runtime；
7. 若存在当前版本 Runtime Release asset，则下载并校验 GitHub asset digest / `SHA256SUMS`；
8. 若 Release Runtime 不存在，则自动 clone 精确 pinned `deepseek-harness` tag，并校验 commit，然后使用上游 official build + pack 流程在本机构建 Runtime；
9. 对 sealed Runtime 执行真实 `smoke-runtime`，确认 Harness Web readiness；
10. 如果没有 Tauri CLI，则将固定 `tauri-cli 2.11.4` 安装到仓库自己的 `.local-tools`，不要求污染全局工具目录；
11. 执行 Rust host check；
12. 生成 Windows NSIS 安装包。

成功后默认产物目录：

```text
apps\tauri\src-tauri\target\release\bundle\nsis\
```

### macOS / Linux

```bash
chmod +x scripts/build.sh
./scripts/build.sh
```

`build.sh` 同样会在系统 Node 不满足要求时准备经过 SHA-256 校验的 portable Node，然后进入与 Windows 相同的 sealed Runtime / plugin / Rust / Tauri 构建链路。

当前桌面本地 Runtime 目标矩阵为：

- Windows x64
- Linux x64
- macOS x64
- macOS arm64

Linux arm64 尚不属于当前桌面发布矩阵，因此一键脚本会明确拒绝，而不是生成未经支持的包。

## Runtime 准备策略

可以单独执行：

```bash
node scripts/prepare-local-runtime.mjs
```

默认优先级：

```text
已有且 manifest 匹配的 sealed Runtime
  -> 当前 HarnessDock 版本的 GitHub Runtime asset
  -> origin.json 中声明的 Runtime asset
  -> 精确 pinned upstream source build + official packs
```

强制重新准备：

```bash
node scripts/prepare-local-runtime.mjs --force
```

强制从官方 pinned 源码生成，不尝试 Release asset：

```bash
node scripts/prepare-local-runtime.mjs --source-only --force
```

如果只允许使用已发布并带 SHA-256 的 Runtime，不允许源码 fallback：

```bash
node scripts/prepare-local-runtime.mjs --no-source-fallback
```

本地缓存位置：

```text
.local-cache/
.local-tools/
apps/tauri/src-tauri/resources/dsh-runtime/
```

这些目录均被 `.gitignore` 排除，不会进入提交。

## 构建参数

跳过单元测试：

```bat
scripts\build.bat --skip-tests
```

只完成 Runtime/插件/Rust 检查，不生成安装包：

```bat
scripts\build.bat --check-only
```

强制刷新 sealed Runtime：

```bat
scripts\build.bat --force-runtime
```

强制从 pinned upstream source 构建 Runtime：

```bat
scripts\build.bat --source-runtime --force-runtime
```

已经由外部流程准备好 Runtime 时，可以显式跳过 Runtime 准备：

```bat
scripts\build.bat --skip-runtime
```

不建议普通用户使用 `--skip-runtime`，因为这可能让本地包和当前 pinned Runtime 脱节。

## pnpm 构建入口

已有 Node/pnpm 开发环境时，也可以执行：

```bash
pnpm tauri:build
```

根级 `tauri:build` 和 `build:desktop` 已统一路由到 `scripts/build.mjs`，因此不会再直接绕过 sealed Runtime 准备步骤。

## Windows 快速开发与真实安装 smoke

已有完整开发环境时仍可使用：

```powershell
.\scripts\local-client.cmd
```

默认 `quick` 模式用于增量 `cargo tauri dev`。它是开发快捷入口，不是裸机器的一键安装工具。

构建 release 客户端：

```powershell
.\scripts\local-client.cmd -Mode build
```

打包后真实启动 smoke：

```powershell
.\scripts\local-client.cmd -Mode smoke
```

或：

```powershell
pnpm local:smoke
```

smoke 模式会：

1. 完成 Tauri release 构建；
2. 自动定位最新 NSIS `*setup.exe`；
3. 静默安装到临时目录；
4. 从与仓库无关的 neutral working directory 启动真实安装后的 `harnessdock-tauri.exe`；
5. 清理旧 startup trace 与旧 Runtime work directory；
6. 验证 `runtime_ready`、`webview_requested`、`primary_visible`；
7. 读取当前实例 `ready.json`；
8. 执行 launch-token -> cookie 的 BrowserAuth；
9. 使用同一 cookie session 对 clean `/` URL 连续做 HTML 健康探针；
10. 发现 recovery、进程提前退出、loopback endpoint 异常、Harness Web 拒绝连接或超时即失败。

自动验收后关闭客户端：

```powershell
.\scripts\local-client.cmd -Mode smoke -CloseAfterSmoke
```

默认超时 120 秒，可调整：

```powershell
.\scripts\local-client.cmd -Mode smoke -TimeoutSeconds 180
```

## 系统级前置条件

一键脚本可以自动准备 Node、pnpm、Tauri CLI 和 Harness Runtime，但原生桌面编译仍需要操作系统级工具：

### Windows

- Rust / Cargo（MSVC toolchain）
- Microsoft C++ Build Tools / Windows SDK
- PowerShell 5.1+
- Tauri 2 Windows 系统依赖

### macOS

- Rust / Cargo
- Xcode Command Line Tools

### Linux

- Rust / Cargo
- Tauri 2 / WebKitGTK 4.1 / GTK3 等发行版系统开发包

如果这些原生系统依赖缺失，脚本会在 Rust/Tauri 阶段明确失败；不会退回 Electron，也不会下载另一套运行时来掩盖问题。

## 重要边界

源码构建时检查的 Node/pnpm 只是**开发者构建工具**。

最终 Windows/macOS/Linux 安装包继续内置 sealed/full Node+dsh Runtime。用户安装和启动 HarnessDock 时：

- 不检查系统 Node；
- 不依赖系统 pnpm；
- 首次启动不下载 Node/dsh；
- Harness Web 只能在 embedded Runtime 真正 ready 后进入主界面。
