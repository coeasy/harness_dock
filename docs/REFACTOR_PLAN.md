# HarnessDock 模块化重构方案（第二轮）

> 生成时间：2026-09-06
> 前置文档：[`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md)（架构全貌）、[`OPTIMIZATION_PLAN.md`](./OPTIMIZATION_PLAN.md)（第一轮稳定性重构，已执行）
> 本文定位：**结构重构**。第一轮解决"行为正确性"，本轮解决"结构可维护性"——拆分巨型模块、消除跨模块重复、收敛跨层契约漂移。

---

## 第一部分 · 项目现状梳理

### 1.1 项目定位与主要功能

HarnessDock 是 **DeepSeek Harness（dsh）的官方桌面客户端**：把 dsh 的 Node.js runtime 与 Harness Web 前端打包进一个 Tauri 2.x 原生壳，用户无需手工安装 Node、配置端口或管理网关。

| 能力域 | 具体功能 | 实现位置 |
|---|---|---|
| **Runtime 托管** | 内嵌 Node 运行时启动 dsh 服务、分配随机端口、注入一次性 token、健康检查、崩溃自动重启 | `runtime.rs` / `runtime_actor.rs` / `process.rs` |
| **窗口与 Surface** | 主窗口 Harness WebView、splash 启动屏、control 恢复面板、设置窗口、原生标题栏与最小化/最大化 | `harness_window.rs` / `surface_actor.rs` |
| **Host Protocol v2** | 单一 `host_execute` 命令承载 9 个 wire 命令，配 16 项能力代理 + LRU 去重 + 事件流 | `host_kernel.rs` / `host_protocol*.rs` / `capability_broker.rs` / `reconciler.rs` |
| **Gateway 网关** | 内置 HTTP 网关，支持设备配对（pairing code）、票据鉴权、上游代理、限流、连接回收 | `gateway_host.rs` / `gateway.rs` |
| **Shell 插件** | 通过 `initialization_script` 注入 WebView 的顶栏 shell（shadow DOM），提供状态指示、菜单、toast、设置入口 | `harness_shell.rs` / `packages/plugin-harness-shell` |
| **插件隔离** | 启动诊断归因失败插件 → 写入隔离清单 → 安全模式重启，跨版本策略持久化 | `plugin_quarantine.rs` / `diagnostic.rs` |
| **更新与发布** | 应用内更新检查/安装、release manifest 版本对齐、NSIS 安装包 | `update.rs` / `update_actor.rs` |
| **运维可观测** | 启动阶段追踪（startup_trace）、公开诊断、崩溃恢复面板、性能报告 | `startup_trace.rs` / `tray.rs` |

### 1.2 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  WebView2 (Chromium 113)  ←  POLYFILL → BRIDGE → SHELL_WEB   │
│  dsh-web-frontend  +  shell.js (shadow DOM)                  │
└────────────────────────┬────────────────────────────────────┘
                         │ window.__DSH_SHELL_BRIDGE__ (apiVersion 2)
                         │ tauri invoke / host_execute
┌────────────────────────┴────────────────────────────────────┐
│  Tauri Host (Rust, 8,716 行)                                 │
│  ┌──────────┬──────────┬──────────┬──────────┬────────────┐ │
│  │ bridge   │ host_    │ runtime  │ gateway_ │ harness_   │ │
│  │ (命令层) │ kernel   │ (生命周期)│ host     │ window     │ │
│  └────┬─────┴────┬─────┴────┬─────┴────┬─────┴─────┬──────┘ │
│       │          │          │          │           │        │
│  ┌────┴──────────┴──────────┴──────────┴───────────┴──────┐ │
│  │  AppState（runtime_actor / surface_actor / gateway /    │ │
│  │  host_kernel / starting_processes / quitting）          │ │
│  └─────────────────────────────────────────────────────────┘ │
└────────────────────────┬────────────────────────────────────┘
                         │ stdio / HTTP / Job Object
┌────────────────────────┴────────────────────────────────────┐
│  dsh Node Runtime（内嵌 node.exe + @deepseek-ai/dsh-*）       │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向不变量**（重构必须保持）：
1. `bridge`（命令层）→ 可调用任意业务模块；反之禁止。
2. `service::snapshot`（只读快照层）是唯一被允许按 `runtime → surface → gateway` 顺序取锁的地方。
3. `runtime_actor` 不反向依赖 `runtime` 的业务逻辑（当前 `runtime_actor.rs:7` 已违反，见 R3）。
4. Web 侧只能经 `host_execute` 或 bridge 白名单命令触达原生，禁止新增旁路。

### 1.3 实现细节速览

| 模块 | 行数 | 关键实现 |
|---|---|---|
| `runtime.rs` | 1560 | spawn dsh → 轮询 ready → 解析 config dump → 失败时诊断归因插件并安全模式重启；`WorkDirGuard` RAII 管理临时工作目录 |
| `gateway_host.rs` | 1533 | 手写 HTTP/1.1 解析器（`read_request` 96 行）+ accept 循环 + pairing code 鉴权 + 上游代理 + 限流与注册回收 |
| `harness_window.rs` | 850 | 窗口创建/导航守卫（只放行当前 lease 的 origin 且带 token 的 URL）+ 看门狗 + 重启编排 |
| `host_kernel.rs` | 395 | 单 actor + **双队列**（fast/slow）+ 256 窗口 LRU 去重 + 事件序列发布 |
| `capability_broker.rs` | 224 | 16 项能力按 subject（Web / Native / Plugin / Gateway）× surface × origin × generation 四维判定 |
| `plugin_quarantine.rs` | 235 | schema v2 + `dsh_base_version`：同基础 SemVer 预发布升级沿用隔离，跨基础版本失效 |
| `diagnostic.rs` | 260 | 结构化指纹（ModuleName / Syntax / Permission / PortInUse），结构化命中优先、字符串匹配兜底 |
| `service/snapshot.rs` | 78 | 统一只读快照层，文档化锁序 |
| 其余 17 个模块 | 2611 | 启动编排、托盘、更新、平台适配、协议生成等 |

**体量问题**：三个巨型模块（`runtime` 1560 + `gateway_host` 1533 + `harness_window` 850 = 3,943 行）占比 **45.2%**，是本次重构的首要目标。

---

## 第二部分 · 重构目标与验收基线

### 2.1 目标

| 目标 | 度量 |
|---|---|
| 单文件复杂度 | 无任何 `.rs` 文件 > 900 行；拆分后各子模块 < 450 行 |
| 消除重复 | `poisoned` 语义字符串从 13 处 → 1 处；跨模块复制粘贴函数 → 0 |
| 契约一致 | `SHELL_COMMANDS` / `BRIDGE` 白名单 / `capability_broker` / `protocol` 四方由测试强制同步 |
| 依赖方向 | `runtime_actor` 不再反向依赖 `runtime` 业务层 |
| 错误可诊断 | 新建 `error.rs` 承载公共错误语义，锁中毒统一处理 |
| 可测试性 | 纯函数单测新增 ≥ 20 个（`config` 解析 / URL 校验 / 契约同步） |

### 2.2 验收基线（重构前后必须保持一致）

- `cargo check --offline` 零错误
- `cargo test --offline --lib` 全绿（当前基线 **47 passed**）
- `vitest run` 全绿（当前基线 **297 passed / 1 skipped**）
- `node scripts/check-shell-package.mjs` LOCKSTEP OK
- `tests/e2e` Playwright 冒烟 1 passed
- **行为零变更**：不新增/删除任何用户可见功能（契约修复除外，见 R2 说明）

---

## 第三部分 · 重构项（R1–R7）

### R1 · 提取公共层（消除跨模块重复）

**问题证据**

| 重复项 | 位置 | 次数 |
|---|---|---|
| 锁中毒字符串 | `RuntimeActor 状态锁已损坏。`(runtime.rs ×5)、`GatewayActor 状态锁已损坏。`(gateway_host.rs ×6)、`SurfaceActor 状态锁已损坏。`(harness_window.rs ×2) | **13** |
| `secure_random` 同源实现 | `gateway_host.rs:1121-1141` 与 `runtime_actor.rs:410` | 2 |
| lease 获取包装 | `gateway_host.rs:1171-1177`（`live_lease`）与 `harness_window.rs:163-171`（`current_lease`）结构完全相同 | 2 |
| loopback URL 校验 | `gateway_host.rs:284` 与 `harness_window.rs:132` 同模式 | 2 |
| `String` 作为错误类型 | `gateway_host.rs` ≥27 处 `map_err`，`harness_window.rs` 12 处 | **39** |
| 锁获取样板 | `runtime.rs` 内 `match …lock() { Ok => , Err(p) => p.into_inner() }` | 11 |

**方案**

1. 新建 `src/error.rs`
   ```rust
   /// 锁中毒统一处理：保留数据、记录原因，不再散落 13 处中文字符串。
   pub(crate) fn poisoned(actor: &str) -> String { format!("{actor} 状态锁已损坏。") }
   #[macro_export] macro_rules! lock { ($m:expr, $actor:literal) => { … } }
   pub(crate) trait LockRecover<T> { fn recover(self, actor: &str) -> T; }  // MutexGuard 扩展
   #[derive(Debug, thiserror::Error)] pub(crate) enum HostError { … }
   ```
   `thiserror 1.0.69` **已在 `Cargo.lock` 且已缓存**，可离线加入 `[dependencies]`，不引入新依赖树。
2. 新建 `src/crypto.rs`：`secure_random` / `random_hex` / `pairing_code` 从 `gateway_host.rs` + `runtime_actor.rs` 合并而来。
3. 新建 `src/lease.rs`：`require_live_lease(app)` / `require_current_lease(app)`，统一错误文案。
4. `src/util.rs`：`validated_loopback_url`（合并两处 URL 校验）、`rfc3339` / `civil_from_days`（时间格式化）。
5. `runtime.rs` 内 11 处锁样板收敛为 `lock!(state.runtime_actor, "RuntimeActor")`。

**风险**：低。纯提取，无行为变更。**验收**：`grep -c '状态锁已损坏' src/*.rs` 从 13 → 1。

---

### R2 · 跨层契约收敛（功能缺口修复）

**四方契约真相表**（实测）

| `SHELL_COMMANDS` | protocol wire | tauri 命令 | BRIDGE 接线 | 判定 |
|---|---|---|---|---|
| `window.minimize` / `toggleMaximize` / `state` / `close` | — | ✅ 4 个 | ✅ directWindowMap | 正常（本地 UI 旁路，有意设计） |
| `web.reload` / `web.restart` / `runtime.safe-mode` / `gateway.manage` / `diagnostics.open` | ✅ 5 | 经 host_execute | ✅ hostCommandMap | 正常 |
| `runtime.clear-quarantine` | ✅ `clear-quarantine` | ✅ `runtime_clear_plugin_quarantine` | ❌ **缺失** | **功能缺口 → 补接线** |
| `app.update.install` | ✅ `install-update` | ✅ `update_install` | ❌ **缺失** | **功能缺口 → 补接线** |
| `app.quit` | ✅ `quit` | ❌ 无对应命令 | ❌ 缺失 | **→ 移除**（无 tauri 命令可映射） |
| `app.update.check` | ❌ 无 wire | ✅ `update_check` | ❌ 缺失 | **孤儿声明 → 移除** |

另有漂移：`packages/plugin-harness-shell/src/index.ts:7` 的 `apiVersion = 1`，而 `shell-contract.ts:12` 与 `harness_shell.rs:172` 均为 **2**。`check-shell-package.mjs` 只校验后两者，未覆盖 `index.ts`。

**方案**

1. `BRIDGE_SCRIPT` 的 `hostCommandMap` 补两项：
   - `'runtime.clear-quarantine': 'clear-quarantine'`
   - `'app.update.install': 'install-update'`
   （走 `host_execute`，与既有 5 项同构；不改能力模型）
2. `SHELL_COMMANDS` 移除 `app.quit`、`app.update.check`（无实现可映射的孤儿声明），同步更新 `plugin-harness-shell/index.ts` 的命令列表与 `capability_broker`。
3. `index.ts` 的 `apiVersion` 改 **2**，并把 `index.ts` 纳入 `check-shell-package.mjs` 看守范围（三方 apiVersion 强制一致）。
4. 新增 parity 测试 `tests/parity/shell-contract-lockstep.test.ts`：
   - 断言 `BRIDGE` 白名单 ∪ `window.*` == `SHELL_COMMANDS`
   - 断言每个 `SHELL_COMMANDS` 成员在 `capability_broker` 中都有显式判定（deny-by-default 已生效）
   - 断言 `index.ts` / `shell-contract.ts` / `harness_shell.rs` 三处 apiVersion 相等

**风险**：低-中。`app.quit` / `app.update.check` 从未被接线，移除不影响任何现有行为；新增两项接线是**新增能力**，需在 e2e 中确认不引入错误。

---

### R3 · 拆分 `runtime.rs`（1560 → 6 个子模块）

| 新文件 | 来源行 | 内容 |
|---|---|---|
| `runtime/types.rs` | 22–187 | `RuntimeStatus` / `ReadyInfo` / `OriginInfo` / `RuntimeManifest` / `RuntimeImage` / `ConfigDumpRow` / `AttemptFailure` / `RuntimeProcess` + `Drop` / `phase_status` |
| `runtime/paths.rs` | 189–276, 775–785 | `resource_path` / `quarantine_path` / `node_path` / `dsh_path` / `load_runtime_image` / `work_dir` / `dsh_home_path` |
| `runtime/config.rs` | 311–475, 787–823 | config dump 解析、官方源判定、恢复候选、指纹归因、`recovery_plan` / `recovery_patch` |
| `runtime/spawn.rs` | 477–957 | `WorkDirGuard` / `validated_ready` / `read_attempt_logs` / `public_diagnostic` / `spawn_runtime` / `wait_for_ready` / `dump_config` / `launch_attempt` / `safe_profile` |
| `runtime/start.rs` | 959–1157 | `start_blocking`（184 行，拆后仍为最大函数，见 R7）/ `lease_from_process` |
| `runtime/control.rs` | 1159–1478 | lease 查询、快照、start/stop/restart/清隔离等命令实现 |
| `runtime/mod.rs` | — | `pub use` 对外符号，保持 `crate::runtime::*` 调用方零改动 |

**附带修复**：`runtime_actor.rs:7` 的 `use crate::runtime::RuntimeProcess` 反向依赖 → 类型下沉到 `runtime/types.rs` 后，`runtime_actor` 改为 `use crate::runtime::types::RuntimeProcess`，依赖方向变为 `runtime_actor → runtime::types`（纯类型，无业务逻辑），符合不变量 3。

**风险**：中。纯机械搬运，但涉及 1,560 行。**验收**：`cargo check` 零错误 + 47 测试全绿 + 调用方无需改动。

---

### R4 · 拆分 `gateway_host.rs`（1533 → 8 个子模块）

保持模块名 `gateway_host`（与已有的 `gateway.rs` 区分），改为目录 `src/gateway_host/`：

| 新文件 | 来源行 | 内容 |
|---|---|---|
| `types.rs` | 19–142, 521–526 | 全部数据结构 |
| `lifecycle.rs` | 144–208, 317–358, 1405–1436 | Actor 状态机 / spawn / stop 锁 |
| `connection.rs` | 360–519 | accept 循环、连接注册与回收 |
| `request.rs` | 521–685 | HTTP 请求解析与校验 |
| `handler.rs` | 687–1074 | 路由与业务处理器 |
| `http_io.rs` | 1076–1106 | `write_json` / `write_status` |
| `commands.rs` | 1171–1403 | tauri 命令 + `ensure_current_runtime` |
| `mod.rs` | — | re-export（`crypto` 移入 R1 的 `src/crypto.rs`） |

**注意**：`bridge.rs` 的 `handler!` 宏引用 `$crate::gateway_host::gateway_host_status` 等，re-export 后保持不变。

**风险**：中。**验收**：同上 + gateway 单测（9 个）全绿。

---

### R5 · 拆分 `harness_window.rs`（850 → 4 个子模块）

避免过度拆分（审查建议 7 个，实际按语义合并为 4 个更合理）：

| 新文件 | 来源行 | 内容 |
|---|---|---|
| `surface/splash.rs` | 13–111 | splash 显隐 + control surface + 启动恢复面板 |
| `surface/navigation.rs` | 114–343 | URL 校验、导航守卫、lease 匹配、看门狗、`SurfaceOperationGuard` |
| `surface/window.rs` | 346–663 | 窗口创建/关闭/重载/重启编排 |
| `surface/commands.rs` | 665–816 | 窗口状态、设置窗口等 tauri 命令 |
| `surface/mod.rs` | — | re-export |

**风险**：中。**验收**：同上 + 3 个窗口单测全绿。

---

### R6 · 构建脚本去重

**问题证据**（grep 全仓库引用）

| 脚本 | 引用情况 | 判定 |
|---|---|---|
| `build.mjs` | `package.json:24,35` | **唯一真相源，保留** |
| `build.sh` / `build.bat` | `tests/parity/local-build-contract.test.ts:12-13,80` 同时校验三者 | 与 `build.mjs` 三入口重叠 |
| `build-pipeline.mjs` | **零调用**（仅自身注释） | 死脚本 |
| `dev-dsh.sh` / `dev-dsh.bat` | **零调用**（`package.json:38` 用的是 `dev-dsh.mjs`） | 死脚本 |
| `regenerate-icon.ps1` | **零调用**（已被 `apps/tauri/scripts/normalize-icon.mjs` 取代） | 死脚本 |

**方案**

1. 删除 `build-pipeline.mjs`（其价值——cargo check + smoke 编排——已由 `local-client.ps1` 覆盖，保留两份只会漂移）。
2. 删除 `dev-dsh.sh` / `dev-dsh.bat` / `regenerate-icon.ps1`。
3. `build.sh` / `build.bat` 降级为 `build.mjs` 的**薄壳**（各 ≤ 10 行，仅做 Node 版本检查后转发），消除逻辑重复；同步更新 `local-build-contract.test.ts` 的断言。

**风险**：低。**验收**：`pnpm tauri:build --help` 与 `bash scripts/build.sh --help` 行为一致；parity 测试全绿。

---

### R7 · 测试补齐

**新增 Rust 单测**（纯函数、无需 mock，≥ 20 个）

| 目标 | 用例 |
|---|---|
| `runtime/config.rs` | `decode_yaml_scalar`（引号/转义/布尔/数字/空值）、`is_official_source`、`is_official_row`、`basename`、`row_tokens`、`recovery_patch_ids`、`recovery_patch`、`user_patch_rows` |
| `util.rs` | `validated_loopback_url`（127.0.0.0/8、::1、localhost、非 loopback 拒绝、非 http scheme 拒绝） |
| `crypto.rs` | `random_hex` 长度与字符集、`pairing_code` 熵校验 |
| `error.rs` | `poisoned()` 文案一致性、锁中毒恢复返回数据 |

**新增 TS parity 测试**

- `shell-contract-lockstep.test.ts`（见 R2 第 4 点）

**风险**：低。**验收**：`cargo test --lib` 从 47 → ≥ 67 passed；vitest 新增 3+ 用例。

---

## 第四部分 · 执行顺序

依赖关系决定顺序，**每步执行后立即验证**：

```
R1 公共层（error/crypto/lease/util）   ← 无依赖，先行
 ↓
R3 runtime 拆分  →  R4 gateway_host 拆分  →  R5 harness_window 拆分
      （三步均依赖 R1 的 error/lock 宏，彼此独立可串行）
 ↓
R2 契约收敛（依赖 R3/R4 拆分后的稳定路径）
 ↓
R7 测试补齐（依赖 R3 拆出的 config.rs）
 ↓
R6 脚本去重（完全独立，最后执行，避免干扰构建验证）
```

每步验证命令：
```bash
RUSTUP_TOOLCHAIN=1.98.0-x86_64-pc-windows-msvc cargo check --offline
RUSTUP_TOOLCHAIN=1.98.0-x86_64-pc-windows-msvc cargo test  --offline --lib
npx vitest run
node scripts/check-shell-package.mjs      # R2 后
```

---

## 第五部分 · 执行结果（已完成）

| 项 | 结果 | 关键产出 |
|---|---|---|
| R1 公共层 | ✅ | `error.rs`（锁中毒文案 13→1）、`crypto.rs`、`lease.rs`、`util.rs`（`is_loopback` / `rfc3339` / `civil_from_days`）、`LockRecover` 宏 |
| R2 契约收敛 | ✅ | Shell 命令 13 → 9（移除 `app.quit` / `app.update.check` 孤儿，补 `runtime.clear-quarantine` 等接线）；`check-shell-package.mjs` 三方 apiVersion + 命令表对齐 |
| R3 runtime 拆分 | ✅ | `runtime.rs`(1553) → `runtime/`：types / paths / config / spawn / start / control / mod；`RuntimeProcess` 仅经 `types` 对 actor 暴露 |
| R4 gateway_host 拆分 | ✅ | `gateway_host.rs`(1453) → `gateway_host/`：types / server / lifecycle / connection / request / handler / http_io / commands / mod |
| R5 harness_window 拆分 | ✅ | `harness_window.rs`(853) → `harness_window/`：splash / navigation / window / commands / mod |
| R6 脚本去重 | ✅ | 删除 `build-pipeline.mjs` / `dev-dsh.sh` / `dev-dsh.bat` / `regenerate-icon.ps1`；`build.sh` 薄壳化并抽出 `bootstrap-node.sh`（与 `bootstrap-node.ps1` 对齐，同写 `.local-tools/node-home.txt`） |
| R7 测试补齐 | ✅ | Rust 47 → **84** passed（目标 ≥67）；新增 `gateway.rs` 8 个（此前零测试）、`runtime/config.rs` 14 个 |

### 执行中发现的真实缺陷（测试先行暴露）

1. **`gateway.rs` 私有 `is_loopback` 与 `util::is_loopback` 重复** — R1 只收敛了
   `gateway_host`，`gateway.rs` 仍保留一份私有副本。已删除并改用共享实现。
2. **IPv6 loopback 判定失效（真实 Bug）** — `url::Url::host_str()` 对 IPv6 保留方括号
   （`http://[::1]:8080` → `[::1]`），而共享 `is_loopback` 假定调用方已剥括号，
   导致 `[::1]` 解析失败 → `http://[::1]:8080` 被误判为公网 HTTP 而拒绝。
   已让 `is_loopback` 容忍括号形式（同时接受 `"  localhost  "` 前后空白）。
3. **`check-shell-package.mjs` 在 Windows 本地不可运行** — `spawnSync('npm')` 不应用
   PATHEXT，且 Windows 上 Node 拒绝直接 spawn `.cmd`（`EINVAL`）。已改为优先用
   `node <npm-cli.js>` 直驱 npm 的 JS 入口，并保留 `npm` / `npm.cmd` 回退。
   CI（ubuntu）路径不受影响。
4. **`process.rs` 未用导入** — `thread` / `Duration` 仅被 `#[cfg(unix)]` 分支使用，
   Windows 编译产生警告；已按平台拆分导入。

### 最终验证

```text
cargo check  --offline   0 errors / 6 warnings（基线 7，减少 1）
cargo test   --offline --lib   84 passed（基线 47）
npx vitest run           305 passed | 1 skipped（58 文件）
check-shell-package.mjs  9 commands aligned / apiVersion 2 三方一致 / 6476 B
```


---

## 第五部分 · 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 3,943 行机械搬运引入拼写/路径错误 | 编译失败 | 每子模块搬运后立即 `cargo check`；`mod.rs` 用 `pub use` 保证调用方零改动 |
| `thiserror` 离线解析失败 | 阻断 R1 | 已确认 `thiserror-1.0.69.crate` 在 `~/.cargo/registry/cache`；若失败则回退为手写 `impl Display + Error`（约 30 行） |
| R2 新增两项 BRIDGE 接线引入运行时错误 | 前端报错 | e2e 冒烟会捕获 console error；接线走既有 `host_execute` 通道，能力模型不变 |
| `app.quit` / `app.update.check` 移除影响外部调用方 | 功能回退 | 二者从未被 BRIDGE 接线，Web 侧不可达；`capability_broker` 对 Web 亦为 Deny，无实际调用方 |
| `build.sh/.bat` 薄壳化破坏 CI | 构建中断 | CI 实际使用 `build.mjs`（见 `.github/workflows`）；薄壳仅保留参数转发，parity 测试同步更新 |

---

## 附：不变量守护清单（重构后仍必须成立）

1. `bridge` 是唯一命令入口层，业务模块不得反向调用 `bridge`。
2. `service::snapshot` 是唯一按 `runtime → surface → gateway` 顺序取锁的读路径。
3. `runtime_actor` 只依赖 `runtime::types` 纯类型，不依赖业务逻辑。
4. Web 侧仅经 `host_execute` + BRIDGE 白名单触达原生。
5. `capability_broker` 保持 **deny-by-default**（未声明即拒绝）。
6. 单实例锁 + 文件锁语义不变。
7. 架构检查 `check:tauri-only` 通过（仓库内无 Electron 路径）。
