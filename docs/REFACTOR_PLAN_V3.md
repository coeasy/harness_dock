# HarnessDock 架构梳理与重构方案 V3

> 状态：**待评审** · 版本基线 `0.1.2` · 编写日期 2026-09-06
> 上一轮：`docs/REFACTOR_PLAN.md`（R1–R7，已全部落地，提交 `41b4f46` / `47fb5fa`）
> 本文定位：在 R1–R7 机械拆分之上，处理**结构性**问题（双实现、移动端、测试体系、契约守卫）
> 所有结论均附 `文件:行号` 证据；证据由 2026-09-06 全仓只读调研产出

---

## 决策记录（已与用户确认）

| # | 决策项 | 用户选择 | 影响面 |
|---|---|---|---|
| D1 | Rust / TypeScript 双实现终态 | **Rust 为唯一实现，VSCode 改为复用 Tauri 产物** | `packages/bootstrap` + `packages/client-runtime` 降级；新增宿主间通信契约 |
| D2 | 移动端（Android / iOS） | **真正投入打通** | 重写 `mobile.rs`；生成移动骨架；新增移动 capability；CI 四个 job 由占位转实跑 |
| D3 | 测试体系 | **大幅精简 parity，只留跨包契约锁** | 删除对 Rust 内部实现细节的字符串断言；新建跨包契约锁与真实集成测试 |
| D4 | 执行节奏 | **一次性全量落地** | 单批次连续执行 S0→S8，每步设门禁、每 2–3 步一个原子 commit |

> **关于 D4 的风险说明**：本项目"一次性落地"与"可回滚"并不矛盾。本文把一次性拆解为
> **S0→S8 有序序列 + 每步门禁 + 5 个原子提交点**。门禁不过即停，不靠事后回归兜底。
> 移动端（D2）是唯一无法本地闭环验证的模块（需 Android/iOS 工具链），单独设 S7 隔离，
> 允许在真机验证前保持 CI 灰名单。

---

## 第一部分 · 项目全貌梳理

### 1.1 项目定位

HarnessDock 是一个**桌面/移动客户端外壳**，它把上游 `dsh`（一个 Node.js Web 服务）包装成原生应用：

- 客户端负责：下载/校验/启动/托管 `dsh` 运行时进程、提供原生窗口与壳 UI、
  提供 Mobile Gateway 让远程设备接入、自动更新
- `dsh` 负责：真正的业务（Web 应用），通过 HTTP 提供服务
- 宿主与 `dsh` 之间通过一个 `ready.json` 握手文件 + HTTP 健康探测建立契约

**已废弃路线**：Electron（`apps/desktop` 仅剩 3.0 MB 未跟踪构建产物，见 `PROJECT_INTRO.md`）。
当前唯一宿主是 `apps/tauri`（Tauri 2.11.5）。

### 1.2 代码地图（实测数据，排除 node_modules / target / dist）

| 层 | 位置 | 语言 | 文件数 | 行数 | 归属链路 |
|---|---|---|---|---|---|
| Tauri Host（原生壳） | `apps/tauri/src-tauri/src/` | Rust | 56 | 9,600 | **Tauri 主链路** |
| Tauri 前端静态资源 | `apps/tauri/web/` | JS | 3 | ~1,100 | Tauri 主链路 |
| Runtime 托管库 | `packages/client-runtime/src/` | TS | 29 | 4,365 | VSCode 链路 + 打包脚本 |
| 通用宿主引导库 | `packages/bootstrap/src/` | TS | 19 | 3,406 | **仅 VSCode 依赖** |
| Shell UI 插件 | `packages/plugin-harness-shell/` | JS+TS | 3 | ~317 | Tauri 主链路 |
| 嵌入式客户端插件 | `packages/plugin-embedded-client/` | TS | 3 | ~353 | 共享（dsh 侧插件） |
| 文档同步工具 | `packages/docs-sync/src/` | TS | ~7 | ~700 | 发布工具链 |
| VS Code 扩展 | `apps/vscode/src/` | TS | 4 | ~458 | **未构建，从未发布** |
| 构建/校验脚本 | `scripts/` | mjs | 24 | 2,391 | 共享 |
| 契约测试 | `tests/parity/` | TS | 21 | ~89 用例 | **全部为源码文本断言** |
| 端到端测试 | `tests/e2e/` | TS | 1 | 真实 Playwright CDP | **CI 中从不执行** |

**总量约 22,700 行**（不含依赖与构建产物）。

### 1.3 架构分层（Tauri 主链路）

```
┌─ 第 4 层 · 远程接入 ──────────────────────────────────┐
│  gateway.rs（健康检查/配对） · gateway_host/*（内嵌    │
│  loopback HTTP 服务、配对码、票据鉴权、上游代理）      │
└──────────────────────────────────────────────────────┘
┌─ 第 3 层 · WebView 渲染进程 ──────────────────────────┐
│  harness_shell.rs 注入三脚本（顺序敏感）：             │
│    polyfill → __DSH_SHELL_BRIDGE__ (apiVersion 2)     │
│    → shell.js 顶栏 UI                                 │
│  harness_window/*：splash → 导航 → 注入 → 显示        │
└──────────────────────────────────────────────────────┘
┌─ 第 2 层 · dsh Node 运行时（外部子进程）──────────────┐
│  Rust spawn → 注入 DSH_EMBEDDED_READY_FILE 与         │
│  GENERATION / NONCE / IMAGE_IDENTITY 三个安全绑定变量 │
│  → plugin-embedded-client 写 ready.json（fail-closed）│
│  → Rust 校验 6 项后发布 RuntimeLease                  │
└──────────────────────────────────────────────────────┘
┌─ 第 1 层 · Tauri Native Host（Rust）──────────────────┐
│  state.rs 中央 AppState（4 个 Actor）                 │
│  host_kernel.rs 命令队列（快/慢双队列 + 去重）        │
│  reconciler.rs 编排 · capability_broker.rs 鉴权       │
│  runtime_actor / surface_actor / update_actor 状态机  │
│  supervisor.rs 关机协调 · 33 个 tauri::command        │
└──────────────────────────────────────────────────────┘
```

**设计亮点（应当保留）**：
- `host_kernel.rs` 的单一命令队列 + 去重 + 事件序号，让所有控制面（原生菜单、托盘、
  Shell 桥、单实例二次启动）走同一条经过鉴权的路径 —— 这是本仓最值得保留的设计
- `capability_broker.rs` deny-by-default 鉴权 + `host-protocol-v2.json` 单一协议源 + 生成脚本
- `service/snapshot.rs:7-12` 显式文档化的 4 锁顺序（runtime→surface→gateway→update）

---

## 第二部分 · 主体链路贯通性审计

### 2.1 贯通性判定表

| # | 链路 | 判定 | 证据 / 缺口 |
|---|---|---|---|
| 1 | 构建 → 客户端启动 | ✅ **已贯通** | 2026-09-06 实测 `cargo tauri dev` 全通过（图标生成 → 编译 38.5s → 运行 60s） |
| 2 | Runtime spawn → ready.json → lease | ✅ **已贯通** | `runtime/spawn.rs:168-172` 注入 3 变量；`plugin-embedded-client/src/index.ts:46-57` fail-closed 写出；Rust 校验 version/generation/nonce/host/port/pid 六项 |
| 3 | WebView 导航 → Shell 注入 | ✅ **已贯通** | `harness_shell.rs` 三脚本顺序注入；apiVersion 2 三方一致（`shell.js:5` / `harness_shell.rs:180` / `src/index.ts:12`） |
| 4 | Host Protocol 命令面 | ✅ **已贯通** | 33 个 `tauri::command`，9 个 wire 命令经 `capability_broker` 鉴权 |
| 5 | 协议单一源 | ✅ **已贯通** | `protocol/host-protocol-v2.json` → 生成 3 处产物 → CI `--check` 比对 |
| 6 | Gateway 配对与代理 | ⚠️ **实现完整，无自动化验证** | `gateway_host/` 8 个文件中 6 个**零测试**；`handler.rs`（安全敏感路由）无人测 |
| 7 | 自动更新 | ⚠️ **实现完整，运行期降级** | 启动日志 `updater unavailable; continuing without automatic install`；`update.rs` 仅 3 个测试 |
| 8 | Runtime 启动编排 | ⚠️ **实现完整，零测试** | `runtime/start.rs`（多尝试启动循环，最关键的启动路径）**零测试** |
| 9 | 移动端 | ❌ **未接通** | `mobile.rs` 从未被 `mod` 声明；`gen/` 目录**只有 `schemas/`**，移动骨架从未生成 |
| 10 | VS Code 扩展 | ❌ **未构建** | `main: ./dist/extension.cjs` 但 `apps/vscode/dist/` **不存在** |
| 11 | 契约守卫 | ⚠️ **三缺一** | `check-shell-package.mjs:53-82` 校验 3 处，**漏掉 `manifest.json`**（其 `apiVersion: 1` 与运行时全为 2 冲突） |
| 12 | CI 质量门禁 | ⚠️ **有缺口** | 无 clippy；`tests/e2e`（真实 Playwright）**从不执行**；无 cargo-audit / npm audit |

### 2.2 结论：核心功能是否全部实现？

**桌面端（唯一正式产品）：是，主链路已完全贯通。** 上一轮与本次实测均证明
"构建 → 启动 → spawn runtime → 握手 → WebView 导航 → Shell 注入 → 命令面"全程可跑通。

**但"实现完成"≠"可维护"**：
- 主链路的**关键分支**（启动重试编排、Gateway 路由、更新安装）零测试保护
- 同一个领域逻辑存在 **第二套 TypeScript 实现**（3,406 + 4,365 行），且它服务于一个
  **从未构建过**的 VS Code 扩展
- 移动端有 4 个 CI job 在跑，但 Rust 侧移动端代码是死代码、移动骨架不存在

---

## 第三部分 · 不合理点清单

分级：**P0** = 确凿缺陷必须修 · **P1** = 结构性问题 · **P2** = 卫生问题

### P0 · 确凿缺陷

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | `mobile.rs` 是从未被声明的死代码，其 `setup` 返回 `Ok(())`、`handle_run_event` 为空实现 | 全局 grep `mod mobile` 零命中；`mobile.rs:9`、`:13` | 与 D2"打通移动端"直接冲突；任何移动构建都走不到真正逻辑 |
| P0-2 | `manifest.json` 的 `apiVersion: 1`，而运行时全面为 2，且**无人看守** | `manifest.json:6` vs `shell.js:5` / `harness_shell.rs:180` / `src/index.ts:12` | 契约漂移风险；新增 `README.md:5` 仍写"apiVersion = 1"误导 |
| P0-3 | `check-release.mjs` 强制 `release-manifest.json.shell.apiVersion === 1`，与运行时语义冲突 | `check-release.mjs:49`；`release-manifest.json:9` | 同一字段名两个含义，重构时极易误伤 |
| P0-4 | VS Code 扩展 `main` 指向不存在的产物 | `apps/vscode/package.json` `main: ./dist/extension.cjs`；`dist/` 不存在 | 扩展从未构建、从未发布，纯维护负担（7,771 行 TS） |
| P0-5 | 移动 capability 缺失：3 个 capability 全绑定桌面窗口标签 | `harness-shell.json` `windows:["harness"]`、`local-main.json` `["control"]`、`shell-settings.json` `["settings"]` | 移动端无可用能力集，D2 无法落地 |
| P0-6 | `tauri.conf.json` 中 `app.windows` 与顶层 `windows` **重复定义** splash 窗口 | `tauri.conf.json` 两处 `label: "splash"` | 配置重复，改动易漏同步 |
| P0-7 | Node/Rust ready 契约不对称：`DshRuntime` 不转发 3 个安全绑定变量 | `runtime.ts:290-295` 仅设 `READY_FILE`/`VERSION`；真实 writer 需 `GENERATION`/`NONCE`/`IMAGE_IDENTITY`（`plugin-embedded-client/src/index.ts:49-57`） | TS 路径下 `ready.json` 永不被写出，只能靠 stdout 旁路；`ready.ts:4` `writeReadyFile` 成死导出 |
| P0-8 | 生产路径 panic 点 | `runtime_actor.rs:298` `.expect("generation must exist after image binding")`；`gateway_host/commands.rs:117` `.expect("published gateway")` | 状态不变量破例即崩溃 |
| P0-9 | CI 无 clippy、e2e 从不执行、无供应链审计 | grep `clippy` 零命中；`tests/e2e/README.md:41-48` 自述"建议在…中集成"但无人调用 | 质量门禁有实质缺口 |

> **P0 统计**：全仓 `unwrap/expect/panic` 约 87 处，其中**多数在 `#[cfg(test)]` 内**（可接受）。
> 真正需要整改的生产路径 panic 点仅 P0-8 列出的 2 处。

### P1 · 结构性问题

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| P1-1 | **双实现**：Runtime 托管 / 租约 / Gateway / 更新 / 能力协商，Rust 与 TS 各写一遍 | 见 §4.1 对照表，约 7,000 行语义重复 | 行为漂移、双倍维护成本 |
| P1-2 | `revision` 双真相源 | `state.rs` `AtomicU64 revision` 与 `host_kernel.rs:125,140` `KernelPublicState.revision` 各自维护 | 计数不一致导致事件乱序 |
| P1-3 | 跨 actor 快照逻辑重复 | `lifecycle.rs:33-60` 与 `service/snapshot.rs:33-62` 锁顺序与字段几乎逐行相同 | 改一处漏一处 |
| P1-4 | 核心路径零测试 | `runtime/start.rs`、`runtime/control.rs`、`gateway_host/{handler,server,lifecycle,connection,request,http_io,commands}.rs`、`reconciler.rs`、`supervisor.rs`、`bridge.rs`、`state.rs`、`harness_shell.rs`、`process.rs` | 最关键路径无保护 |
| P1-5 | 两个同名导出 `ensureDownloadedRuntime` | `ensure-runtime.ts:13` 与 `fetch-runtime.ts:416` | 命名混淆 |
| P1-6 | 超长函数 | `runtime.ts:181-543` `startImpl` 362 行；`waitForReady` 108 行；`prepare-cli.ts` 425 行命令式脚本 | 不可测、难维护 |
| P1-7 | 孤儿脚本 `scripts/local-client.cmd` | 反向 grep 引用数 = 0 | 死文件 |
| P1-8 | 测试文件混入源码目录 | `packages/client-runtime/src/packed-closure.test.ts` | 违背 src 语义 |
| P1-9 | 魔法数字散落 | 端口 `43137`（`gateway_host/mod.rs:90-91`）、配对 5 分钟（`gateway_host/commands.rs:146`）、启动兜底 50 次/5 次/100ms（`startup.rs:42,59,86`）、关机 30s（`supervisor.rs:27`） | 无集中常量 |
| P1-10 | 硬编码相对路径跨 4 层目录 | `harness_shell.rs:10` `include_str!("../../../../packages/plugin-harness-shell/src/web/shell.js")` | 跨目录层级脆弱 |
| P1-11 | `parity` 测试脆弱性 | 21 个文件 ~89 用例全部 `readFileSync` + `toContain` 字符串匹配（`tests/parity/rust-source.ts:13-30`） | 重构即 false-fail；部分用例甚至断言文档文本 |

### P2 · 卫生问题

| ID | 问题 | 证据 |
|---|---|---|
| P2-1 | 文档体系陈旧：多个文档引用已不存在的路径 | `upgrade-refactor-plan.md:20` 引 `apps/desktop/src/main.ts`（已无源码）；`OPTIMIZATION_PLAN.md:26` 引 `runtime.rs::status_snapshot`（已拆分）；`REFACTOR_PLAN.md:63,168,176` 仍写"runtime.rs 1560 行" |
| P2-2 | 历史文档未归档 | `docs/plan/` 13 个 `v0.2.0-*` 设计稿；`upgrade-refactor-plan-v2.md:4-5` 自称"唯一有效规划"但正文仍引 Electron 路线 |
| P2-3 | 无供应链安全审计 | CI 无 `cargo-audit` / `npm audit` / SBOM |
| P2-4 | `#[cfg(mobile)]` 桩块泛滥 | `harness_window/commands.rs` 中 12+ 处几乎相同的移动端降级块 |

---

## 第四部分 · 重构方案

### 4.1 D1：Rust 为唯一实现，VSCode 复用 Tauri 产物

#### 4.1.1 双实现对照（约 7,000 行语义重复）

| 领域逻辑 | Rust 实现 | TypeScript 实现 | 处置 |
|---|---|---|---|
| Runtime 进程托管 | `runtime/*` + `runtime_actor.rs` ~2,340 行 | `client-runtime/runtime.ts` 792 行 | **保留 Rust**；TS 侧降为测试夹具 |
| Runtime 租约 | `lease.rs` + `RuntimeLease` | `bootstrap/runtime-lease.ts` 322 行 | **保留 Rust**；TS 删除 |
| Mobile Gateway | `gateway.rs` + `gateway_host/*` ~1,750 行 | `bootstrap/gateway.ts` 733 行 | **保留 Rust**；`mobile-gateway-contract.ts` 契约保留 |
| 更新与回滚 | `update.rs` + `update_actor.rs` | `bootstrap/runtime-update.ts` 443 行 | **保留 Rust**；TS 删除 |
| 能力协商 | `capability_broker.rs` 224 行 | `host-capabilities.ts` 111 行 | **保留 Rust**；TS 保留为"宿主能力声明表"单一源 |

#### 4.1.2 目标架构

```
┌─────────────────────────────────────────────────────────┐
│  apps/vscode  (瘦客户端，不再自管 runtime)               │
│    extension.ts                                          │
│      ├─ 探测已安装的 HarnessDock 客户端                  │
│      ├─ 未运行 → spawn 客户端可执行文件                  │
│      ├─ 已运行 → 经 loopback Gateway 查询 runtime 状态   │
│      └─ webview iframe 加载 runtime URL                  │
└──────────────────────┬──────────────────────────────────┘
                       │ 新增：宿主间通信契约（见 4.1.3）
┌──────────────────────▼──────────────────────────────────┐
│  apps/tauri  (Rust 唯一实现，已是完整产品)               │
│    runtime/* · gateway_host/* · update.rs                │
│    NEW: 本地控制端点 GET /api/host/status（loopback）    │
└─────────────────────────────────────────────────────────┘
```

#### 4.1.3 新增：宿主间通信契约（关键新建件）

当前**不存在任何深链 / URL scheme**（`grep deep-link|url-scheme` 在 `src-tauri/src/` 零命中），
这是 VSCode 复用 Tauri 产物的最大空白。分两期：

**V1（本轮落地，务实可用）**

| 项 | 内容 |
|---|---|
| 端点 | `GET http://127.0.0.1:43137/api/host/status`（复用 Gateway 已有端口与 loopback 约束） |
| 鉴权 | 复用 `gateway_host` 既有票据机制；未配对请求仅返回 `{ running: bool }` 最小集 |
| 响应 | `{ running: bool, lease: { origin, dshVersion } \| null, generation: u64 \| null }` |
| 实现位置 | `gateway_host/handler.rs` 新增路由；`gateway_host/types.rs` 新增响应类型 |
| 消费方 | `apps/vscode/src/` 新增 `host-bridge.ts`，轮询该端点 |
| 降级 | 端点不可达 → VSCode 侧 spawn 客户端可执行文件，退化为"启动 + 等待" |

**V2（后续迭代，不在本轮）**

注册 `harnessdock://` URL scheme（Windows 注册表 / macOS Info.plist / Linux desktop entry），
实现 `open` / `focus` / `gateway-pair` 三个动作，支持反向深链。

#### 4.1.4 处置动作

| 动作 | 目标 | 说明 |
|---|---|---|
| 保留并强化 | `packages/plugin-embedded-client` | 它是 dsh 侧插件，Tauri 链路依赖它写 `ready.json`，**不可删** |
| 保留 | `packages/bootstrap/src/host-capabilities.ts` | 升级为"宿主能力声明"单一源，Rust 侧生成对照常量 |
| 保留 | `packages/bootstrap/src/mobile-gateway-contract.ts` | Gateway 契约的 TS 侧镜像，D2 移动端需要 |
| 删除 | `bootstrap/{runtime-lease,runtime-update,runtime-provider,local-runtime-provider,rollback}.ts` | 与 Rust 重复的领域实现 |
| 降级 | `packages/client-runtime` | 仅保留 `prepare:runtime` 打包管线（`package.json:34` 依赖它），`runtime.ts` 的 `DshRuntime` 标注 `@deprecated` 仅供测试 |
| 重写 | `apps/vscode/src/extension.ts` | 去掉 `bootstrapRuntime` 自管路径，改走 `host-bridge.ts` |
| 删除 | `packages/client-runtime/src/ready.ts` 的 `writeReadyFile` | 死导出（P0-7） |

### 4.2 D2：真正打通移动端

#### 4.2.1 先决性事实（决定了移动端的正确形态）

| 事实 | 证据 | 结论 |
|---|---|---|
| 移动宿主**设计上就是 remote-only** | `bootstrap/src/host-capabilities.ts`：`TAURI_IOS_HOST_PROFILE.capabilities.runtimes = ['remote']`（`TAURI_ANDROID_HOST_PROFILE` 同） | **移动端不应本地 spawn Node 进程** |
| Android/iOS 沙箱不允许 spawn 外部可执行进程 | 平台约束 | 佐证上一条：本地 runtime 在移动端技术上不可行 |
| 移动骨架从未生成 | `apps/tauri/src-tauri/gen/` 下**只有 `schemas/`**，无 `gen/android` / `gen/apple` | 需从 `tauri android init` / `tauri ios init` 起步 |
| Rust 侧移动 crate-type 已就绪 | `Cargo.toml` `[lib] crate-type = ["staticlib","cdylib","rlib"]` | ✅ 无需改 crate-type |
| 移动目标缺少插件依赖 | `Cargo.toml` 仅 desktop target 声明 `tauri-plugin-single-instance` / `tauri-plugin-updater` | 移动端需按需补依赖 |
| 移动能力集不存在 | 3 个 capability 全绑定桌面窗口标签 | 必须新建（P0-5） |

> **重要方向修正**："打通移动端"的正确形态**不是**把桌面那套本地 runtime 搬到手机上
> （技术上不可行、设计上也不该），而是：**移动宿主作为远程客户端，通过 Gateway 配对
> 接入桌面端（或远程服务器）上已运行的 runtime**。这与 `host-capabilities.ts` 的既有设计一致。

#### 4.2.2 目标架构（移动端）

```
┌─ 移动宿主（Android / iOS）──────────────────────────┐
│  mobile.rs（重写，不再是死代码）                     │
│    ├─ 启动即展示配对界面（WebView 加载配对页）       │
│    ├─ 调用 gateway.rs::pair_gateway（已有实现）      │
│    ├─ 获得 connect_url + 一次性 token                │
│    └─ WebView 导航至远程 runtime，注入 Shell Bridge  │
└───────────────┬─────────────────────────────────────┘
                │ HTTPS + 票据鉴权
┌───────────────▼─────────────────────────────────────┐
│  桌面端 gateway_host/（已实现，需补移动路径测试）    │
│    POST /api/harnessdock/pair → connect_url          │
│    代理转发 → 127.0.0.1:<runtime port>               │
└─────────────────────────────────────────────────────┘
```

#### 4.2.3 处置动作

| # | 动作 | 说明 |
|---|---|---|
| M1 | 重写 `mobile.rs` | 由"空桩"改为真实移动入口：配对流程 + WebView 装载 + Shell 注入（可复用 `harness_shell.rs` 注入逻辑） |
| M2 | `lib.rs` 声明 `#[cfg(mobile)] mod mobile;` | 目前**完全没有** `mod mobile` 声明（`lib.rs:7-8` 只有 `#[cfg(not(mobile))] mod desktop;`） |
| M3 | 生成移动骨架 | `pnpm tauri android init` / `tauri ios init`，产出 `gen/android`、`gen/apple` 并提交 |
| M4 | 新建 `capabilities/mobile-remote.json` | 绑定移动窗口标签，授予 `platform_info`/`gateway_health`/`pair_gateway` + `core:webview:allow-*` 最小集（**不**给 `core:default`） |
| M5 | 收敛 `#[cfg(mobile)]` 桩块 | `harness_window/commands.rs` 的 12+ 处重复降级块，改用宏或 trait 收敛（P2-4） |
| M6 | `Cargo.toml` 按需补移动依赖 | 仅引入移动端实际用到的插件 |
| M7 | 去重 splash 窗口定义 | 删除 `tauri.conf.json` 中重复的顶层 `windows` 段（P0-6） |
| M8 | CI 四个 job 由占位转实跑 | `android-smoke`/`ios-smoke`/`android-candidate`/`ios-candidate` 增加真实构建与冒烟；在真机验证完成前允许 `continue-on-error` 灰名单 |

### 4.3 D3：精简 parity，只留跨包契约锁

#### 4.3.1 现状与判定

`tests/parity/` 21 个文件 ~89 用例，**全部**是 `readFileSync` 读取 `.rs`/`.ts`/`.json` 后
做 `toContain` / `not.toContain` 字符串匹配（机制见 `tests/parity/rust-source.ts:13-30`）。
部分用例甚至断言**文档文本**（`v020-core-contract.test.ts:92-98` 校验 `README.md` 含特定字符串）。

判定：这类测试在 R1–R7 机械拆分期间起到"防止拆分跑偏"的作用，但作为长期资产是**净负债**——
它把实现细节（某文件含某字符串）固化为契约，与"可重构性"直接冲突。

#### 4.3.2 三分法处置

| 类别 | 判定标准 | 处置 | 涉及文件（估） |
|---|---|---|---|
| **A. 保留并加固** | 真正的跨语言/跨包契约锁 | 改为**解析结构化数据**而非 grep 文本（读 JSON/生成常量/真实 import 校验） | `shell-contract-lockstep`、`host-protocol` 同步、`v020-round1-host-boundary` |
| **B. 迁移** | 断言的是可被真实行为验证的性质 | 改写为 Rust 集成测试 / TS 单元行为测试 | `loopback-contract`、`gateway-lifecycle`、`tauri-shell-fail-open` |
| **C. 删除** | 断言 Rust 内部实现细节或文档文本 | 直接删除，不做迁移 | `v020-core-contract`（含文档断言）、`host-core-architecture`、`startup-web-chain-regression` 中纯结构断言部分 |

#### 4.3.3 保留清单（A 类，改造后）

契约锁必须满足"**改实现不变契约则测试不红**"：

| 契约 | 原实现 | 改造后 |
|---|---|---|
| Host Protocol 同步 | grep `host_protocol_generated.rs` | 解析 JSON + 解析生成的常量，比对命令名/能力映射集合（顺序无关） |
| Shell apiVersion 三方一致 | grep 三个文件含 `apiVersion: 2` | 真实 import `shell-contract.ts` 的 `SHELL_API_VERSION`，读 `manifest.json` 与生成的桥脚本常量，三方数值相等 |
| **新增**：`manifest.json` 纳入校验 | 无（P0-2 漏守） | 加入三方校验，`apiVersion` 必须为 2 |
| **新增**：`release-manifest.json` 语义分离 | `check-release.mjs:49` 强制为 1 | 字段改名为 `shellApiVersion` 并纳入锁，消除与运行时 `apiVersion` 的语义冲突（P0-3） |
| Runtime ready 契约 | 无 | 新增：断言 Rust `spawn.rs` 注入的 env 名集合 == `plugin-embedded-client` 读取的 env 名集合（防 P0-7 复发） |

#### 4.3.4 补真实测试（B 类迁移目标 + P1-4 缺口）

Rust 侧新增集成测试，优先覆盖当前零测试的关键路径：

| 优先级 | 模块 | 测试内容 |
|---|---|---|
| 1 | `runtime/start.rs` | 多尝试启动循环：成功/首次失败重试/连续失败兜底/超时 |
| 2 | `gateway_host/handler.rs` | 路由匹配、loopback 约束、票据过期、上游代理错误传播 |
| 3 | `reconciler.rs` | `HostCommand` 分发正确性、`authorize_local` 拒绝路径 |
| 4 | `bridge.rs` | subject 信任派生、未授权 subject 拒绝 |
| 5 | `supervisor.rs` | 关机时序、进程树回收 |
| 6 | `runtime/control.rs` | Runtime 命令与生命周期助手 |
| 7 | `gateway_host/{server,lifecycle,connection,request}.rs` | HTTP 解析、连接生命周期 |

### 4.4 D4：一次性全量落地的执行序列

一次性 = **一个工作批次内连续执行 S0→S8**；可回滚 = 每步设门禁、每 2–3 步一个原子 commit。

| 步骤 | 内容 | 门禁（不过即停） | 提交点 |
|---|---|---|---|
| **S0** | 建立基线快照：记录 `cargo test --lib`、`npx vitest run`、`check-*` 全部输出 | 基线数字入库 | — |
| **S1** | P0 止血：修 `manifest.json` apiVersion=1、分离 `release-manifest` 字段语义、删孤儿 `local-client.cmd`、修 `tauri.conf.json` 重复 windows、修 P0-8 两处 panic | 全量测试不劣化 | **C1** |
| **S2** | 契约守卫加固：重写 A 类契约锁为结构化解析、纳入 `manifest.json`、新增 ready env 契约锁 | 故意改坏 JSON/常量后测试**必须**红 | — |
| **S3** | parity 三分法：删除 C 类、迁移 B 类到 Rust 集成测试 | 用例数下降但覆盖率不降；`cargo test` 数上升 | **C2** |
| **S4** | 消除双实现：删 `bootstrap` 重复模块、`client-runtime` 降级标注、删 `writeReadyFile` 死导出 | `cargo check` 0 error；`pnpm -r test` 通过 | — |
| **S5** | VSCode 改造：新增 `gateway_host` 的 `/api/host/status` 端点 + `apps/vscode/src/host-bridge.ts` + 重写 `extension.ts` | 端点手工 curl 验证；扩展 `bundle` 产出 `dist/` | **C3** |
| **S6** | P1 结构项：合并 `revision` 双真相源、统一 `lifecycle`/`snapshot` 快照、拆 `startImpl`、抽常量、移 `packed-closure.test.ts` | 行为不变（`cargo test` + vitest 全绿） | — |
| **S7** | 移动端：M1–M8 全部动作 | `cargo check --target aarch64-linux-android` 通过；`gen/` 骨架提交；CI 四 job 转实跑 | **C4** |
| **S8** | CI 与文档：加 clippy、e2e 接入 `windows-packaged-startup`、`cargo-audit`、归档历史文档、回写 `REFACTOR_PLAN.md` 现状段 | CI 全绿 | **C5** |

**关键顺序约束**：
- S2 必须在 S3 之前（先建好新契约锁，再删旧断言，否则中途失去保护）
- S4 必须在 S5 之前（先删重复实现，再写新的 VSCode 消费方，避免又写一份）
- S7 可与其他步骤并行准备，但**必须最后合并**（移动骨架生成会改动 `tauri.conf.json` 与 `Cargo.toml`）

---

## 第五部分 · 风险与回滚

| 风险 | 等级 | 触发条件 | 缓解 |
|---|---|---|---|
| 移动端无法本地闭环验证 | **高** | S7 需 Android NDK / Xcode 工具链 | S7 独立提交；CI 四 job 初期 `continue-on-error`；真机验证前不宣布移动端"打通" |
| 删 `bootstrap` 模块破坏 VSCode 类型检查 | 中 | S4 | S4 后先跑 `pnpm -r test` 与 `tsc --noEmit`；S5 紧跟修 |
| parity 精简后失去保护 | 中 | S3 | S2 先建新锁并用"故意改坏必须红"验证 |
| 移动骨架生成改动 `tauri.conf.json` 与桌面配置冲突 | 中 | S7 | S1 已去重 windows；S7 前备份 `tauri.conf.json` |
| 一次性落地导致回滚粒度粗 | 中 | 全程 | 5 个原子提交点（C1–C5），任一失败回滚到上一个点 |
| 新增 `/api/host/status` 扩大攻击面 | 中 | S5 | 仅 loopback 绑定；未配对请求只返回 `running` 布尔；无敏感字段 |
| 拆 `startImpl`（362 行）引入回归 | 低 | S6 | 先补 `runtime/start.rs` 与相关路径集成测试，再拆 |

## 第六部分 · 验收标准

| 类别 | 指标 | 目标 |
|---|---|---|
| 编译 | `cargo check --offline` | 0 error，warning 数不增加（当前 6） |
| Rust 测试 | `cargo test --lib` 用例数 | 84 → **≥ 140**（新增 7 个关键模块集成测试） |
| TS 测试 | `npx vitest run` | 通过；parity 用例数 89 → **≤ 30**（仅 A 类契约锁） |
| 契约锁 | 故意改坏 `host-protocol-v2.json` / `manifest.json` / 生成常量 | 测试**必须**失败 |
| VSCode | `pnpm --filter dsh-client bundle` | 产出 `dist/extension.cjs`（当前不存在） |
| 宿主桥 | `curl http://127.0.0.1:43137/api/host/status` | 返回合法 JSON，未配对时仅含 `running` |
| 移动端 | `cargo check --target aarch64-linux-android` | 通过；`gen/android` 存在并提交 |
| CI | 新增 clippy + e2e + audit 三个 job | 全绿；移动端 job 灰名单标注 |
| 启动链路 | `cargo tauri dev` | 与基线一致：编译 → 启动 → 运行 60s 无致命错误 |
| 死代码 | `mobile.rs` 被 `mod` 声明且含真实逻辑 | `grep "mod mobile"` 命中 |

## 附录 · 调研证据索引

| 主题 | 关键文件 |
|---|---|
| Host 架构 | `apps/tauri/src-tauri/src/{state,host_kernel,reconciler,capability_broker,bridge}.rs` |
| Runtime 托管 | `apps/tauri/src-tauri/src/runtime/{mod,spawn,start,control,config,types,paths}.rs` |
| Gateway | `apps/tauri/src-tauri/src/gateway.rs` + `gateway_host/*`（8 文件） |
| 契约生成 | `protocol/host-protocol-v2.json` → `scripts/generate-host-protocol.mjs` → 3 处产物 |
| 契约校验 | `scripts/check-shell-package.mjs`、`scripts/check-release.mjs`、`scripts/check-versions.mjs` |
| TS 侧双实现 | `packages/bootstrap/src/*`（3,406 行）、`packages/client-runtime/src/*`（4,365 行） |
| 移动宿主声明 | `packages/bootstrap/src/host-capabilities.ts`（`runtimes: ['remote']`） |
| CI | `.github/workflows/{ci,tauri-ci,tauri-candidate,windows-packaged-startup,release,upstream-compat}.yml` |
