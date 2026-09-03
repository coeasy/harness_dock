<div align="center">

<img src="apps/tauri/src-tauri/icons/app-icon.png" width="88" alt="HarnessDock icon" />

# HarnessDock

**DeepSeek Harness 的 Full-only Tauri 2 桌面 / 移动客户端**

*官方 Harness Web UI · 桌面内置固定 Runtime · 移动端安全 Remote Gateway · 插件故障隔离*

</div>

## 当前版本

- **HarnessDock v0.2.10**：Tauri 2 主线，Windows/macOS/Linux 默认且仅发布 Full Runtime 桌面包。
- 正式客户端的启动、菜单、更新、Runtime/Gateway 管理、候选构建和 Release 全部以 Tauri 为唯一主路径；根级命令不再暴露 Electron 打包入口。
- `apps/desktop` 仅保留历史兼容源码，不进入正式 candidate / Release，也不是主验证链路。
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

## v0.2.10 核心收敛

- HarnessDock 启动后由 Tauri 原生协调器直接拉起固定 Runtime，默认进入 Harness Web；隐藏控制页只负责失败恢复。
- Runtime/插件异常不会让宿主退出；第三方插件可进入 quarantine 或安全配置，Harness Web 仍保留恢复路径。
- Gateway 启动增加互斥与生命周期 generation，重复 IPC 不会并发拉起多个 sidecar，停止或 Runtime 替换期间产生的陈旧启动结果会被拒绝。
- Gateway 状态会识别已经退出的子进程；ready PID 必须与受管 sidecar PID 一致。
- Runtime/Gateway 退出采用“优雅停止 → 有界等待 → 强制回收”，降低 Node worker/子进程遗留风险。
- 插件诊断是按需窗口，不抢占 Harness Web 首屏；菜单统一提供 Web 刷新、Runtime 重启、插件隔离恢复、诊断和自动更新。
- Windows 自动更新禁止降级；自动安装必须通过 Tauri updater 公钥与签名清单，签名清单版本还必须与 GitHub 最新稳定 Release 一致。
- Android/iOS 始终是 Remote-only Thin Client，不在移动设备内启动桌面 Runtime 或 Gateway Host。

## 架构

```text
Desktop (Windows/macOS/Linux)
  Tauri Host
    +-- pinned Full dsh Runtime (loopback)
    +-- isolated official Harness WebView
    +-- Gateway sidecar
    +-- plugin failure quarantine/recovery

Mobile (Android/iOS)
  Tauri pairing UI
    +-- HTTPS/WSS --> HarnessDock Gateway --> desktop/server dsh
```

移动端不会内嵌桌面 Node Runtime；远程 Harness/Gateway 页面也不会获得本地 Tauri IPC 权限。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm check:versions
pnpm check:release
pnpm test
cd apps/tauri && cargo check
```

正式发布以 `.github/workflows/tauri-candidate.yml` 为唯一候选构建：它固定上游 commit、生成四个平台 Runtime、执行真实 smoke、构建五个桌面资产与移动端候选，并验证品牌图标。`release.yml` 只接受当前 main 同一 SHA 的 candidate + CI 全绿结果，发布完整资产和 `SHA256SUMS`。

Android 候选使用 release profile（`opt-level=z`、Thin LTO、去符号、单 codegen unit、`panic=abort`），并在上传前检查 APK/AAB 包体和最大 native `.so`。

## 签名状态

公开 CI 包仍需外部平台证书才能获得 Windows Authenticode、Apple Developer ID/notarization、Google Play production signing 或 App Store/TestFlight provisioning。GitHub Release 提供 SHA-256 校验值；Tauri 自动更新只有在构建配置了更新公钥且 Release 同步发布有效签名清单时才会执行。

## License

MIT。DeepSeek Harness 与其他第三方依赖遵循各自许可证和商标规则。
