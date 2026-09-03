# deepseek-harness-desktop 安装包体积与核心机制分析

> 日期：2026-09-03  
> 参考仓库：`dsh-tauri-desk/deepseek-harness-desktop`  
> 用途：仅提取可验证的工程机制和产品经验，不复制其目录、状态模型、IPC 结构或产品 UI。  
> HarnessDock 的最终设计仍以 `docs/v0.2.0-architecture-five-round-final.md` 为准。

---

# 1. 结论先行

`deepseek-harness-desktop` 的 Windows/macOS 安装包之所以可以很小，**主要不是 Rust 编译参数更激进，也不是把完整 DeepSeek Harness 压到了几 MB**，而是它把“桌面 Host”和“Node + dsh Runtime”拆成了两个发布生命周期。

它的安装器主要包含：

- Tauri Native Host；
- React/Vite 前端静态资源；
- 少量配置 JSON；
- 一组按生产依赖闭包打包的内置插件；
- 平台安装器自身需要的资源。

它**不在桌面安装包中预装完整 Node Runtime 和 dsh Core**。首次启动时才把 Node、dsh、pnpm，以及 Windows 必要时的 Git 下载到 AppData；后续可以单独更新 dsh Core，而不重新下载安装整个桌面程序。

因此它的“小安装包”本质上是：

```text
Small Host Installer
        |
        +-- Native Host
        +-- Frontend
        +-- Small built-in plugin closure
        |
        +---- first run / on demand ---->
                 Node Runtime
                 dsh Core
                 pnpm
                 optional Git
```

这和“所有能力都打进一个 Full Runtime 安装包”的体积模型完全不同。

---

# 2. 实际 Release 体积

参考项目最新检查版本为 `v0.10.2`。

GitHub Release 中主要桌面资产约为：

| 平台/格式 | 资产 | 大小约 |
| --- | --- | ---: |
| Windows | NSIS setup.exe | 5.97 MB |
| Windows | MSI | 9.44 MB |
| macOS arm64 | DMG | 9.39 MB |
| macOS x64 | DMG | 9.99 MB |
| Linux | DEB | 11.65 MB |
| Linux | AppImage | 89.92 MB |

Linux AppImage 明显大得多，是因为 AppImage 为可移植性需要携带更多 Linux 用户态运行库；DEB 则可以依赖系统 WebKitGTK/GTK 等组件，所以更小。

这组数字说明：

1. Windows/macOS 的小体积首先来自 Tauri 复用系统 WebView，而不是嵌入 Chromium；
2. 更大的差异来自 Runtime 不随 Host 安装包发布；
3. Linux 的封装格式仍然会显著影响安装包体积，不能拿 Windows 的 6 MB 作为所有平台统一目标。

---

# 3. “小”不等于总占用只有几 MB

参考项目 `src-tauri/resources/README.md` 明确说明，首次启动会把以下内容下载到用户数据目录：

```text
runtime/                Node.js Runtime
dependencies/dsh/       DeepSeek Harness package
logs/                   runtime/service logs
.store.dat               app settings
```

它使用的独立 `deepseek-harness-pkg` Release 当前单个平台 dsh Core 压缩包大约为 41 MB：

- Windows：约 40.97 MB；
- Linux：约 41.84 MB；
- macOS arm64：约 41.07 MB；
- macOS x64：约 41.95 MB。

Node v22.22.0 还需要另外下载。

所以正确理解应该是：

```text
下载页看到的安装器          很小
第一次完整可用所需网络流量    明显更大
最终磁盘占用                仍包含 Node + dsh + plugins
后续桌面 Host 更新           可以非常小
后续 dsh Core 更新           可以独立进行
```

这正是值得 HarnessDock 借鉴的地方：**优化“分发边界”，而不是只追求压缩二进制。**

---

# 4. 为什么它的 Host 自身也比较小

## 4.1 Tauri 复用系统 WebView

参考项目使用 Tauri 2，而不是 Electron。

这意味着：

- Windows 使用 WebView2 体系，不随应用打入一份 Chromium；
- macOS 使用系统 WebKit/WKWebView；
- Linux DEB 可以依赖系统 WebKitGTK；
- AppImage 因为要增强可移植性，体积仍会明显变大。

HarnessDock 已经是 Tauri-only，所以这一点我们已经具备。

## 4.2 它并没有特别激进的 Rust size profile

参考项目 `Cargo.toml` 没有配置 HarnessDock 当前已有的：

```toml
[profile.release]
opt-level = "z"
lto = "thin"
codegen-units = 1
strip = "symbols"
panic = "abort"
```

因此参考项目 6~10 MB 的安装器并不是靠 Rust `opt-level=z` 才做到的。

对 HarnessDock 来说，继续在 Rust 编译参数上挤 1~2 MB 的收益远小于重新设计 Runtime 分发边界。

## 4.3 资源目录不包含完整 Runtime

参考项目 Tauri bundle 配置虽然写了：

```text
resources/**/*
```

但源码中的 resources 主要是：

- preset plugin manifest；
- internal plugin manifest；
- deprecated plugin manifest；
- version recommend metadata；
- 构建阶段生成的少量内置插件生产闭包。

Node 和 dsh 不在这里。

## 4.4 内置插件只部署生产闭包

`scripts/build-plugins.ts` 的做法非常值得借鉴：

```text
workspace plugins
   -> build
   -> pnpm deploy --prod
   -> inject workspace packages
   -> node-linker=hoisted
   -> materialize symlinks
   -> verify package entry
   -> resources/node_modules
```

它明确避免把桌面 React/UI workspace 的所有生产/开发依赖一起带入插件包。

HarnessDock 新架构必须采用同类原则：

**任何 Host Integration / Shell / 内置 DSH 插件都只能携带自身真实生产闭包。**

禁止：

- 复制 workspace 根 `node_modules`；
- 打包 devDependencies；
- 把 test/docs/source map 全量放进安装器；
- 因 pnpm 虚拟仓库误把整个 workspace 闭包带入 Candidate。

---

# 5. 首次安装机制值得借鉴的部分

参考项目不只是“首启下载”，它已经实现了一套相对完整的下载管线。

## 5.1 Installable 抽象

它把依赖分成：

```text
Node
Dsh
Pnpm
Git (Windows only)
```

每种依赖有：

- kind；
- title；
- installed check；
- download URL；
- install path。

这个思想值得借鉴，但 HarnessDock 不应照搬成通用安装器，而应提升成 **Runtime Layer / Runtime Image Provider**。

## 5.2 断点续传

参考下载器使用 HTTP Range：

```text
已有部分 buffer
 -> Range: bytes=<offset>-
 -> 206 append
 -> server ignores Range -> restart from 0
```

这是大 Runtime 首次下载必须具备的能力。

## 5.3 多次重试与退避

单下载源最多重试 5 次，并逐渐退避。

值得直接吸收为 HarnessDock Download Engine 的策略配置。

## 5.4 多源回退

参考实现可以：

```text
GitHub official
 -> retry
 -> fallback mirror
 -> final hash verification
```

HarnessDock 可以借鉴“多 endpoint provider”，但不应把某个公共镜像硬编码为信任源。

新方案应定义：

```text
ArtifactSource {
  url,
  trustDomain,
  priority,
}
```

所有 source 最终都必须验证**同一个签名 manifest + digest**。

镜像只负责传输，不负责信任。

## 5.5 SHA-256 完整性检查

参考实现下载后做 SHA-256 校验。

HarnessDock 应进一步升级为：

```text
Signed Runtime Manifest
       +
SHA-256 / content digest
       +
platform / arch / layer identity
       +
Host Protocol compatibility range
```

只有全部满足才允许进入 Runtime Image Store。

## 5.6 原子落盘

参考下载模块已经强调“下载 -> 校验 -> 原子解压落盘”。

HarnessDock 应采用更严格的：

```text
.download/<digest>.partial
.staging/<transaction-id>/
images/<content-digest>/
active.json  (atomic pointer)
previous.json
```

下载、解压、验证失败永远不能污染 active Runtime。

---

# 6. 核心版本管理值得借鉴的部分

参考项目支持：

- 单独更新 Harness Core；
- 多 Core 版本管理；
- 本地已有 Core/Node 发现；
- GitHub 不可用时继续使用已安装版本；
- 切换 Core 后重新拉起服务。

HarnessDock 可以吸收其中“版本槽位”的思想，但采用更强的不可变镜像模型：

```text
Runtime Store
  layers/
    node/<digest>/
    dsh/<digest>/
    integration/<digest>/
  images/
    <image-id>/manifest.json
  active.json
  previous.json
```

这样：

- Node 不变时升级 dsh 不重复下载 Node；
- Host Integration 不变时也不重复下载；
- 回滚只切 active pointer；
- 同一 layer 可被多个 Runtime Image 复用；
- 删除旧版本时按引用计数/mark-sweep 清理。

这是比参考项目“runtime/ + dependencies/dsh-<version>”更适合长期演进的方案。

---

# 7. 哪些核心功能值得 HarnessDock 借鉴

## P0：应该进入 v0.2.0 Host Kernel

### 7.1 Runtime/Core 独立更新

最值得借鉴。

Host 更新和 dsh 更新不再强绑定：

```text
Host Release     -> Native Host version
Runtime Channel  -> Node/dsh/integration image
```

Runtime Manifest 声明：

```text
minHostVersion
maxHostVersion
protocolVersion
nodeVersion
dshVersion
dshCommit
layerDigests
```

Host 只激活兼容 Runtime。

### 7.2 First-run Bootstrap

首次启动如果无 Runtime：

```text
Resolve manifest
 -> Download layers
 -> Verify
 -> Install atomically
 -> Activate
 -> RuntimeActor start
 -> Harness Web
```

首次安装页只是 `Recovery/Bootstrap Surface`，Runtime 可用后自动关闭，不成为第二套常驻 UI。

### 7.3 Multi-version Runtime + Rollback

至少保留：

```text
active
previous
candidate
```

新 Runtime 连续启动失败达到策略阈值时：

```text
candidate failed
 -> invalidate candidate
 -> active = previous
 -> restart
 -> emit rollback event
```

### 7.4 Download Progress / Retry / Resume

必须原生进入 Host Protocol：

```text
RuntimeDownloadStarted
RuntimeDownloadProgress
RuntimeDownloadRetry
RuntimeDownloadSourceChanged
RuntimeVerifyStarted
RuntimeActivated
```

UI 不自行轮询下载状态。

### 7.5 Offline Cache

网络不可达但 active image 完整：直接启动。

没有 active image：Recovery Surface 提供：

- 重试；
- 选择本地 `.hdi` Runtime Image；
- 查看公开诊断。

### 7.6 CLI Shim

参考项目自动注册 `dsh` CLI 的思路很好。

HarnessDock 可以提供一个非常薄的 shim：

```text
dsh -> HarnessDock managed runtime active image
```

但必须遵循：

- 不修改用户 shell rc 文件正文；
- 只增加/删除自己的 PATH entry 或系统 shim；
- 卸载可完全清理；
- CLI 与 GUI 使用同一 active Runtime manifest；
- 不偷偷切换用户系统 Node。

---

# 8. P1：适合做成 Host Capability / Shell Extension

## 8.1 Profile 快速启动

参考项目有 Profile isolation 管理。

HarnessDock 不需要复制一套完整 Profile 管理 UI，但可以支持：

```text
HostIntent::LaunchProfile(profileId)
```

真正 profile 数据仍由 dsh 管理。

Host 只负责：

- 启动时选择 profile；
- 最近使用 profile；
- profile 启动失败诊断；
- 不直接重写 profile 内容。

## 8.2 Plugin Health / Recovery

参考项目有插件升级、卸载、错误详情和 built-in plugin auto-heal。

HarnessDock 新方案更适合分两类：

```text
Host-required integration plugins
 -> immutable Integration Layer
 -> 不做启动时 mutable repair

User/community plugins
 -> DSH_HOME
 -> health observation / quarantine / recovery policy
```

这样 Host 必需插件不会因为用户环境修改而损坏。

## 8.3 Preset Plugin Catalog

参考项目用 JSON 驱动 first-run presets，这个机制简单有效。

HarnessDock 可以把它升级为**签名 Catalog manifest**，但不要默认安装大量社区插件。

原则：

- 默认 0 个第三方插件；
- Catalog 只提供推荐；
- 安装由用户明确触发；
- 插件不进入 Host 安装包；
- Marketplace 继续由独立 dsh 插件生态承载。

## 8.4 Native Integration

参考项目值得借鉴：

- native notification；
- clipboard；
- new-window 外部浏览器处理；
- zoom；
- native menu；
- tray；
- launch on login；
- window state restore。

这些都应该进入 HarnessDock `Capability Broker`，而不是各自添加一批无约束 Tauri command。

---

# 9. P2：可以借鉴思想，但不应进入 Host Core 主链

参考项目还有：

- Worktree；
- Archived Chats；
- Skills/MCP 管理；
- Right-click enhancement；
- Sidebar Panel；
- Session UI 扩展；
- Plugin marketplace。

这些有价值，但它们属于 **Harness 扩展生态**，不是 Host Kernel。

HarnessDock 应保持：

```text
Host Kernel 只解决宿主、Runtime、安全、生命周期、Gateway、更新、恢复
业务 UI 增强继续由 DSH Plugin / Shell Extension 承载
```

否则我们会重新变成“另一套 Harness UI”。

---

# 10. 不建议照搬的机制

## 10.1 自动优先使用本机 Node

参考项目如果发现兼容 Node 会直接复用。

对 HarnessDock 正式版本不建议默认这样做，因为：

- PATH 可被其它软件影响；
- 用户 Node 可能带启动参数/注入；
- 可复现性下降；
- Bug 报告环境矩阵扩大。

HarnessDock 建议：

```text
Managed Runtime Image = 默认且正式支持
System Runtime Provider = Advanced/Developer explicit opt-in
```

## 10.2 Host 直接管理大量 dsh 产品配置

参考项目配置页涵盖 Profile、Plugin、Core 等大量产品能力。

HarnessDock 不应复制完整控制中心。

正常用户应直接进入 Harness Web；只有：

- Runtime bootstrap；
- Runtime versions；
- Gateway；
- Recovery；
- Diagnostics；
- Host update；

需要 Native Host 自有 Surface。

## 10.3 可变 built-in plugin 自愈

参考项目 built-in plugin 在启动时 auto-heal 是合理的历史工程选择。

HarnessDock 更好的方案是把 Host-required integration 放进 immutable Integration Layer。

损坏就重新验证/重新下载整个 layer，不在用户目录做半可变修补。

## 10.4 只用 digest、不做签名 manifest

SHA-256 只能证明“下载内容和给出的 hash 一样”，不能单独证明“hash 是谁发布的”。

HarnessDock Runtime Registry 必须使用签名 manifest / release provenance。

---

# 11. HarnessDock 新的体积分发目标

基于参考项目的真实数据，v0.2.0 采用“双分发形态”：

## 11.1 默认：Host Installer

只包含：

```text
Tauri Host binary
control/recovery frontend
host protocol schema
minimal Shell assets
runtime bootstrap trust root
updater
icons/install metadata
```

目标预算：

| 平台 | 目标预算 |
| --- | ---: |
| Windows NSIS | <= 15 MB |
| Windows MSI | <= 20 MB |
| macOS DMG | <= 20 MB |
| Linux DEB | <= 25 MB |
| Linux AppImage | <= 100 MB |

这些是 CI budget，不是承诺的最终实际值；实际构建应尽量向参考项目 6~12 MB 靠近。

## 11.2 可选：Offline Full Bundle

用于：

- 企业离线环境；
- 首次启动无网络；
- 测试/灾备。

包含：

```text
Host Installer
+ Runtime Image layers
+ signed manifest
```

它可以明显更大，不与 Host Installer 共用体积预算。

用户不应该因为需要离线能力而迫使所有普通用户每次都下载 Full Bundle。

---

# 12. 比参考项目进一步优化：Layered Runtime Image Store

推荐最终模型：

```text
RuntimeImageManifest
  imageId
  hostProtocolRange
  layers:
    node
    dsh
    integration

LayerManifest
  id
  digest
  size
  compressedSize
  platform
  arch
  urls[]
  signature
```

典型升级：

```text
vA
  node = N1
  dsh  = D1
  integration = I1

vB
  node = N1
  dsh  = D2
  integration = I1
```

升级只下载 `D2`。

这比每次下载完整 Runtime zip 更节省流量，也更适合回滚。

---

# 13. 对五轮架构计划的具体影响

参考分析要求我们调整此前五轮重点：

```text
Round 1
Protocol/Kernel + Host-only package composition + size baseline

Round 2
Runtime Layer Store + Download Engine + RuntimeActor + signed activation

Round 3
RuntimeLease + Reconciler + multi-version/rollback/offline import + Surface

Round 4
Capability Broker + Native Gateway + Shell v2 + CLI shim + plugin integration policy

Round 5
Model/Fault tests + package budgets + download/perf SLO + Host/Runtime Release Graph
```

详细执行要求见：

`docs/plan/v0.2.0-five-round-rebuild-plan.md`

---

# 14. 最终借鉴原则

可以概括为四句话：

1. **借鉴它的“小 Host、大 Runtime 后置”的分发机制，但升级成签名、分层、内容寻址 Runtime Store。**
2. **借鉴它的 Core/Plugin/CLI/下载/恢复产品经验，但不复制它的大型配置面板和 Service/Workflow 架构。**
3. **继续坚持 HarnessDock 的 Actor + Lease + Reconciler + Capability 模型，不因为参考项目已有代码而倒退。**
4. **安装包体积必须通过架构减少内容，而不是通过牺牲完整性、安全或可恢复性换取数字。**
