# HarnessDock 本地一键构建

HarnessDock 支持普通用户从源码构建当前平台的桌面客户端。一键入口会准备**构建期** Node/pnpm/Tauri CLI、精确 pinned 的 sealed Harness Runtime、插件和 Rust 宿主，然后生成当前平台的原生安装包。

> 构建期 Node/pnpm 只用于编译。最终安装的 HarnessDock 运行时使用安装包内置的 Node+dsh Runtime，启动客户端不会检查系统 Node。

## Windows x64

准备 Tauri 2 所需的 Rust/MSVC 系统依赖后，在仓库根目录运行：

```bat
scripts\build.bat
```

脚本会自动：

1. 检查构建期 Node；缺失或版本不兼容时下载固定版本 portable Node 并验证 SHA-256；
2. 激活根 `package.json#packageManager` 指定的精确 pnpm 版本；
3. 安装 workspace 依赖；
4. 准备与 `origin.json` 中 dsh version/tag/commit 完全一致的 sealed Runtime；
5. 对 Runtime 执行真实 Harness Web readiness smoke；
6. 构建 embedded-client 与 Harness Shell 插件；
7. 使用精确 `tauri-cli 2.11.4` 检查并构建 Tauri Native Host；
8. 生成 NSIS 安装程序。

默认 Windows 产物目录：

```text
apps\tauri\src-tauri\target\release\bundle\nsis\
```

## macOS / Linux

准备 Rust 与 Tauri 2 当前平台系统依赖后运行：

```bash
bash scripts/build.sh
```

刻意通过 `bash` 调用，不要求 `build.sh` 具有 executable bit。因此从 GitHub Source ZIP、跨文件系统复制或某些解压工具获得的源码也可以直接构建，无需先执行 `chmod +x`。

默认产物目录：

```text
apps/tauri/src-tauri/target/release/bundle/
```

当前本地桌面 Runtime 目标：

- Windows x64
- Linux x64
- macOS x64
- macOS arm64

Linux arm64 暂不属于当前桌面本地构建目标矩阵。

## 常用参数

只准备环境、Runtime 并执行 Rust Host check，不生成安装包：

```bat
scripts\build.bat --check-only
```

```bash
bash scripts/build.sh --check-only
```

强制重新获取/构建 sealed Runtime：

```bat
scripts\build.bat --force-runtime
```

```bash
bash scripts/build.sh --force-runtime
```

跳过 Release Runtime 下载，直接从精确 pinned DeepSeek Harness tag + commit 构建 Runtime：

```bat
scripts\build.bat --source-runtime --force-runtime
```

```bash
bash scripts/build.sh --source-runtime --force-runtime
```

开发/CI 可使用 `HARNESSDOCK_FORCE_PORTABLE_NODE=1` 强制经过 portable Node 路径，以验证裸机行为。

## Runtime 复用条件

本地已有 `apps/tauri/src-tauri/resources/dsh-runtime` 时，不会仅凭 dsh 版本号复用。manifest 必须同时匹配：

- schema version；
- HarnessDock client version；
- host platform / arch；
- dsh version；
- pinned upstream git tag；
- pinned upstream git commit；
- `runtimeEmbedded=true`；
- `firstLaunchRuntimeDownloadRequired=false`；
- `imageIdentityAlgorithm=sha256-v1`；
- 合法的 runtime image identity 和正数 payload metadata。

任一条件不匹配时，本地构建会重新准备 Runtime，避免同版本号下误复用旧 commit 的 Runtime。

## 下载与校验

Runtime 优先尝试当前 HarnessDock release 对应 bundle，其次使用 `origin.json` 的 pinned bundle URL；只有存在可信 SHA-256 digest 时才接受下载包。下载包不匹配时自动转入 pinned upstream 源码构建。

portable Node 同样验证官方/镜像发布的 `SHASUMS256.txt`。默认使用 nodejs.org，失败时尝试 npmmirror。

## CI 回归门禁

`.github/workflows/local-one-click-build.yml` 会从干净本地状态真实运行用户入口：

```text
fresh checkout
  -> 清空 .local-tools/.local-cache/local Runtime
  -> portable Node
  -> exact pnpm
  -> exact Runtime
  -> Harness Web readiness smoke
  -> plugins
  -> exact Tauri CLI
  -> Rust Host check
  -> Tauri package
  -> 验证平台安装产物存在
```

Windows 还会分别以 nodejs.org 和 npmmirror 为唯一 Node 源执行真实下载 + SHA-256 检查，避免 runner 预装 Node 掩盖裸机构建问题。

## 开发者快速路径

`scripts/local-client.ps1` 保留给 Windows 开发者做快速迭代和安装包 smoke；普通用户首次源码构建优先使用 `scripts\build.bat`。`pnpm tauri:build` / `pnpm build:desktop` 也统一进入 `scripts/build.mjs` 的安全构建链。
