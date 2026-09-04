# HarnessDock Tauri v0.1.2

`apps/tauri` 是 HarnessDock 唯一桌面应用宿主。正常桌面启动由 Rust Native Host 拉起安装包内置的 Full Runtime，Runtime ready 后直接打开官方 Harness Web；本地控制页只在启动恢复、Gateway 或显式诊断时出现。

当前 Runtime 精确锁定 `dsh-v0.1.2-rc.1`，commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。HarnessDock 产品版本使用上游 dsh 的基础 SemVer，因此本客户端版本为 `0.1.2`。

## Runtime 模型

- Windows / macOS / Linux：sealed local Full Runtime + Remote Gateway。
- Android / iOS：Remote Gateway only；移动设备不启动 Node/dsh。
- 桌面包只执行安装包内置 portable Node，不信任系统 PATH，不在首启下载替代 Runtime。
- pinned pnpm Runtime Tool 用于保留 dsh 插件安装能力，不要求用户预装系统 pnpm。
- 第三方插件异常进入有界隔离/恢复；必要时可使用临时 clean profile 打开 Web，而不修改用户真实配置。

## 启动链路

```text
Tauri setup
  -> startup coordinator
  -> ensure packaged Runtime
  -> RuntimeActor generation
  -> RuntimeLease
  -> validate loopback URL
  -> Harness WebView
  -> Harness Web visible
  -> optional Harness Shell
```

Harness Web 首次加载有 watchdog；Runtime 或导航失败进入 Recovery，而不是显示空白窗口或直接退出。Tray、Updater、Native Menu、Harness Shell 属于可选组件，初始化失败必须 fail-open。

## Harness Shell

主 WebView 注入独立 `@dsh/plugin-harness-shell`，提供：

- 菜单；
- 最小化；
- 最大化 / 还原；
- 关闭；
- 刷新 Web；
- 重启 Runtime；
- 隔离插件启动；
- Gateway；
- 插件诊断。

远程 Harness 文档只获得最小 Host Protocol capability，不直接持有本地高权限 Tauri API。Shell 注入失败时恢复原生窗口 decorations，保证 Harness Web 仍可操作。

## Runtime 与进程生命周期

- Runtime generation/lease 防止旧进程或旧 WebView 在重启后重新接管当前状态。
- Refresh/Restart 等 Surface 操作有互斥控制，减少重复命令竞争。
- Windows 受管后台进程进入 Job Object；关闭资源所有者时清理子进程树。
- Unix 后台进程使用独立 process group，并采用 TERM -> KILL 的有界退出流程。
- 应用退出期间拒绝创建新的受管后台进程。

## WebView 安全边界

桌面 Harness WebView 只允许当前 RuntimeLease 的：

```text
http://127.0.0.1:<managed-port>
```

Runtime generation、origin、navigation 都必须匹配。导航到非受管 origin 会被阻止并进入 Recovery。

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

## v0.1.2 beta 发布状态

当前公共 beta 是**测试候选**：

- Windows：未做 Authenticode；
- macOS：未签名、未 notarize；
- Android：release-optimized，但不代表正式商店签名；
- iOS：Simulator only；
- 当前不生成 Tauri `latest.json/.sig` updater 资产。

因此 v0.1.2 beta 的版本检查最终引导到 GitHub Release 手动下载安装，并使用 `SHA256SUMS` 校验。正式签名自动更新属于后续发布通道，不应在当前 UI/文档中声明为已经启用。

## 发布门禁

在发布 `v0.1.2-beta.2` 前必须通过：

```bash
pnpm check:versions
pnpm check:release
pnpm check:embedded-runtime
pnpm test
pnpm tauri:check
```

并要求同一个 `main` SHA 上的 `ci` 与 `tauri-candidate` 全绿。Release 不接受跨 SHA 复用旧 candidate。
