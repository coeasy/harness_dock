# Tauri 更新链路验收

v0.2.0 的桌面更新只由 Tauri updater 负责，Electron updater、`app-update.yml`、`latest.yml` 和 blockmap 链路均不存在。

## 运行链路

1. 远程 Harness Shell 只请求 `diagnostics.open`；本地诊断面通过 Host Protocol v2 请求 `install-update`，Release 检查在 Rust 更新流程内部完成。
2. Rust 原生层访问当前稳定 GitHub Release，校验版本、平台和资产信息。
3. 只有配置 `HARNESSDOCK_UPDATER_PUBLIC_KEY` 且 Release 提供四个平台匹配的 `.sig` 与 `latest.json` 时，`app.update.install` 才允许下载。
4. Tauri updater 校验签名后安装，先执行受控 Runtime/Gateway 清理，再重启客户端。
5. 未配置签名材料、版本不匹配、平台资产缺失、网络错误或签名校验失败时，状态回到可操作界面，禁止安装未验证文件。

## 本地检查

```bash
pnpm check:versions
pnpm check:release
pnpm tauri:check
pnpm test
```

检查以下契约保持一致：

- `packages/bootstrap/src/shell-contract.ts` 中的更新命令；
- `packages/plugin-harness-shell` 中的更新菜单；
- `apps/tauri/src-tauri/src/harness_shell.rs` 的命令映射；
- `apps/tauri/src-tauri/src/update.rs` 的 GitHub、签名和重启逻辑；
- `apps/tauri/src-tauri/permissions/harnessdock.toml` 的最小权限；
- `release.yml` 的版本、资产和 `SHA256SUMS` 校验。
- `scripts/generate-tauri-updater-manifest.mjs` 的平台键、版本和签名映射。

## 发布前人工验收

在配置正式更新公钥和签名材料的环境中，至少验证：无更新、可更新、断网、错误签名、缺失 `latest.json`、平台资产不匹配、安装中退出、重启后 Runtime/Gateway 回收和数据目录保持不变。任何失败都必须停留在 Tauri 恢复界面，不得回退到旧 Electron 更新路径。
