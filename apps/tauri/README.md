# HarnessDock Tauri v0.1.5-rc.2

`apps/tauri` 是 HarnessDock 唯一桌面应用宿主。正常桌面启动由 Rust Native Host 拉起安装包内置的 Full Runtime，Runtime ready 后直接打开官方 Harness Web；本地控制页只在启动恢复、Gateway 或显式诊断时出现。

当前 Runtime 精确锁定 `dsh-v0.1.5-rc.2`，commit `fb2c4b9e698e30edb738bca4cf0618587db7d203`。HarnessDock 客户端基础版本保持 `0.1.5`，当前候选标签为 `v0.1.5-rc.2`。

## Runtime 模型

- Windows / macOS / Linux：sealed local Full Runtime + Remote Gateway。
- Android / iOS：Remote Gateway only；移动设备不启动 Node/dsh。
- 桌面包只执行安装包内置 portable Node，不信任系统 PATH，不在首启下载替代 Runtime。
- pinned pnpm Runtime Tool 用于保留 dsh 插件安装能力，不要求用户预装系统 pnpm。
- Normal / Direct 使用用户配置的 profile/DSH_HOME；第三方插件异常进入有界 quarantine/recovery。
- Safe / Rescue Web 固定官方 `web` profile，并从进程启动起使用 generation-private `DSH_HOME`；用户 patch 只做无副作用诊断读取，Rescue 不 compose/heal 用户 profile。
- Normal/Quarantine 如果明确命中 upstream `atomic-write` / `profiles/node_modules.lock` writer-lock 竞争，直接切 private Rescue；客户端不盲删可能仍被其它 dsh writer 持有的用户 lock。

## 启动链路

```text
Tauri setup
  -> startup coordinator
  -> sealed packaged Runtime
  -> RuntimeActor generation
  -> RuntimeLease
  -> validate loopback URL
  -> Harness WebView
  -> Harness Web visible
  -> optional Harness Shell
```

Harness Web 首次加载有 watchdog；Runtime 或导航失败进入有界 Recovery，而不是显示空白窗口或直接退出。Tray、Updater、Native Menu、Harness Shell 属于可选组件，初始化失败必须 fail-open。

Safe / Rescue 路径的关键约束：

```text
Normal user DSH_HOME
  -> normal startup / optional quarantine
  -> writer-lock or unrecoverable startup failure
  -> stop/reap failed attempt
  -> generation-private <work-dir>/rescue-dsh-home
  -> official web + embedded/compat/shell integration
  -> RuntimeLease
  -> Harness Web
```

Private Rescue home 随 owning Runtime work-dir 一起清理，不持久化替换用户配置。

## Harness Shell

主 WebView 注入独立 `@dsh/plugin-harness-shell`，提供：

- 菜单；
- 最小化；
- 最大化 / 还原；
- 关闭；
- 刷新 Web；
- 重启 Runtime；
- Rescue Web 隔离启动；
- 恢复全部插件并正常重启；
- Gateway；
- 插件诊断。

远程 Harness 文档只获得最小 Host Protocol capability，不直接持有本地高权限 Tauri API。Shell 注入失败时恢复原生窗口 decorations，保证 Harness Web 仍可操作。

## Runtime 与进程生命周期

- Runtime generation/lease 防止旧进程或旧 WebView 在重启后重新接管当前状态。
- `RuntimeActor.begin_start()` 拒绝重叠的生命周期启动；Runtime restart 保持严格 stop-before-start。
- Refresh/Restart 等 Surface 操作有互斥控制，减少重复命令竞争。
- Windows 受管后台进程进入 `KILL_ON_JOB_CLOSE` Job Object；关闭资源所有者时清理子进程树。
- Unix 后台进程使用独立 process group，并采用 TERM -> KILL 的有界退出流程。
- 应用退出期间先关闭新进程 admission，再清理 starting/managed process tree。
- `RuntimeProcess::stop()/Drop` 清理其 work-dir，因此 private `rescue-dsh-home` 不会遗留成为下一 generation 的隐式状态。

## WebView 安全边界

桌面 Harness WebView 只允许当前 RuntimeLease 的：

```text
http://127.0.0.1:<managed-port>
```

Runtime generation、随机 nonce、imageIdentity、受管 PID、origin、navigation 都必须匹配。导航到非受管 origin 会被阻止并进入 Recovery。

## 构建

```bash
cd apps/tauri
cargo tauri icon src-tauri/icons/app-icon.png
cargo tauri build --bundles nsis         # Windows
cargo tauri build --bundles deb,appimage # Linux
cargo tauri build --bundles dmg          # macOS
```

移动端初始化：

```bash
cargo tauri android init --ci
cargo tauri icon src-tauri/icons/app-icon.png
cargo tauri android build --apk --aab --target aarch64 --ci

cargo tauri ios init --ci
cargo tauri icon src-tauri/icons/app-icon.png
cargo tauri ios build --debug --target aarch64-sim --ci
```

## 品牌与 Windows 安装包

`src-tauri/icons/app-icon.png` 是 canonical icon。候选构建会重新生成各平台图标；Windows NSIS 明确使用 `icons/icon.ico`，并在安装包生成后读取最终 PE 资源校验品牌图标。该验证已经有回归测试，防止再次出现 verifier 无参数调用导致的发布后置失败。

Windows 使用稳定 identifier `com.harnessdock.client`、current-user 安装、禁止意外降级，并内置 WebView2 bootstrapper。

## v0.1.5-rc.2 发布状态

当前候选是**未签名发布候选构建**：

- Windows：未做 Authenticode；
- macOS：未签名、未 notarize；
- Android：release-optimized，但不代表正式商店签名；
- iOS：Simulator only；
- 当前不生成 Tauri `latest.json/.sig` updater 资产。

因此 `v0.1.5-rc.2` 的版本检查最终引导到 GitHub Release 手动下载安装，并使用 `SHA256SUMS` 校验。签名自动更新属于后续发布通道，不应在当前 UI/文档中声明为已经启用。

## 发布门禁

在发布候选 `v0.1.5-rc.2` 前必须通过：

```bash
pnpm check:versions
pnpm check:release
pnpm check:embedded-runtime
pnpm test
pnpm tauri:check
```

并要求：

- PR exact head 的 `ci`、`tauri-ci`、`local-one-click-build` 全绿；
- Windows one-click 对同一个 NSIS artifact 先证明正常安装启动，再人为占用用户 `profiles/node_modules.lock`，证明 private Rescue 仍到达 cookie-authenticated Harness Web，最后正常退出且安装目录进程归零；
- macOS/Linux POSIX one-click clean checks 全绿；
- merge 后同一个 `main` SHA 的 `tauri-candidate` 生成全部平台 candidate 与 sealed Runtime bundles；
- Windows packaged-startup 对 exact candidate SHA 再跑正常 + writer-lock Rescue 双场景；
- `.github/workflows/release.yml` 只在 required same-SHA workflows 全绿后组装资产、复核 Runtime identity、生成并验证 `SHA256SUMS`，然后发布 GitHub prerelease。

Release 不接受跨 SHA 复用旧 candidate；稳定 `v0.1.5` 不移动、不覆盖，`v0.1.5-rc.2` 仅按 `release-manifest.json` 的 guarded replaceable-prerelease 合同重建。
