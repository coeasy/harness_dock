# HarnessDock Electron + Perry 双 Host 多安装包过渡方案

> 状态：架构与发布方案评审稿（仅文档，不修改代码）  
> 日期：2026-08-30  
> 适用仓库：`coeasy/harness_dock`  
> 关联方案：`docs/perry-client-feasibility-and-roadmap.md`  
> 目标：在不破坏现有 Electron 稳定客户端的前提下，同时构建、安装、发布和维护 Electron 与 Perry 两套桌面 Host，并通过可量化门禁逐步迁移。

---

## 1. 结论

**可以，并且建议正式支持 Electron 与 Perry 两套客户端安装包并行构建。**

但不建议把它实现成两份相互独立、重复维护的桌面应用。正确目标应是：

```text
HarnessDock = Shared Core + Shared Runtime + Multiple Desktop Hosts
```

其中：

```text
Electron Host = Stable / Compatibility / LTS
Perry Host    = Native / Lightweight / Preview
```

过渡期不预设 Perry 一定会完全替代 Electron。最终允许出现三种结果：

1. Perry 全面达到门禁，升级为默认 Stable，Electron 降为 Compatibility/LTS；
2. Perry 仅部分平台达到门禁，按平台分别选择默认 Host；
3. Perry 长期保持 Lite/Native 版本，Electron 继续作为完整兼容版本。

这比“一次性替换 Electron”风险低得多，也更符合 HarnessDock 当前已经形成的发布体系。

---

## 2. 为什么双 Host 是当前最佳方案

HarnessDock 当前 Electron 客户端已经具备：

- Windows / macOS / Linux 构建；
- thin / full 双场景；
- Windows Setup / Portable / zip；
- macOS dmg / zip；
- Linux AppImage / deb；
- `dsh` 精确版本钉定；
- runtime cache；
- bundled runtime；
- integrity 校验；
- last-known-good rollback；
- tray；
- diagnostics；
- auto-update；
- renderer crash recovery；
- release metadata。

现有 `release.yml` 已经按：

```text
OS × scenario × arch
```

生成构建矩阵，并且 full runtime 已经独立 prepare 后再进入打包流程。

因此最自然的扩展不是删除 Electron，而是在矩阵中增加一个新的维度：

```text
Host × OS × Arch × Scenario × Package Format × Channel
```

从：

```text
Electron × OS × thin/full
```

逐步演进成：

```text
Electron × OS × thin/full
Perry    × OS × thin/full
```

运行时仍共享同一个官方 `dsh` 版本和相同的 Harness Web UI。

---

## 3. 产品定位

建议过渡期形成两个明确产品通道。

| 产品 | Host | Channel | 定位 | 是否默认推荐 |
| --- | --- | --- | --- | --- |
| HarnessDock | Electron | Stable | 完整兼容、成熟更新、生产使用 | 是 |
| HarnessDock Native Preview | Perry | Preview | 轻量、低内存、原生 Host 验证 | 否 |

后续达到门禁后再演进成：

| 产品 | Host | Channel | 定位 |
| --- | --- | --- | --- |
| HarnessDock | Perry | Stable | 默认轻量原生客户端 |
| HarnessDock Compatibility | Electron | LTS | 高兼容回退客户端 |

注意：这只是可能的终态，不是当前必须实现的结果。

---

## 4. 核心原则

### 4.1 不 fork DeepSeek Harness

两套 Host 都继续加载：

```text
http://127.0.0.1:<random-port>
```

上的官方 `dsh web` UI。

不把 Harness SPA 重新编译成 Perry Native UI，也不重写 React 页面。

### 4.2 不用 Perry AOT 重编译 `dsh` runtime

Perry 只编译 HarnessDock Host。

```text
Electron/Perry Host
        │
        └── HarnessDock Runtime Supervisor
                    │
                    └── Node + official @deepseek-ai/dsh
```

原因是 `dsh` runtime 的 Node/npm/PTY/WASM/原生依赖兼容面远高于一个桌面 Shell。Perry 当前仍存在部分 Node parity、PTY、WASM、GC/runtime 等公开跟踪项，因此第一阶段不把这些风险叠加到 dsh 本体。

### 4.3 Shared Core，Host Adapter

业务逻辑不复制两套。

只允许 Host-specific 代码处理：

- window；
- tray；
- notification；
- native dialog；
- update install；
- WebView；
- native lifecycle；
- system integration。

### 4.4 Electron 永远是过渡期回退路径

Perry 在任一平台出现 P0 blocker 时，不阻塞 Stable Release。

---

## 5. 推荐仓库结构

过渡期不建议立即重命名现有 `apps/desktop`，以免破坏已有打包和 release 脚本。

推荐：

```text
apps/
├─ desktop/                    # 现有 Electron Stable，暂不改路径
├─ perry/                      # 新增 Perry Native Preview
└─ vscode/                     # 保持不变

packages/
├─ bootstrap/                  # 继续共享
├─ client-runtime/             # 继续共享
├─ docs-sync/                  # 继续共享
├─ plugin-embedded-client/     # 继续共享
├─ desktop-contract/           # 新增：Host capability contract
├─ desktop-core/               # 新增：Host-neutral orchestration
├─ update-manifest/            # 后续：统一 release/update manifest
└─ runtime-broker/             # 后续可选：跨 Host runtime broker
```

不要第一步就把：

```text
apps/desktop -> apps/electron
```

因为这会同时修改：

- package scripts；
- electron-builder config；
- workflow path；
- release artifact path；
- size checks；
- tests；
- updater metadata。

等 Perry 路线稳定后再做目录命名清理。

---

## 6. Host Contract 设计

目标是把现有 Electron API 依赖收敛成有限接口，而不是让共享模块直接 import `electron` 或 `perry/ui`。

建议抽象：

```ts
interface DesktopHost {
  lifecycle: LifecycleService
  windows: WindowService
  webview: WebViewService
  tray: TrayService
  notifications: NotificationService
  dialogs: DialogService
  externalLinks: ExternalLinkService
  downloads: DownloadService
  diagnostics: DiagnosticsService
  updates: UpdateService
  paths: HostPathService
  instance: InstanceService
}
```

### 6.1 Shared Core 可负责

- dsh version resolve；
- runtime cache resolve；
- runtime prepare；
- integrity；
- runtime spawn / stop；
- ready wait；
- health check；
- rollback；
- runtime version selector；
- diagnostics data model；
- release manifest parse；
- update policy；
- state machine。

### 6.2 Electron Adapter 负责

- `BrowserWindow`；
- `ipcMain` / `ipcRenderer`；
- `shell.openExternal`；
- Electron session downloads；
- electron-updater；
- nativeImage；
- Electron tray；
- Notification；
- Electron app lifecycle。

### 6.3 Perry Adapter 负责

- Perry native App / Window；
- Perry WebView；
- native menu/tray；
- file dialog；
- notification；
- openURL；
- Perry-specific updater adapter；
- native lifecycle。

---

## 7. WebView 边界必须重新定义

Perry 官方当前将 Native WebView 明确定位成较窄的 embedded browser primitive，并明确说明它不是 Electron/Tauri 风格完整 App Shell；native target 也没有通用双向 `postMessage` RPC。

因此 Perry 版本必须主动减少：

```text
Web UI -> Native Host RPC
```

而保持：

```text
Harness Web UI <---- HTTP / WebSocket ----> dsh web
```

Host 与页面之间尽量不通信。

Perry Host 自己的：

- titlebar；
- diagnostics；
- runtime selector；
- update UI；
- crash UI；
- restart runtime；

应放在 WebView 外部的 Native UI，而不是注入官方 Harness DOM。

---

## 8. 双客户端可以同时安装，但不建议第一阶段同时运行

这是双 Host 方案中最重要的运行时边界。

Electron 与 Perry 可以分别安装：

```text
HarnessDock
HarnessDock Native Preview
```

但是两者不能在没有协调机制时同时：

```text
spawn dsh web
+ 写相同 runtime cache
+ 操作相同 ~/.dsh 数据
```

否则会产生：

- runtime 生命周期竞争；
- cache 写冲突；
- stop/kill 误杀；
- 两个 localhost server；
- 数据目录并发未知风险；
- 更新/回滚状态不一致。

### 8.1 过渡阶段推荐：Global Runtime Lease

第一阶段使用跨 Host 全局租约：

```text
~/.harnessdock/locks/runtime.lock
~/.harnessdock/runtime/active.json
```

示例：

```json
{
  "host": "electron",
  "hostPid": 1234,
  "runtimePid": 5678,
  "dshVersion": "x.y.z",
  "startedAt": "..."
}
```

启动规则：

```text
Host A 启动
  -> 获取全局 runtime lease
  -> 启动 dsh

Host B 启动
  -> 检测 lease
  -> 校验 PID + health
  -> 不重复启动 runtime
  -> 提示当前已有 HarnessDock Host 正在使用 runtime
```

**最初版本宁可禁止 Electron/Perry 同时运行，也不要冒数据一致性风险。**

### 8.2 后续阶段：Runtime Broker

当双 Host 功能稳定后，可以增加独立 Runtime Broker：

```text
Electron ─┐
          ├─ IPC ─> HarnessDock Runtime Broker ─> dsh web
Perry ────┘
```

Broker 独立拥有：

- dsh child process；
- runtime cache；
- ready state；
- version；
- rollback；
- health；
- shutdown policy。

Host 只 attach。

建议本地控制通道使用：

```text
Windows: Named Pipe
macOS/Linux: Unix Domain Socket
```

不要暴露无认证的公网 TCP 控制端口。

Broker 是否允许两套 UI 同时连接同一个 dsh runtime，必须单独进行官方 Harness 多客户端并发测试后再开启。

---

## 9. 数据目录策略

### 9.1 必须共享

官方数据：

```text
~/.dsh/
```

Electron 和 Perry 都应继续使用同一份官方数据，避免形成两套账户、Provider、Workspace、Session 数据。

### 9.2 必须隔离

Host 自身数据必须隔离：

```text
Electron Host Data
Perry Host Data
```

包括：

- window state；
- WebView storage；
- updater state；
- Host log；
- crash state；
- local preferences；
- native cache。

建议逻辑命名：

```text
HarnessDock/Electron
HarnessDock/PerryPreview
```

### 9.3 runtime cache 第一阶段隔离

初期建议：

```text
Electron runtime-cache
Perry runtime-cache
```

虽然会暂时增加磁盘占用，但实现最简单、风险最低。

### 9.4 runtime cache 第二阶段共享

确认 cache contract 稳定后迁移到：

```text
~/.harnessdock/runtime-cache/<version>/<platform>/<arch>/
```

要求：

- content-addressed；
- SHA 校验；
- temp download；
- atomic rename；
- per-version file lock；
- never mutate completed version；
- GC 不删除 active runtime。

---

## 10. App ID / Bundle ID 必须分开

当前 Electron 使用既有应用身份，过渡期不要轻易修改，否则可能破坏：

- Windows taskbar identity；
- updater；
- install location；
- shortcuts；
- userData；
- macOS bundle update；
- existing users。

因此建议：

```text
Electron Stable:
  保持当前 identity，例如 com.dsh.client

Perry Preview:
  com.dsh.client.perry.preview
```

产品显示名：

```text
HarnessDock
HarnessDock Native Preview
```

快捷方式也必须不同。

未来 Perry 成为 Stable 后，再单独设计 App Identity Migration，不要在 Preview 阶段抢占 Electron 的稳定 ID。

---

## 11. 版本模型

不要让 Perry Preview 的快速迭代强迫 Electron Stable 同步频繁升级。

推荐两层版本：

```text
Core Version
Host Release Revision
```

例如：

```text
Shared Core / origin: 0.2.0
Electron Stable:      0.2.0
Perry Preview:        0.2.0-perry.1
Perry Preview Fix:    0.2.0-perry.2
```

两者可以钉同一个：

```text
origin.json -> same dsh version
```

但 Host release cadence 可以独立。

---

## 12. Release Channel 建议

### Stable

```text
host = electron
channel = stable
```

继续沿用当前 update feed 与现有用户升级链路。

### Perry Preview

```text
host = perry
channel = preview
```

单独 feed。

不要让 Perry Preview 写入现有：

```text
latest.yml
latest-mac.yml
latest-linux.yml
```

否则可能被 Electron Stable 客户端识别。

建议 Perry 使用自己的 manifest：

```text
latest-perry-win-x64.json
latest-perry-mac-arm64.json
latest-perry-mac-x64.json
latest-perry-linux-x64.json
```

以后再统一为一个跨 Host manifest。

---

## 13. Unified Release Manifest

长期建议增加一个 Host-neutral manifest：

```json
{
  "productVersion": "0.2.0",
  "dshVersion": "x.y.z",
  "artifacts": [
    {
      "host": "electron",
      "channel": "stable",
      "os": "win",
      "arch": "x64",
      "scenario": "thin",
      "format": "setup-exe",
      "file": "HarnessDock-Setup-0.2.0-win-x64-thin.exe",
      "sha256": "...",
      "size": 0
    },
    {
      "host": "perry",
      "channel": "preview",
      "os": "win",
      "arch": "x64",
      "scenario": "thin",
      "format": "portable-exe",
      "file": "HarnessDock-Perry-Preview-0.2.0-perry.1-win-x64-thin.exe",
      "sha256": "...",
      "size": 0
    }
  ]
}
```

它可以同时驱动：

- GitHub release asset validation；
- 官网下载页；
- checksum；
- host compatibility matrix；
- updater feed generation；
- release notes；
- smoke tests。

---

## 14. 安装包命名策略

### 14.1 Electron 过渡期保持现有命名

为了 updater 兼容，建议暂时继续：

```text
HarnessDock-Setup-<version>-win-x64-thin.exe
HarnessDock-Portable-<version>-win-x64-thin.exe
HarnessDock-<version>-mac-arm64-thin.dmg
...
```

不要仅为了“命名漂亮”破坏现有更新链路。

### 14.2 Perry 全部显式带 Host

```text
HarnessDock-Perry-Preview-<version>-win-x64-thin.exe
HarnessDock-Perry-Preview-<version>-win-x64-full.exe
HarnessDock-Perry-Preview-<version>-mac-arm64-thin.dmg
HarnessDock-Perry-Preview-<version>-linux-x64-thin.AppImage
```

### 14.3 Perry 升 Stable 后

届时再决定：

- Perry 接管通用 `HarnessDock-*` 名称；
- Electron 改成 `HarnessDock-Electron-LTS-*`；
- 或者长期保持两个显式 Host 名称。

---

## 15. Electron 安装包矩阵

保持现状作为 Stable 基线。

### Windows x64

| Scenario | Format |
| --- | --- |
| thin | NSIS Setup EXE |
| thin | Portable EXE |
| thin | ZIP |
| full | NSIS Setup EXE |
| full | Portable EXE |
| full | ZIP |

### macOS x64 / arm64

| Scenario | Format |
| --- | --- |
| thin | DMG |
| thin | ZIP |
| full | DMG |
| full | ZIP |

### Linux x64

| Scenario | Format |
| --- | --- |
| thin | AppImage |
| thin | DEB |
| full | AppImage |
| full | DEB |

这套矩阵继续作为功能与发布的 Reference Implementation。

---

## 16. Perry 安装包矩阵：不要第一天就构建全部格式

Perry 需要分层进入发布体系。

### Stage P0：Compiler / WebView Spike

不发布正式安装包。

输出：

```text
native executable
```

只验证：

- compile；
- launch；
- spawn runtime；
- load Harness URL；
- quit；
- logs。

### Stage P1：Developer Preview

优先发布最简单、最透明的包。

#### Windows x64

```text
Portable EXE
ZIP
```

#### macOS x64 / arm64

```text
.app ZIP
```

#### Linux x64

```text
binary tar.gz
```

此阶段不急于提供复杂 installer/updater。

### Stage P2：Public Preview

P0 功能通过后增加：

#### Windows

```text
Setup EXE
Portable EXE
ZIP
```

#### macOS

```text
DMG
ZIP
```

#### Linux

```text
AppImage
DEB
```

### Stage P3：Full Runtime

thin 稳定之后再增加 Perry full。

这样可以区分：

```text
Perry Host 问题
```

和：

```text
Perry full runtime packaging 问题
```

避免同时调试两类问题。

---

## 17. Perry 平台优先级

Perry 当前官方 TypeScript API 对 WebView 的描述仍表明各平台成熟度并不完全等价。

建议 PoC 顺序：

```text
1. macOS arm64
2. Windows x64
3. macOS x64
4. Linux x64
```

原因：

- macOS WKWebView 路径最适合作为 WebView 行为基线；
- Windows 是 HarnessDock 用户关键平台，但必须实测 Perry WebView2 路径；
- Linux WebKitGTK 的发行版依赖、版本差异更大；
- 先验证功能，再扩大平台矩阵。

注意：Perry compiler 包目前提供 Windows x64、macOS x64/arm64、Linux x64/arm64 等构建，但这不等于 HarnessDock Perry WebView 在所有这些平台都已经达到生产级兼容。

---

## 18. thin / full 设计在两个 Host 中保持一致

### Thin

```text
Host package
+ shared bootstrap logic
+ no bundled dsh runtime
```

首启 resolve/fetch 精确版本 runtime。

### Full

```text
Host package
+ shared bootstrap logic
+ bundled Node
+ bundled official dsh runtime
```

两套 Host 的区别只应是 Shell，不应形成两套不同 runtime 规则。

### 强制 invariant

同一个产品版本：

```text
Electron thin
Electron full
Perry thin
Perry full
```

必须解析到同一个：

```text
origin.json.dshVersion
```

否则无法做 parity comparison。

---

## 19. Full Runtime 只 prepare 一次

当前 release workflow 已经把 runtime preparation 与 desktop build 分开。

扩展为双 Host 后不要让：

```text
Electron full prepare runtime
Perry full prepare runtime
```

分别重复下载几百 MB。

正确方式：

```text
prepare-runtime(os, arch, dshVersion)
                 │
                 ├── Electron full package
                 └── Perry full package
```

Cache key 只应和：

- dsh version；
- platform；
- arch；
- runtime preparation implementation；

有关，不应包含 Host。

---

## 20. CI Matrix 目标设计

建议未来 release plan 生成：

```json
{
  "host": "electron|perry",
  "runner": "...",
  "os": "win|mac|linux",
  "arch": "x64|arm64",
  "scenario": "thin|full",
  "channel": "stable|preview",
  "package": "..."
}
```

但不要真的把所有 package format 都变成独立 job，否则 workflow 会爆炸。

推荐：

```text
Job dimension:
Host × OS × Arch × Scenario
```

然后一个 job 内产出该组合所有 package formats。

---

## 21. Workflow 分层

建议最终形成：

```text
plan
  │
  ├── test-shared-core
  ├── test-electron-host
  ├── test-perry-host
  │
prepare-runtime
  │
  ├── build-electron
  └── build-perry
         │
         ├── parity-smoke
         └── webview-e2e
  │
assemble-release-manifest
  │
publish-stable
publish-preview
```

过渡初期可以继续使用单 workflow，但逻辑上必须分开 stable 和 preview gate。

---

## 22. CI Gate 等级

### Gate A：Shared Core

两个 Host 都必须通过：

- unit tests；
- origin version contract；
- runtime resolve；
- runtime integrity；
- bootstrap state machine；
- rollback；
- diagnostics model。

### Gate B：Electron Stable

必须 green 才允许 Stable Release。

Perry 失败不能影响 Electron Stable 发布。

### Gate C：Perry Compile

必须：

- compiler pin 可用；
- compile green；
- executable 可启动；
- no crash at boot。

### Gate D：Perry Runtime

必须：

- spawn dsh；
- ready file/health success；
- clean shutdown；
- no orphan process。

### Gate E：Perry WebView

必须：

- localhost page load；
- SPA hydration；
- WebSocket；
- streaming；
- storage；
- clipboard；
- keyboard；
- IME；
- file upload；
- file download/export；
- external links。

### Gate F：Perry Packaging

必须：

- install；
- uninstall；
- side-by-side with Electron；
- no shared App ID；
- shortcuts independent；
- host data independent；
- shared `~/.dsh` works；
- signing/notarization。

### Gate G：Perry Update

必须：

- independent update feed；
- upgrade same Host；
- failed update recovery；
- no Electron feed contamination。

---

## 23. Harness 功能 Parity Matrix

以下属于 Perry 升 Public Preview 前的 P0。

| 功能 | Electron | Perry 目标 |
| --- | --- | --- |
| 启动 dsh web | 已有 | 必须 |
| 官方 SPA 加载 | 已有 | 必须 |
| Provider 配置 | 已有 | 必须 |
| Workspace | 已有 | 必须 |
| Session | 已有 | 必须 |
| Streaming | 已有 | 必须 |
| WebSocket reconnect | 已有 | 必须 |
| Approval | 已有 | 必须 |
| Plugin UI | 已有 | 必须 |
| MCP/Skill UI | 上游能力 | 必须不破坏 |
| 文件上传 | 已有 | 必须 |
| 文件选择器 | 已有 | 必须 |
| 下载 | 已有 | 必须 |
| Export / blob download | 已有 | 必须 |
| Clipboard | 已有 | 必须 |
| Open external URL | 已有 | 必须 |
| 中文 IME | 已有 | 必须 |
| 快捷键 | 已有 | 必须 |
| localStorage | 已有 | 必须 |
| IndexedDB | 已有 | 必须 |
| Cookie/session | 已有 | 必须 |
| Theme | 已有 | 必须 |

任何 P0 功能失败，Perry 都只能保持 Experimental，不进入 Public Preview。

---

## 24. Perry WebView 最大风险：download / file picker / popup

这些能力不能只做静态 API 检查。

必须设计真实 E2E：

```text
Harness UI
  -> upload local file
  -> dsh receives file

Harness UI
  -> export
  -> native/system download succeeds
  -> file contents verified

Harness UI
  -> external OAuth/link
  -> native browser opens

Harness UI
  -> popup/window.open
  -> policy correct
```

如果 Perry WebView 没有可靠实现：

```text
download delegate / file chooser / popup policy
```

不能用“用户手工复制链接”作为 Stable workaround。

---

## 25. 自动更新架构

### Electron

继续：

```text
electron-updater
+ existing latest*.yml
+ blockmap
```

### Perry

第一阶段：

```text
manual update check
-> open release/download page
```

第二阶段再做：

```text
PerryUpdateAdapter
-> fetch signed manifest
-> verify hash/signature
-> download
-> stage
-> restart/install
-> rollback on failure
```

不要为了追求首版 feature parity，在 Perry WebView 还没有稳定前优先开发复杂 updater。

---

## 26. 签名策略

双 Host 必须分别签名。

### Windows

- Electron Stable：保持现有签名策略；
- Perry Preview：独立 binary/package signing；
- ProductName 不冲突；
- AppUserModelId 不冲突。

### macOS

- Electron：现有 bundle id；
- Perry Preview：独立 bundle id；
- Hardened Runtime；
- codesign；
- notarization；
- stapling。

### Linux

- checksum；
- release signature；
- deb metadata 唯一 package name。

---

## 27. 包名建议

### Windows package/product

```text
HarnessDock
HarnessDock Native Preview
```

### macOS bundle

```text
HarnessDock.app
HarnessDock Native Preview.app
```

### Linux package

```text
harnessdock
harnessdock-perry-preview
```

这样可以 side-by-side 安装，也能独立卸载。

---

## 28. 用户下载页设计

过渡期不要直接把几十个 Assets 平铺给普通用户。

推荐下载页先让用户选：

```text
Recommended
  HarnessDock Stable (Electron)

Try the new lightweight client
  HarnessDock Native Preview (Perry)
```

再选：

```text
OS
Architecture
Thin / Full
Installer / Portable
```

Stable 默认 Electron。

只有 Perry 达到对应平台 Stable Gate 后，才改变默认推荐。

---

## 29. Release Notes 必须明确 Host

每次版本发布建议增加：

```text
## Electron Stable
- supported platforms
- package formats
- known issues

## Perry Native Preview
- supported platforms
- parity status
- known limitations
- fallback instructions
```

Perry Preview 必须明确：

```text
Preview software; keep Electron Stable installed as fallback.
```

直到它真正达到 Stable 门禁。

---

## 30. 性能指标不要只看 EXE 大小

Perry 的价值需要用相同 dsh runtime 做 A/B。

### 必测指标

- install package size；
- installed host size；
- cold host launch；
- dsh-ready time；
- Web UI ready time；
- idle host RSS；
- total RSS including WebView；
- CPU idle；
- WebSocket streaming latency；
- large session render；
- shutdown latency；
- update payload size。

### 推荐目标

不要第一阶段承诺固定 MB 数字，改用相对 Electron baseline：

```text
Perry thin package <= 40% Electron thin package
Perry host idle RSS <= 60% Electron host idle RSS
Perry host bootstrap latency <= 50% Electron host bootstrap latency
```

`dsh` runtime 的启动耗时必须单独统计，避免把 runtime 时间算成 Host 优劣。

---

## 31. 可观测性

两个 Host 输出统一 event schema：

```text
host.boot.start
runtime.resolve.start
runtime.resolve.done
runtime.spawn.start
runtime.ready
webview.load.start
webview.load.done
host.ready
host.shutdown
runtime.shutdown
```

事件增加：

```text
host=electron|perry
os
arch
scenario
hostVersion
dshVersion
```

这样才可以真正比较两个客户端。

不要求上传遥测；本地日志和 CI benchmark 即可建立第一阶段数据。

---

## 32. 诊断包格式统一

建议无论 Host 都导出：

```text
diagnostics.json
origin.json
runtime.json
host.json
boot.log
webview.json
update.json
```

其中：

```json
{
  "host": "perry",
  "hostVersion": "0.2.0-perry.1",
  "dshVersion": "...",
  "scenario": "thin",
  "platform": "win32",
  "arch": "x64"
}
```

方便用户反馈时快速判断是 Host 问题还是 dsh 问题。

---

## 33. 安全边界

### localhost origin

只允许加载当前 bootstrap 返回的：

```text
127.0.0.1
```

origin。

### navigation policy

非允许 origin：

```text
block in WebView
-> open external browser if policy permits
```

### Runtime Broker

如果未来加入 broker：

- Named Pipe / Unix socket；
- per-user permissions；
- handshake nonce；
- PID validation；
- no unauthenticated command TCP endpoint。

### Update

- TLS；
- SHA256/更强 digest；
- signature；
- host/channel binding；
- downgrade policy；
- atomic install。

---

## 34. Phase 0：只做架构准备

目标：不影响 Electron。

工作：

1. 定义 DesktopHost contract；
2. 列出当前 Electron-only API；
3. 定义 parity matrix；
4. 定义 Host ID；
5. 定义 release artifact schema；
6. 定义 runtime lease；
7. pin Perry compiler；
8. 建立 Perry known-issues baseline。

完成标准：

```text
Electron behavior = unchanged
```

---

## 35. Phase 1：Perry macOS Spike

只实现：

```text
compile
launch
spawn dsh
wait ready
WebView load
quit
```

不做：

- auto update；
- tray；
- full package；
- diagnostics UI；
- fancy native chrome。

目的只有一个：

**证明官方 Harness Web UI 在 Perry WebView 中可运行。**

---

## 36. Phase 2：Perry 三平台 Developer Preview

扩大到：

- macOS arm64；
- Windows x64；
- macOS x64；
- Linux x64。

增加：

- native window；
- external links；
- file dialogs；
- logs；
- runtime lease；
- thin package；
- parity E2E。

Electron 不变。

---

## 37. Phase 3：Side-by-side Public Preview

实现独立：

- App ID；
- install location；
- shortcut；
- host data；
- Preview updater/manual update；
- release assets；
- release notes。

用户可以同时安装：

```text
HarnessDock
HarnessDock Native Preview
```

但通过 runtime lease 避免同时运行两个 unmanaged runtime。

---

## 38. Phase 4：Perry Full + Update + Diagnostics

增加：

- full package；
- shared prepared runtime；
- diagnostics；
- tray；
- notifications；
- runtime version management；
- update adapter；
- update rollback。

到这里 Perry 才接近真正桌面客户端 parity。

---

## 39. Phase 5：Platform-by-platform Beta

不要强制三平台同时升级。

允许：

```text
Windows: Perry Beta
macOS: Perry Preview
Linux: Electron Stable only
```

或者任何实际测试结果对应的组合。

平台独立 Gate 能显著降低迁移风险。

---

## 40. Phase 6：Default Host Candidate

某个平台必须满足：

- P0 功能 100%；
- 关键 P1 host 功能 100%；
- update 可恢复；
- side-by-side clean；
- no data corruption；
- no orphan runtime；
- signing green；
- packaging green；
- 2~3 个 release cycle 无 blocker；
- 性能收益真实存在。

才允许把 Perry 标记为该平台 Default Candidate。

---

## 41. Phase 7：稳定迁移

如果 Perry 成为默认：

```text
HarnessDock -> Perry Stable
HarnessDock Compatibility -> Electron LTS
```

Electron 不应马上删除。

建议至少再维护多个发布周期作为：

- rollback；
- WebView compatibility fallback；
- enterprise fallback；
- older OS fallback。

---

## 42. Electron 退役条件

只有同时满足以下条件才讨论彻底移除：

1. Perry 三平台全部 Stable；
2. Harness 全 P0 功能完整；
3. updater 成熟；
4. download/upload/export 完整；
5. WebView security maintenance 明确；
6. 至少多个稳定版本无严重回归；
7. 没有用户依赖 Electron-only feature；
8. 构建/维护成本下降而不是上升。

只要任一条件不满足，Electron LTS 都有长期保留价值。

---

## 43. 推荐短期版本策略

### v0.1.x

```text
Electron only
Stable
```

保持当前公开版本稳定。

### v0.2.x

```text
Electron Stable
Perry Developer Preview / Preview
```

这是最合理的双 Host 过渡版本系列。

### v0.3.x

```text
Electron Stable
Perry Preview/Beta
```

Perry 开始具备 full/update/diagnostics。

### v0.4.x+

根据平台实测决定：

```text
Perry Stable Candidate
Electron Compatibility
```

不要现在就承诺具体哪个版本彻底切换。

---

## 44. 推荐构建命令目标

未来可设计为：

```text
pnpm pack:electron
pnpm pack:electron:full

pnpm pack:perry
pnpm pack:perry:full

pnpm pack:desktop --host electron --scenario thin
pnpm pack:desktop --host perry --scenario thin
```

以及统一入口：

```text
node scripts/build.mjs \
  --host electron|perry|all \
  --os win|mac|linux|current \
  --scenario thin|full|both
```

`--host all` 才构建双 Host。

不要让普通本地开发默认一次构建所有矩阵。

---

## 45. 推荐 Release target

未来 workflow_dispatch 可以扩展：

```text
all
stable
preview

electron
perry

electron-win
perry-win

electron-win-thin
perry-win-thin
...
```

但内部不要靠字符串 if 无限堆叠，建议 `plan` job 输出标准矩阵 JSON。

---

## 46. 构建缓存

### Electron

继续 cache：

- pnpm；
- electron-builder；
- runtime artifact。

### Perry

增加：

- Perry compiler；
- Perry native libs；
- platform toolchain；
- compiled host intermediates；
- runtime artifact。

### Shared

最重要的是：

```text
full dsh runtime cache
```

只按 version/os/arch prepare 一次。

---

## 47. PR / CI 策略

Perry 开发不要直接把稳定 Electron workflow 改成 required-all。

推荐：

### 第一阶段

```text
Electron CI = required
Perry CI = non-blocking experimental
```

### 第二阶段

```text
Electron CI = required
Perry compile/runtime = required
Perry WebView E2E = non-blocking
```

### Public Preview

```text
Perry target platform CI = required for Perry preview release
```

但仍不阻塞 Electron Stable release。

---

## 48. Known Issues Registry

建议新增机器可读：

```text
docs/perry-compatibility-matrix.yaml
```

字段：

```yaml
perryVersion: ...
platforms:
  windows-x64:
    webview: unknown
    download: unknown
    filePicker: unknown
    websocket: unknown
  macos-arm64:
    webview: pass
    download: pending
```

这比在 README 写“支持 Perry”更加可靠。

---

## 49. GO / HOLD / STOP 规则

### GO

Perry 继续升级阶段：

- Harness SPA 核心兼容；
- runtime 生命周期稳定；
- package size/RSS 有明显收益；
- 平台问题可修复。

### HOLD

保持 Preview：

- download/export/file picker 有缺口；
- update 不成熟；
- Linux WebView 差异明显；
- 特定平台 crash rate 不可接受。

### STOP

停止 Perry Stable 迁移但保留实验分支：

- 关键 WebView 能力长期无法实现；
- 需要大量 fork/patch 官方 Harness UI；
- Perry 维护成本超过 Electron；
- 原生 Host 并没有实际体积/内存收益；
- runtime/compiler 稳定性不足。

---

## 50. 最终推荐架构

```text
                         Official Harness Web UI
                                  │
                              HTTP / WS
                                  │
                          official dsh web
                                  │
                       HarnessDock Runtime Core
                                  │
              ┌───────────────────┴───────────────────┐
              │                                       │
       Electron Host Adapter                   Perry Host Adapter
              │                                       │
       HarnessDock Stable                 HarnessDock Native Preview
              │                                       │
       Electron packages                       Perry packages
```

后续可进一步演进：

```text
                         Runtime Broker
                         /            \
                  Electron            Perry
```

---

## 51. 推荐实施顺序

最优工程顺序：

1. **保持当前 Electron Stable 完全不变**；
2. 新增 Host Contract；
3. 新增最小 Perry app；
4. 先验证 macOS Harness WebView；
5. 再验证 Windows；
6. 再验证 Linux；
7. 建立 global runtime lease；
8. 发布 Perry thin Developer Preview；
9. 完成 WebView P0 parity；
10. 增加 side-by-side installer；
11. 增加 Perry full；
12. 增加 independent updater；
13. 统一 release manifest；
14. 建立 Runtime Broker（仅在确有必要时）；
15. 分平台升级 Perry Beta；
16. 经过多个版本后再决定默认 Host。

---

## 52. 当前建议的最终决策

**建议批准 Electron + Perry 双 Host、多安装包并行路线。**

当前不要做：

```text
删除 Electron
重写 Harness UI
用 Perry 编译 dsh runtime
两个 Host 无锁同时启动 dsh
共享 Electron/Perry Host userData
让 Perry Preview 复用 Electron update feed
```

当前应该做：

```text
Electron Stable
+ Perry Preview
+ Shared Runtime Contract
+ Host Adapter
+ Side-by-side Installation
+ Independent Update Channels
+ Global Runtime Lease
+ Platform Parity Gates
```

这套方案既保留 HarnessDock v0.1.0 已经形成的稳定工程资产，也为 Perry 的包体、内存、启动速度与原生 UI 优势保留充分演进空间。

**推荐把 v0.2.x 定义为正式的 Dual-Host Transition Series。**

在这个系列中：

```text
Electron = 默认 Stable
Perry    = Native Preview
```

只有当真实 Harness E2E、安装、更新、数据一致性和三平台 WebView 门禁持续通过后，再逐步调整默认 Host。
