# HarnessDock × Perry 客户端可行性分析与优化路线

> 状态：方案评审稿（仅文档，不修改业务代码）  
> 日期：2026-08-29  
> 基线：`main@fa74fc12e898946e9a9d0aece3911bc92722077f`  
> 目标：评估使用 [Perry](https://www.perryts.com/) 构建 HarnessDock 原生客户端的可行性，并制定与现有 Electron 客户端共存、验证、迁移和长期演进方案。

---

## 1. 执行结论

**Perry 值得引入，但现阶段不建议直接整体替换 Electron。**

最优路线是把 Perry 定位成 HarnessDock 的第二套 **Native Shell**：继续使用官方 `dsh web`、官方 Harness Web UI、官方 `~/.dsh/` 数据目录和当前精确版本钉定机制，只替换桌面宿主层。

推荐产品形态：

| Host | 定位 | 当前建议 |
| --- | --- | --- |
| Electron | 完整兼容、稳定基线、LTS | 保留并继续作为 Stable |
| Perry | 极致轻量、低内存、快速启动 | 新增 Preview / Experimental |

不建议第一阶段把 `@deepseek-ai/dsh` 本体通过 Perry 重新 AOT 编译。正确边界应保持为：

```text
Perry = HarnessDock desktop host compiler
Node  = official dsh runtime
```

而不是：

```text
Perry = 重新编译整个 dsh
```

只有 Perry 在 Windows / macOS / Linux 连续通过完整功能 parity、更新、下载、文件选择、WebSocket、持久化和异常恢复门禁后，才讨论成为默认桌面 Host。

---

## 2. 当前 HarnessDock 架构基线

HarnessDock 当前已经不是简单的 Electron WebView 包装器，而是一个完整的 **Runtime Supervisor + Desktop Host + Release System**。

```text
HarnessDock
├─ apps/
│  ├─ desktop/                  # Electron 桌面客户端
│  └─ vscode/                   # VS Code / Cursor 扩展
├─ packages/
│  ├─ bootstrap/                # 通用启动编排
│  ├─ client-runtime/           # dsh runtime 获取、验证、启动、回滚
│  ├─ docs-sync/                # 上游版本钉定与能力矩阵
│  └─ plugin-embedded-client/   # embedded client plugin
├─ tests/
└─ .github/workflows/
   ├─ ci.yml
   └─ release.yml
```

当前核心链路：

```text
Electron desktop
   │
   ├─ splash / diagnostics / tray / updater
   │
   ├─ @dsh/bootstrap
   │     └─ @dsh/client-runtime
   │            ├─ resolve pinned runtime
   │            ├─ bundled / downloaded mode
   │            ├─ integrity check
   │            ├─ start dsh web
   │            └─ last-known-good rollback
   │
   └─ BrowserWindow
          └─ http://127.0.0.1:<random-port>
                 └─ official DeepSeek Harness Web UI
```

当前 Electron Host 已经承担：

- 单实例锁；
- 窗口生命周期；
- frameless window；
- preload 注入自定义 titlebar；
- `ipcMain` / `ipcRenderer`；
- 外链和导航保护；
- 下载路径处理；
- renderer load / crash / unresponsive 恢复；
- tray；
- Notification；
- 自动更新；
- Splash；
- diagnostics；
- window state persistence。

因此 Perry 迁移真正要解决的不是“能不能显示网页”，而是 **Desktop Host parity**。

---

## 3. Perry 与 HarnessDock 的匹配度

Perry 的核心价值与当前项目技术栈高度匹配：

- TypeScript / JavaScript AOT 到 native executable；
- LLVM native code；
- 不必随宿主携带 Electron / Chromium；
- macOS / Windows / Linux 原生 UI；
- 提供大量 Node API 兼容；
- 提供 `child_process`、文件、网络、crypto、stream 等能力；
- `perry/ui` 使用 AppKit / Win32 / GTK4 等原生控件；
- 有 native WebView；
- Perry 官方工具链还覆盖签名、发布、通知、keychain、auto-update 等方向。

HarnessDock 本身已经是 TypeScript monorepo，因此相比重新用 Rust / Swift / C++ 改写桌面壳，Perry 的语言迁移成本明显更低。

### 3.1 Perry WebView 的关键边界

Perry WebView 适合“native widget tree 中的一张 browser tab”，但不是 Electron/Tauri 风格的完整 app shell。

公开 API 的关键点：

- 能加载 URL；
- 能限制 `allowedDomains`；
- 支持自定义 User-Agent；
- 支持持久或 ephemeral cookie/storage；
- 支持 navigation interception；
- 支持 native → page 的 JS evaluate；
- 当前 native target **没有通用双向 postMessage RPC**。

这对普通 Electron 应用可能是明显限制，但对 HarnessDock 不一定是阻断项，因为官方 Harness SPA 的核心业务通信本来就通过 HTTP / WebSocket 与本地 `dsh web` 服务进行，不需要依赖 Electron IPC。

因此 Perry 方案应该主动设计成：

```text
Harness SPA <---- HTTP / WS ----> dsh web

Perry Host 只负责：
window / tray / runtime / diagnostics / update / native chrome
```

---

## 4. 分能力可行性

### 4.1 启动 dsh runtime：高可行

推荐继续维持现有运行模式：

```text
Perry Native Shell
      │
      ├─ resolve pinned dsh runtime
      ├─ spawn Node + dsh
      ├─ wait ready / health
      └─ WebView(load localhost URL)
```

这样可以完整保留：

- 官方 `@deepseek-ai/dsh` release artifact；
- full 模式 bundled Node + dsh；
- thin 模式在线获取；
- runtime cache；
- integrity；
- last-known-good rollback；
- 官方 `~/.dsh/` 数据和凭证。

### 4.2 官方 Harness Web UI：中高可行

基础页面加载本身可行，但正式进入 Preview 前必须真实验证：

- React/SPA hydration；
- WebSocket / reconnect；
- streaming response；
- localStorage；
- IndexedDB；
- cookie；
- clipboard；
- file picker；
- drag/drop；
- browser download；
- blob URL export；
- OAuth / external link；
- keyboard shortcut；
- 中文 IME；
- code editor；
- theme；
- popup / `window.open`。

其中 **download / export / file picker** 是最高优先级风险。现有 Electron 明确通过 `will-download` 接管下载，而 Perry 公开 WebView API目前没有 Electron 等价的完整下载生命周期接口，因此必须以 PoC 结果为准。

### 4.3 preload / IPC：不能机械迁移，但可以消除

当前 `preload.ts` 主要是给官方 SPA 注入 HarnessDock titlebar，并把窗口按钮通过 Electron IPC 映射到 native window。

Perry 不应复制这套模式，而应把标题栏直接放到 WebView 外部：

```text
┌─────────────────────────────────────────┐
│ Perry Native Title / Toolbar            │
├─────────────────────────────────────────┤
│                                         │
│ Perry WebView                           │
│ └─ official Harness Web UI              │
│                                         │
└─────────────────────────────────────────┘
```

收益：

- 不再向上游 SPA 插入 DOM；
- 不再依赖 theme DOM marker；
- 不需要 titlebar IPC；
- 官方 Web UI 更接近真正 untouched。

### 4.4 Tray / Notification / Dialog：高可行

这些天然适合 Perry native UI。建议全部留在 Host：

- tray；
- runtime status；
- version selector；
- diagnostics；
- crash notification；
- update notification；
- open logs；
- restart runtime。

### 4.5 自动更新：中等可行

现有 Electron 已经基于 `electron-updater` 建立 GitHub Release、latest metadata、blockmap、后台下载和安装流程，Perry 不应被假设能直接复用同一客户端更新协议。

建议抽象：

```text
UpdateService
├─ ElectronUpdateAdapter
└─ PerryUpdateAdapter
```

共享：

- channel；
- manifest；
- semantic version policy；
- SHA256；
- rollout policy。

Host 分别实现下载和安装。

### 4.6 VS Code / Cursor：不受影响

`apps/vscode` 不需要迁移。Perry 只是增加新的 desktop host，`@dsh/bootstrap` / `@dsh/client-runtime` 继续服务 VS Code host。

---

## 5. Electron 与 Perry 针对 HarnessDock 的对比

| 维度 | 当前 Electron | Perry Native Shell | 结论 |
| --- | --- | --- | --- |
| Harness Web UI 兼容 | 固定 Chromium，强 | 系统 WebView | Electron 当前更稳 |
| Host 包体 | 较大 | 可显著变小 | Perry 优 |
| Host 内存 | Chromium 多进程 | native + system WebView | Perry 有明显潜力 |
| 冷启动 | Electron/Chromium | native AOT | Perry 优 |
| Node API | 完整 | 高兼容但非 100% | Electron 优 |
| native↔web RPC | preload/IPC 完整 | 通用双向 RPC 受限 | Electron 优 |
| 下载控制 | 成熟 | 需 PoC | Electron 优 |
| crash recovery | 已成熟 | 需平台验证 | Electron 优 |
| 原生 UI | Web/Chromium | AppKit/Win32/GTK4 | Perry 优 |
| 自动更新 | 已实现 | 需重新接入 | Electron 当前优 |
| 三平台行为一致性 | Chromium 高一致 | WebView 有平台差异 | Electron 优 |
| TypeScript 复用 | 100% | shared core 高、shell 较低 | 可接受 |
| 移动端潜力 | 弱 | Perry 有延展性 | Perry 长期优 |

---

## 6. 当前 Electron 方案的优点

### 固定 Chromium 行为

Harness 是复杂 Web App，Electron 固定 Chromium 能稳定保障：

- CSS/JS；
- WebSocket；
- downloads；
- permissions；
- clipboard；
- file picker；
- keyboard；
- Web storage。

### 已经完成大量生产工程

当前 desktop 已经具备 runtime lifecycle、splash、diagnostics、tray、自动更新、故障恢复、full/thin 和三平台 release，不是一个可以低成本丢弃的 demo shell。

### Release pipeline 已成熟

当前已经产出 Windows NSIS/Portable/zip、macOS dmg/zip、Linux AppImage/deb，以及 full/thin 两套场景。

---

## 7. 当前 Electron 方案的主要缺点

### 7.1 “薄壳”仍携带 Chromium

v0.1.0 Release 的 thin 产物仍然处于约 80–120 MB 级：

- Windows thin Portable 约 84.7 MB；
- Windows thin Setup 约 85.0 MB；
- Windows thin zip 约 119.7 MB；
- Linux thin AppImage 约 82.5 MB；
- macOS thin dmg/zip 大约 89–102 MB。

这说明 runtime 即使已经拆成 thin，Electron 本身仍构成明显体积基础。

### 7.2 titlebar 对上游 DOM 有轻耦合

现有 preload 虽然没有 fork SPA，但仍向官方页面插入 DOM 并监听 theme marker。上游结构变化可能需要适配。

### 7.3 Host 与 Web UI 的责任边界还能更清晰

长期最理想的状态应是：

```text
Harness Web UI = upstream-owned
HarnessDock Host UX = HarnessDock-owned
Runtime = shared
```

Perry native chrome 有利于强化这条边界。

---

## 8. Perry 方案的主要优势

1. 更符合“真正薄壳”的产品理念；
2. TypeScript 栈保持不变；
3. native window/menu/tray 更自然；
4. 可显著降低 desktop host 包体和 idle memory；
5. 不再随 Host 携带 Chromium；
6. 有机会移除 DOM titlebar injection；
7. 长期拥有更广泛 native target 的演进空间。

---

## 9. Perry 方案的主要风险

### 系统 WebView 差异

实际很可能对应：

```text
Windows → WebView2
macOS   → WKWebView
Linux   → WebKitGTK
```

同一 Harness SPA 需要三平台真实 E2E。

### WebView 并非 Electron 替代 API

Perry 明确不提供通用 native↔JS 双向 RPC，因此设计必须避免页面调用 host 的强依赖。

### 下载 / export 可能成为 blocker

如果官方 Harness 的浏览器导出依赖 WebView 下载 delegate，而 Perry 无法可靠接管，则 Perry 只能继续保持 Preview，不能升 Stable。

### 框架成熟度风险

Perry 当前仍快速迭代，必须精确 pin compiler 版本并建立自己的兼容矩阵。

---

## 10. 推荐目标架构：Multi-host Client Platform

```text
                        ┌──────────────────────┐
                        │  Official dsh Web UI │
                        └──────────┬───────────┘
                                   │ HTTP / WS
                          127.0.0.1:<port>
                                   │
                 ┌─────────────────┴─────────────────┐
                 │          Runtime Platform          │
                 │ @dsh/bootstrap + client-runtime   │
                 └────────┬───────────────┬──────────┘
                          │               │
              ┌───────────▼─────┐  ┌─────▼────────────┐
              │ Electron Host   │  │ Perry Native Host│
              │ Stable / LTS    │  │ Preview          │
              └─────────────────┘  └──────────────────┘
```

未来可以演进出：

```text
packages/
├─ host-core/
├─ runtime-contract/
├─ update-contract/
└─ diagnostics-core/

apps/
├─ desktop-electron/
├─ desktop-perry/
└─ vscode/
```

**本轮只记录该目标，不执行目录或代码重构。**

---

## 11. Host Adapter 设计建议

未来应避免业务层直接 import Electron：

```ts
interface DesktopHost {
  app: AppLifecycle;
  window: WindowHost;
  tray: TrayHost;
  notifications: NotificationHost;
  dialogs: DialogHost;
  externalLinks: ExternalLinkHost;
  updater: UpdateHost;
  webSurface: WebSurfaceHost;
}
```

实现：

```text
ElectronDesktopHost
PerryDesktopHost
```

Runtime 不应该知道当前宿主是谁。

---

## 12. Runtime Supervisor 契约

当前 `@dsh/bootstrap` 和 `@dsh/client-runtime` 已是 Perry 可行性的最大利好。建议后续继续把 runtime lifecycle 收敛为统一输入输出。

输入示例：

```json
{
  "originPath": "...",
  "userDataDir": "...",
  "runtimeMode": "thin|full",
  "versionOverride": "optional"
}
```

输出：

```json
{
  "url": "http://127.0.0.1:xxxxx",
  "pid": 12345,
  "dshVersion": "x.y.z",
  "mode": "bundled|downloaded|system"
}
```

标准 events：

```text
resolve → fetch → verify → spawn → ready
                         ↘ rollback / error
ready → stop
```

这样 Electron、Perry、VS Code 都只消费同一 runtime lifecycle。

---

## 13. Full / Thin 在 Perry 下的保留方式

### Perry Thin

```text
Perry native executable
+ HarnessDock metadata
+ runtime resolver
```

首次启动解析精确 dsh 版本，下载/复用 runtime，启动 `dsh web` 后打开 WebView。

### Perry Full

```text
Perry native executable
+ bundled Node
+ bundled @deepseek-ai/dsh
+ embedded client plugin
+ origin metadata
```

Perry 能减少的是 Electron/Chromium Host 开销；full 包仍然要携带官方 Node + dsh，所以不应预期 full 安装包变成几 MB。

---

## 14. 为什么第一阶段不要用 Perry 重编译 dsh

即使 Perry 支持大量 Node API 和 npm package，也不代表应该把 dsh 本体纳入 AOT：

1. dsh 是独立上游，不由 HarnessDock 控制；
2. 上游随时可能新增 native dependency；
3. 会破坏“运行官方 release artifact”的强一致性；
4. parity 诊断变复杂；
5. Perry compiler 问题与 dsh 上游问题会混合；
6. 当前 external runtime 模式已经成熟。

因此应坚持：**Perry 编译 Host，Node 运行 dsh。**

---

## 15. 必须建立的 Perry Parity Gate

### P0：正式客户端阻断能力

- [ ] dsh web 启动成功
- [ ] Harness 首页可加载
- [ ] 会话创建
- [ ] 模型选择
- [ ] streaming output
- [ ] workspace 打开
- [ ] 文件读取/写入相关 Web 流程
- [ ] approval
- [ ] plugin 页面
- [ ] plugin install / enable / disable
- [ ] export
- [ ] file download
- [ ] clipboard copy
- [ ] file picker/upload
- [ ] WebSocket reconnect
- [ ] localStorage/IndexedDB persistence
- [ ] 重启后状态可恢复

### P1：桌面体验

- [ ] tray
- [ ] close-to-tray
- [ ] single instance
- [ ] external link
- [ ] notification
- [ ] window position restore
- [ ] fullscreen/maximize
- [ ] HiDPI
- [ ] dark/light
- [ ] Chinese IME
- [ ] keyboard shortcuts

### P1：runtime

- [ ] thin first boot
- [ ] full offline boot
- [ ] runtime cache
- [ ] interrupted download resume
- [ ] integrity check
- [ ] pin version
- [ ] version override
- [ ] LKG rollback
- [ ] graceful shutdown
- [ ] orphan process cleanup

### P1：release

- [ ] Windows x64
- [ ] macOS arm64
- [ ] macOS x64（如继续支持）
- [ ] Linux x64
- [ ] signing
- [ ] notarization
- [ ] update
- [ ] uninstall
- [ ] downgrade protection

---

## 16. 分阶段实施路线

### Phase 0 — Architecture Freeze（当前阶段）

只确定架构和退出条件，不改生产代码。

完成条件：

- Perry = 并行 Native Host；
- dsh = 官方 Node runtime；
- Web UI = 不 fork；
- parity gate 确认；
- GO / HOLD / STOP 条件确认。

### Phase 1 — Perry Spike

建议后续先放在：

```text
experiments/perry-shell/
```

只实现：

1. native App；
2. WebView 加载本地测试 URL；
3. child process 启动 `dsh web`；
4. 等待 ready；
5. WebView 加载 ready URL；
6. 退出时停止 runtime。

不做 updater、tray、diagnostics、full packaging、自动发布。

### Phase 2 — WebView Compatibility Gate

优先验证最可能阻断迁移的能力：

1. download / export；
2. file picker；
3. clipboard；
4. WebSocket / streaming；
5. session/storage persistence；
6. external links；
7. IME / keyboard。

任何 P0 项无法可靠解决，则 Perry 继续 Experimental，不进入正式迁移。

### Phase 3 — Runtime Integration

让 Perry 正式复用：

- origin.json；
- client-runtime；
- runtime cache；
- integrity；
- rollback；
- full/thin；
- diagnostics data model。

两种实现路径：

**A. 直接 AOT compile shared TS**：优先方案，先用 `perry check` 验证现有 Node API compatibility。

**B. Node supervisor sidecar**：如果部分 shared code 无法被 Perry 稳定编译，则 Perry host 通过 stdio/JSON 调用一个非常小的 Node runtime supervisor。full 本来就包含 Node，因此可作为兼容 fallback。

### Phase 4 — Native Desktop Parity

实现：

- native titlebar；
- tray；
- notifications；
- diagnostics；
- version switch；
- runtime status；
- close-to-tray；
- single instance。

### Phase 5 — Packaging / Signing / CI

新增独立 Preview workflow，而不是改坏当前 Stable release：

```text
.github/workflows/perry-preview.yml
```

产物独立命名：

```text
HarnessDock-Perry-Preview-<version>-win-x64.*
HarnessDock-Perry-Preview-<version>-mac-arm64.*
HarnessDock-Perry-Preview-<version>-linux-x64.*
```

### Phase 6 — Public Preview

Release 同时提供：

```text
Electron — Stable
Perry    — Preview
```

观测：

- crash；
- WebView compatibility；
- package size；
- idle RSS；
- cold start；
- dsh ready latency；
- update reliability。

### Phase 7 — Default Host Decision

只有满足以下条件才考虑 Perry 默认化：

- 三平台 P0 100% 通过；
- 至少连续 2 个 release cycle 无 blocker；
- updater parity；
- export/download 完整；
- crash rate 不高于 Electron；
- 上游 Harness 升级可自动做 parity；
- rollback/release 成熟。

否则保持双轨。

---

## 17. 量化验收指标

不能只用“能打开网页”判断成功。

| 指标 | Perry 目标 |
| --- | --- |
| thin host package | 相比 Electron host 显著下降 |
| cold shell start | 至少改善 30% |
| idle RSS | 至少改善 30% |
| UI ready latency | 不退化超过 5% |
| dsh runtime ready | 不退化超过 5% |
| P0 parity | 100% |
| update success | 不低于 Electron baseline |
| crash recovery | 与 Stable 等价 |

Benchmark 必须拆开测：

```text
host startup
→ runtime resolution
→ runtime spawn
→ dsh ready
→ WebView load
→ SPA interactive
```

Perry 能优化的是 Host，不应把 dsh runtime 本身的耗时算作 Perry 收益。

---

## 18. 安全模型

### WebView

- 只允许当前 `127.0.0.1` / localhost dsh origin；
- 外域统一交给系统浏览器；
- 不暴露通用 native bridge；
- 主窗口使用持久 storage；
- 临时 OAuth/辅助窗口按需要隔离。

### Runtime

- 继续 loopback bind；
- random port；
- ready handshake；
- child ownership；
- graceful shutdown；
- orphan cleanup；
- single-instance 保护。

### Update

- manifest + SHA256；
- release/signature validation；
- channel pin；
- 防错误 downgrade / cross-channel update。

---

## 19. CI/CD 优化建议

先保持：

```text
ci.yml
release.yml          # Electron Stable
```

后续新增：

```text
perry-preview.yml    # Perry Preview
```

Preview pipeline 建议：

```text
checkout
→ setup pinned Perry
→ perry check
→ build host
→ runtime smoke
→ WebView smoke
→ platform package
→ signing
→ artifact
```

Perry compiler 必须精确 pin，禁止 rolling latest。

---

## 20. 版本和 diagnostics 元数据

推荐把“产品版本”和“Host”分开：

```json
{
  "appVersion": "0.2.0",
  "host": "perry",
  "hostVersion": "<pinned-perry-version>",
  "channel": "preview",
  "dshVersion": "<pinned-dsh-version>"
}
```

这样同一 HarnessDock 产品可以有 Electron/Perry 两个 Host，而不会把产品 semantic version 与实现框架绑死。

---

## 21. 推荐的后续代码执行顺序（本轮不执行）

1. Perry 最小 WebView spike；
2. 官方 Harness P0 Web 功能验证；
3. download/export/file picker 验证；
4. runtime spawn / stop；
5. 接入 shared bootstrap；
6. native window / tray；
7. diagnostics；
8. full/thin packaging；
9. updater；
10. Preview CI；
11. 三平台 E2E；
12. Preview Release；
13. 收集性能与稳定性指标；
14. 再决定是否替换 Electron。

**不要先大范围重构仓库再测试 Perry。WebView P0 compatibility 是整个项目的第一技术门。**

---

## 22. Decision Gate

### GO

继续投入的条件：

- Perry WebView 三端稳定运行官方 Harness SPA；
- streaming/WebSocket 正常；
- export/download 有可靠实现；
- child process lifecycle 可控；
- shared runtime 能高比例复用。

### HOLD

如果出现：

- Linux WebView 不稳定；
- 某平台 download/file picker 无可靠方案；
- upstream Harness 使用某个 Chromium-only 能力。

则 Perry 保持 Preview，不影响 Electron Stable。

### STOP

如果必须：

- fork 官方 Harness Web UI；
- 大面积修改上游 SPA；
- 注入复杂双向 JS/native bridge；

才能完成迁移，则应停止 Perry 主线替换，因为这违背 HarnessDock“不 fork、不重写上游”的核心原则。

---

## 23. 综合推荐

| 决策 | 推荐度 |
| --- | ---: |
| 研究并立项 Perry | 8/10 |
| 立即删除 Electron 并切 Perry | 3/10 |
| 建立 Perry Preview 并行 Host | 9/10 |

推荐演进：

```text
当前：
Electron Stable

下一阶段：
Electron Stable + Perry Preview

只有 parity 成熟后：
Perry Stable + Electron LTS fallback
```

一句话结论：

> **Perry 很适合成为 HarnessDock 更轻量的 Native Shell，但应该替换的是 Electron“宿主层”，不是 DeepSeek Harness；先并行 Preview、先验证系统 WebView 完整 parity，再决定是否成为默认客户端。**

---

## 24. 参考资料

### Perry

- 官网：<https://www.perryts.com/>
- GitHub：<https://github.com/PerryTS/perry>
- Native UI overview：<https://github.com/PerryTS/perry/blob/main/docs/src/ui/overview.md>
- Perry UI / WebView definitions：<https://github.com/PerryTS/perry/blob/main/types/perry/ui/index.d.ts>

### HarnessDock 当前实现

- `apps/desktop/package.json`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/boot/boot-flow.ts`
- `apps/desktop/src/window/main-window.ts`
- `apps/desktop/src/preload.ts`
- `packages/bootstrap/`
- `packages/client-runtime/`
- `.github/workflows/release.yml`
