# HarnessDock 本地一键构建与启动测试

Windows 本地开发统一使用 `scripts/local-client.ps1`。它只面向 Tauri 客户端，不恢复 Electron 路径。

## 最快启动

在仓库根目录执行：

```powershell
.\scripts\local-client.cmd
```

等价于：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\scripts\local-client.ps1 -Mode quick
```

`quick` 模式默认：

- 复用现有 `node_modules`；仅缺失时才执行 `pnpm install`；
- 不执行 `scripts/node-version-check.cjs`；
- 不执行 `scripts/bootstrap.mjs`；
- 不重复准备/下载桌面 Harness Runtime；
- 增量构建 Tauri / Rust 与插件改动；
- 构建完成后自动启动 HarnessDock；
- 启动前关闭旧的 `harnessdock-tauri.exe`，避免误测旧二进制。

也可以执行：

```powershell
pnpm local:client
```

## 构建 release 客户端

```powershell
.\scripts\local-client.cmd -Mode build
```

或：

```powershell
pnpm local:build
```

需要跳过单元测试以缩短本地迭代：

```powershell
.\scripts\local-client.cmd -Mode build -SkipTests
```

需要强制刷新 workspace 依赖：

```powershell
.\scripts\local-client.cmd -Mode build -Install
```

需要从干净 Rust target 开始：

```powershell
.\scripts\local-client.cmd -Mode build -Clean
```

## 打包后真实启动 smoke

推荐在准备提交或发布候选前执行：

```powershell
.\scripts\local-client.cmd -Mode smoke
```

或：

```powershell
pnpm local:smoke
```

该模式会：

1. 完成 Tauri release 构建；
2. 自动定位最新 NSIS `*setup.exe`；
3. 静默安装到临时目录；
4. 从与仓库无关的 neutral working directory 启动真实安装后的 `harnessdock-tauri.exe`；
5. 清理旧 startup trace 与旧 Runtime work directory，避免误读历史状态；
6. 等待并验证启动日志依次出现 `runtime_ready`、`webview_requested`、`primary_visible`；
7. 读取当前运行实例生成的 `ready.json`；
8. 对 Harness Web 做 launch-token HTML 探针；
9. 使用同一 cookie session 对 clean `/` URL 连续做两次 HTML 健康探针；
10. 若在 `primary_visible` 前进入 `recovery`、客户端提前退出、ready endpoint 非 loopback 或超时，则测试失败并返回非 0 退出码。

默认 smoke 成功后保留客户端运行，方便人工继续点击菜单、刷新 Web、重启 Runtime、窗口最小化/最大化/关闭等操作。若只需要自动验收后关闭：

```powershell
.\scripts\local-client.cmd -Mode smoke -CloseAfterSmoke
```

默认超时 120 秒，可调整：

```powershell
.\scripts\local-client.cmd -Mode smoke -TimeoutSeconds 180
```

## 日志

每次执行都会记录 transcript 到：

```text
.local-logs/local-client-YYYYMMDD-HHMMSS.log
```

HarnessDock 自身启动 trace 仍使用应用当前的 `%TEMP%\harnessdock-logs\startup-*.log`。

## 本地工具要求

快速脚本不会做阻塞式 Node 版本预检，但构建工具本身仍需要开发环境中可执行：

- `node`
- `pnpm`
- `cargo`
- Tauri 2 在 Windows 上需要的系统构建依赖

这里的 Node/pnpm 是**构建工具**，不是最终安装包运行 Harness Web 所依赖的系统 Runtime。桌面安装包继续使用项目内封装的 sealed/full Runtime，客户端正常启动不应因为系统 Node 检测被阻塞。
