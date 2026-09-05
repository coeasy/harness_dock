# HarnessDock 架构审查报告

> 审查日期：2026-09-05 | 版本：v0.1.2-beta.3 | Runtime：dsh-v0.1.2-rc.1

---

## 一、项目定位

HarnessDock 是 **DeepSeek Harness (dsh) 的 Tauri 2.x 原生桌面宿主**。它不 fork 或重写官方 Web UI，而是：

- 托管版本锁定的 dsh 运行时（Node + 插件）
- 保护进程生命周期（spawn / supervise / kill-on-job-close）
- 校验 loopback 地址（WebView 只允许当前 RuntimeLease 对应的 `127.0.0.1` origin）
- 在原生窗口中加载 Harness Web，并提供可选外壳 (Shell)

**第三方声明**：与 DeepSeek 官方无隶属或背书关系。

---

## 二、顶层架构

```
┌─────────────────────────────────────────────────────────┐
│                    HarnessDock 客户端                      │
│                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │  Tauri Host  │──▶│  Host Kernel │──▶│  Reconciler  │ │
│  │  (Rust)      │   │  (单 actor)   │   │  (分发+鉴权)  │ │
│  └──────┬───────┘   └──────────────┘   └──────┬───────┘ │
│         │                                      │         │
│  ┌──────▼───────┐   ┌──────────────┐   ┌──────▼───────┐ │
│  │  WebView2    │   │  Node Runtime│   │  Gateway     │ │
│  │  (Harness Web)│◀──│  (dsh 进程)   │   │  (远程配对)   │ │
│  └──────────────┘   └──────────────┘   └──────────────┘ │
│         │                                                │
│  ┌──────▼───────┐                                      │
│  │  Shell 插件   │  (Shadow DOM 顶栏 + 菜单)             │
│  └──────────────┘                                      │
└─────────────────────────────────────────────────────────┘
```

### 正常桌面启动链路

```
Tauri setup
  → Host Kernel / startup coordinator
  → sealed Full Runtime (Node + dsh, 首启零下载)
  → RuntimeActor / RuntimeLease
  → isolated Harness WebView (127.0.0.1:<port>)
  → Harness Web (React bundle)
  → optional Harness Shell (Shadow DOM 注入)
```

Runtime 或 WebView 首次加载失败 → 进入 Recovery 窗口；Shell / Tray / Updater 等可选组件失败 → fail-open（不阻止 Harness Web 启动）。

---

## 三、Monorepo 包结构

| 包 | 用途 | 入口 |
|---|---|---|
| `@dsh/bootstrap` | 引导库：gateway / runtime-provider / runtime-update / host-capabilities / client-core / shell-contract | `src/index.ts` |
| `@dsh/client-runtime` | 运行时打包工具：prepare-cli / ensure-pnpm-cli / prune-node-cli | `src/cli.ts` |
| `@dsh/docs-sync` | 文档同步 CLI + origin.json 资源 | `src/cli.ts` |
| `@dsh/plugin-embedded-client` | 内嵌客户端插件：鉴权握手 + ready.json 写入（3 次连续健康探测） | `src/index.ts` |
| `@dsh/plugin-harness-shell` | 可移植 Shell 插件：Shadow DOM 顶栏 + 菜单 + Toast | `src/web/shell.js` |

**依赖关系**：`docs-sync ← client-runtime ← bootstrap`；两个 plugin 包独立。

---

## 四、Rust 后端模块清单（8,131 行）

| 模块 | 行数级 | 职责 |
|---|---|---|
| `lib.rs` | ~90 | 入口：桌面/移动双 `run()`，模块组合根 |
| `state.rs` | ~35 | AppState：5 个 Mutex<Actor> + revision/quitting 原子量 |
| `startup.rs` + `startup_trace.rs` | ~200 | 启动协调 + 阶段埋点（ProcessStarted → RuntimeReady → WebviewRequested → PrimaryVisible） |
| `runtime.rs` | ~1400 | Node runtime spawn / ready 校验 / 恢复 / 状态管理 |
| `runtime_actor.rs` | ~300 | RuntimeActor 状态机：Stopped→Preparing→Starting→Probing→Ready/Degraded |
| `process.rs` | ~250 | 进程注册 + Windows Job Object + Unix 进程组 |
| `host_kernel.rs` | ~400 | 单 actor 事件循环（channel 容量 128）+ 去重 LRU |
| `host_protocol.rs` + `host_protocol_generated.rs` | ~500 | 协议 v2 schema + 代码生成 |
| `bridge.rs` | ~200 | Tauri 命令 → Host Kernel 转换 + 请求来源信任边界 |
| `harness_shell.rs` | ~200 | Shell 注入：POLYFILL → BRIDGE → SHELL_WEB_SCRIPT |
| `harness_window.rs` | ~450 | WebView 创建 + navigation/page_load 事件处理 |
| `reconciler.rs` | ~300 | 命令分发 + lease 绑定 + revision 计数 |
| `supervisor.rs` | ~150 | 退出协调：等所有 actor 静止 → exit(0) |
| `capability_broker.rs` | ~250 | 能力代理：按 (subject, surface, origin, generation, lease) 决策 |
| `plugin_quarantine.rs` | ~150 | 插件隔离：TTL 24h + 原子 rename + dsh_version 绑定 |
| `gateway.rs` + `gateway_host.rs` | ~600 | 远程网关 + HTTPS 反向代理 |
| `update.rs` + `update_actor.rs` | ~500 | 更新逻辑 + actor |
| `desktop.rs` | ~300 | 桌面适配：窗口/菜单/托盘/事件循环 |
| `service/` | ~100 | 工作流转发（native menu/tray → host_kernel） |
| 其他 | ~800 | lifecycle / tray / single_instance / platform / surface_actor / mobile |

---

## 五、核心实现细节

### 5.1 启动流程

```
ProcessStarted (lib.rs:60)
  → runtime::start_blocking (spawn_blocking)
  → 读 DSH_EMBEDDED_READY_FILE (ready.json)
  → 校验 PID / version / nonce / imageIdentity
  → RuntimeReady (runtime.rs:1340)
  → startup::spawn
    → hide_splash
    → reconciler::ensure_runtime_for_boot
    → harness_window::open_for_startup (创建 WebView)
    → reveal_clean_runtime_fallback (50×100ms 轮询)
      → 要求 host.dock:// 干净 URL + runtime_listener_reachable ×5
      → PrimaryVisible / ShellReady
```

**失败回退**：runtime 无 url/启动失败 → `show_startup_recovery` 打开 control 恢复窗口。

### 5.2 运行时管理

- **spawn**：`node <dsh> --profile web`，读 ready.json 判定就绪
- **通信**：独立 Node 子进程，Tauri 侧靠 ready 文件 + TCP 探测，无 RPC
- **生命周期**：RuntimeActor 状态机 + generation nonce（防同机伪造）
- **进程隔离**：Windows Job Object (KILL_ON_JOB_CLOSE) / Unix 进程组 (TERM→KILL)

### 5.3 Host Kernel 与协议 v2

- **单 actor 事件循环**（channel 容量 128，`sync_channel(1)` 同步应答）
- **协议 v2**：`CommandEnvelope{protocol_version, request_id, subject, command}` + `ResponseEnvelope`
- **subjects**：desktop-shell / harness-web / native-menu / tray / diagnostics / mobile
- **capabilities**：17 项（window-control / runtime-restart / gateway-admin / update-install …）
- **去重**：LRU 窗口 256，同 request_id 换命令返回 `REQUEST_ID_REUSED`
- **bridge 转换**：`host_execute` → `envelope.validate()` → `trusted_subject`（按 WebView label 强制定权）→ `host_kernel::execute_envelope`

### 5.4 Shell 注入

```
init_script() = POLYFILL_SCRIPT + BRIDGE_SCRIPT + SHELL_WEB_SCRIPT
```

| 层 | 职责 |
|---|---|
| **POLYFILL** | `Promise.withResolvers` + `AbortSignal.any`（Chromium 113 WebView2 兼容） |
| **BRIDGE** | `window.__DSH_SHELL_BRIDGE__`（apiVersion:2）：directWindowMap（min/max/close/state）+ hostCommandMap（reload/restart/safe-mode/gateway/diagnostics）→ `host_execute` 信封 |
| **SHELL_WEB** | Shadow DOM：44px fixed 顶栏 + 菜单 + Toast + 状态指示器 |

Shell 所有敏感操作经 Host Protocol 集中鉴权，远程 Harness 文档不持有直接 IPC。

### 5.5 插件体系

- **隔离**：`plugin-quarantine.v1.json`（TTL 24h，reason：diagnostic-match / ambiguous）
- **恢复**：启动失败 → `dump_config` → `recovery_plan`（字符串诊断归因）→ 生成禁用 patch 重试
- **能力代理**：HarnessWeb 仅允许 WindowControl/WebReload/Restart/SafeMode/Gateway&Diagnostics 打开；Admin/Update/Quit 禁止

### 5.6 Web 前端

- **dsh-web-frontend**：React 18 + Vite 6 + TypeScript + cordis
- 入口：`index.html` → `index-Df-65__b.js`(423KB) + `vendor-CCJJTK99.js`(740KB)
- 通过 `window.__DSH_SHELL_BRIDGE__` 与 Shell 解耦
- **compat 层**（`dsh-client-runtime-compat/client.js`）：为旧版浏览器 bundle 模拟 `@deepseek-ai/dsh-client-runtime`，以 cordis function 插件形态加载

---

## 六、构建与发布

### 6.1 构建脚本

| 脚本 | 用途 |
|---|---|
| `scripts/build.mjs` | 一键本地 Tauri 构建（install tauri-cli → test → build plugins → prepare runtime → cargo check） |
| `scripts/prepare-local-runtime.mjs` | 优先下载已发布 runtime（SHA256 校验），否则从精确 pin 上游打包 |
| `scripts/local-client.ps1` | 本地客户端 quick/build/smoke |
| `scripts/check-*.mjs` | 版本 / 体积 / 嵌入运行时 / host-protocol / tauri-only / shell-package 校验 |
| `scripts/generate-host-protocol.mjs` | 协议代码生成 |

### 6.2 运行时打包

- Node v22.19.0 + pnpm 11.7.0（SHA256 锁定）
- `prepare-cli.ts`：下载固定版本 Node → 装 @deepseek-ai/dsh 生产闭包 → 装目标原生包 → `RUNTIME_LAYOUT_VERSION=4` 防缓存绕过
- `prune-node-cli.ts`：删除跨平台预编译 / .map / .pdb / test/examples
- `manifest.json`：imageIdentity=sha256-v1 + runtimeEmbedded=true + firstLaunchRuntimeDownloadRequired=false
- 密封、可复现、image-identity 代际绑定

### 6.3 CI/CD

| Workflow | 用途 |
|---|---|
| `ci.yml` | 跨三平台 unit + 版本校验 + Rust check/fmt/test |
| `tauri-ci.yml` | 桌面 Rust + Android/iOS smoke |
| `tauri-candidate.yml` | 核心：validate → pack-upstream → prepare-runtime → desktop-candidate → mobile candidate |
| `windows-packaged-startup.yml` | 安装 NSIS 后探测 ready.json + Cookie 认证 |
| `upstream-compat.yml` | PR 改 origin/runtime 时验证可复现 |
| `release.yml` | 严格门禁：同 SHA main + CI/candidate 全绿 + 15 资产 + SHA256SUMS |

### 6.4 版本管理

- HarnessDock 版本 = pinned dsh 的基础 SemVer（去掉 prerelease 后缀）
- 10+ 处版本必须一致（`check:versions` 机器校验）
- 禁止 `latest` / 浮动版本进入发布候选
- 当前：channel=beta, prerelease=beta.3

---

## 七、测试体系

| 类型 | 文件数 | 行数 | 覆盖范围 |
|---|---|---|---|
| parity（契约） | 17 | 1327 | tauri-host / runtime-image / gateway-lifecycle / fail-open / shell / tray-quit / installer-icon / reproducible-release |
| e2e（Playwright） | 0 | 0 | **空覆盖**（仅有 node_modules） |

---

## 八、设计亮点

1. **密封 + 离线优先**：安装包内置 Node + dsh + 工具链，首启零下载
2. **image-identity 代际绑定**：sha256 绑定 runtime 与 ready.json，防同机伪造
3. **能力信任边界在 bridge 层**：renderer 不可自提权威，按 WebView label 强制定权
4. **进程无孤儿**：Windows Job Object / Unix 进程组 + StartingProcessGuard
5. **启动 SLO 可观测**：startup_trace 记录阶段链，与源码/诊断隔离
6. **Shell fail-open**：注入失败回退原生窗口控件，不阻止 Harness Web
7. **插件三层防护**：归因 + 隔离 + 持久化
8. **发布可复现**：不可变资产 + SHA256SUMS + 同 SHA 门禁
9. **CSP 最小化**：default-src 'self'，禁用 object/base-uri/frame-ancestors
10. **service 层架构一致性**：native menu/tray 命令与 WebView 走同一队列同序同去重

---

## 九、技术债清单

| 编号 | 问题 | 严重度 | 位置 |
|---|---|---|---|
| TD-01 | `status_snapshot` 隐式副作用（调 `is_alive` 会杀 dead 进程 + 连带 gateway） | 高 | runtime.rs |
| TD-02 | 多处 `spawn_blocking` + `sleep` 轮询而非真异步等待 | 中 | startup.rs / supervisor.rs |
| TD-03 | Host Kernel 全串行（单 channel），慢命令阻塞后续 | 中 | host_kernel.rs |
| TD-04 | `record_event` 用 `app.emit` 但错误被吞，事件丢失不可观测 | 中 | host_kernel.rs |
| TD-05 | 插件恢复靠字符串子串匹配诊断归因，误报/漏报风险 | 中 | runtime.rs |
| TD-06 | quarantine 仅按 dsh_version，跨版本策略失效 | 低 | plugin_quarantine.rs |
| TD-07 | shell bridge `apiVersion:2` vs shell-contract `SHELL_API_VERSION:1` 版本漂移 | 中 | harness_shell.rs / shell-contract.ts |
| TD-08 | compat `update` 浅拷贝不处理数组 | 低 | client.js |
| TD-09 | `normalizeShellCapabilities` 默认"非 false 即 true"，缺失声明默认开放 | 中 | bootstrap |
| TD-10 | e2e 测试空覆盖 | 高 | tests/e2e/ |
| TD-11 | 契约测试对源码字符串敏感，重构易误伤 | 中 | tests/parity/ |
| TD-12 | 本地与 CI 构建逻辑重复（local-client.ps1 vs tauri-candidate） | 中 | scripts/ |
| TD-13 | Windows 仓库内沉淀 87MB node.exe | 低 | runtimes/pack/ |
| TD-14 | updater 已编译但关产物，签名策略未定 | 中 | tauri.conf.json |
| TD-15 | service 层过薄，状态读路径分散导致锁序风险 | 中 | service/ + bridge.rs |
| TD-16 | dsh-web-frontend 为打包产物，源码不在仓库，可审计性弱 | 低 | resources/ |

---

## 十、代码规模

| 层 | 行数 |
|---|---|
| Rust 后端 | 8,131 |
| TypeScript 包 | ~9,100 |
| 契约测试 | 1,327 |
| **总计** | ~18,500 |
