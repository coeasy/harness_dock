# HarnessDock 优化改进方案

> 编制日期：2026-09-05 | 基线版本：v0.1.2-beta.3 | 配套文档：`ARCHITECTURE_REVIEW.md`

---

## 总览

本方案基于对 HarnessDock 全量架构审查（Rust 后端 8,131 行 + TypeScript 包 ~9,100 行 + 契约测试 1,327 行），针对 16 项已识别技术债，制定四阶段优化路线图。原则：**深度根因修复，禁止表面补丁；增量改进不影响正常启动链路**。

### 优先级矩阵

| 阶段 | 周期 | 主题 | 覆盖技术债 |
|---|---|---|---|
| P0 | 立即 | 稳定性 + 正确性修复 | TD-01, TD-04, TD-07, TD-09 |
| P1 | 短期 | 架构健壮性提升 | TD-03, TD-05, TD-15 |
| P2 | 中期 | 异步化 + 测试体系 | TD-02, TD-10, TD-11, TD-12 |
| P3 | 长期 | 生态完善 + 发布成熟 | TD-06, TD-08, TD-13, TD-14, TD-16 |

---

## P0 — 稳定性 + 正确性修复（立即）

### P0-1 修复 `status_snapshot` 隐式副作用（TD-01）

**问题**：`runtime.rs` 的 `status_snapshot` 调用 `is_alive`，后者会 `invalidate_dead_process` 并连带 `stop_managed(gateway)`。快照读取（只读操作）隐含了杀进程 + 停网关的副作用，在并发路径中可能触发意外重启。

**方案**：

1. 拆分 `is_alive` 为两个函数：
   - `fn is_alive(&self) -> bool` — 纯只读，仅 `try_wait`，不触发任何状态变更
   - `fn reap_if_dead(&self) -> Option<ExitStatus>` — 主动清理，返回是否实际执行了清理
2. `status_snapshot` 只调 `is_alive`，不调 `reap_if_dead`
3. 主动清理逻辑由 `reconciler` / `supervisor` 的专门路径调用 `reap_if_dead`

**改动文件**：`runtime.rs`、`runtime_actor.rs`、`bridge.rs`（调用 `status_snapshot` 的地方）

**验收**：parity 测试新增 "snapshot-does-not-kill" 用例；并发快照读取不再触发 gateway 停止。

### P0-2 修复 Host Kernel 事件丢失（TD-04）

**问题**：`record_event` 用 `app.emit` 广播事件，但错误被 `catch` 吞掉，事件丢失不可观测。

**方案**：

1. `record_event` 返回 `Result<(), HostError>`，不吞错
2. 调用方（`reconciler` / `runtime_actor`）在 emit 失败时写 `tracing::warn!` 日志
3. 在 startup_trace 日志中追加事件发射计数（emitted / failed）

**改动文件**：`host_kernel.rs`、`reconciler.rs`

**验收**：日志中可看到事件 emitted/failed 计数；无静默丢失。

### P0-3 修复 Shell Bridge 版本号漂移（TD-07）

**问题**：`harness_shell.rs` 的 BRIDGE_SCRIPT 硬编码 `apiVersion: 2`，但 `packages/bootstrap/src/shell-contract.ts` 定义 `SHELL_API_VERSION = 1`。compat 层靠 `=== 2` 判断能力门控，契约与实现漂移。

**方案**：

1. 在 `shell-contract.ts` 中定义 `SHELL_API_VERSION = 2`，与 BRIDGE_SCRIPT 对齐
2. 或者：BRIDGE_SCRIPT 改为 `apiVersion: 1`，与契约对齐
3. 推荐方案 1（`= 2`），因为 BRIDGE_SCRIPT 已发布了 `apiVersion: 2` 的行为
4. 在 `check:shell-package` 脚本中新增版本一致性校验

**改动文件**：`packages/bootstrap/src/shell-contract.ts`、`scripts/check-shell-package.mjs`

**验收**：`pnpm check:shell-package` 校验 BRIDGE_SCRIPT 的 apiVersion 与 SHELL_API_VERSION 一致。

### P0-4 修复 `normalizeShellCapabilities` 默认开放（TD-09）

**问题**：`normalizeShellCapabilities` 默认"非 false 即 true"，缺失声明的能力默认开放。远程 Harness Web 可获得未授权能力。

**方案**：

1. 改为 **默认拒绝**（deny-by-default）：未显式声明 `true` 的能力一律 `false`
2. 新增测试：未声明能力的请求被拒绝

**改动文件**：`packages/bootstrap/src/host-capabilities.ts`

**验收**：parity 测试新增 "deny-undeclared-capability" 用例。

---

## P1 — 架构健壮性提升（短期）

### P1-1 Host Kernel 并发能力提升（TD-03）

**问题**：Host Kernel 单 channel 容量 128，全串行执行。慢命令（如 update-install）阻塞后续命令。

**方案**：

1. **分优先级队列**：将命令分为 `fast`（window/reload/diagnostics）和 `slow`（restart/update/gateway）
2. Host Kernel 内部维护两个 channel：`fast_queue`（容量 64）和 `slow_queue`（容量 8）
3. 快命令在快队列执行，不等待慢命令
4. 同 subject 的命令仍按序（去重不变）

**改动文件**：`host_kernel.rs`、`host_protocol.rs`

**风险评估**：需要保证同 subject 命令的有序性不变。建议先加 bench test 再改。

### P1-2 插件恢复诊断归因结构化（TD-05）

**问题**：`recovery_plan` 靠字符串子串匹配诊断文案（如 "Cannot find module"），误报/漏报风险高。

**方案**：

1. 定义 `DiagnosticFingerprint` 枚举（结构化匹配规则）：
   ```rust
   enum DiagnosticFingerprint {
       ModuleNotFound { module_name: String },
       SyntaxError { file: String, line: u32 },
       PermissionDenied { path: String },
       PortInUse { port: u16 },
       Unknown,
   }
   ```
2. `dump_config` 输出经 `parse_diagnostic` 解析为 `DiagnosticFingerprint`
3. `recovery_plan` 按 `DiagnosticFingerprint` 匹配，不再做裸字符串匹配
4. 保持字符串匹配作为 fallback（`Unknown` 分支）

**改动文件**：`runtime.rs`（新增 `diagnostic.rs` 模块）

### P1-3 统一只读状态访问层（TD-15）

**问题**：`host_snapshot` / `runtime_status` / `public_runtime_status` 等状态读取散布在 `bridge.rs` 直连各 actor 锁，缺少统一只读访问层，锁序不一致风险。

**方案**：

1. 在 `service/` 下新增 `snapshot.rs`：
   ```rust
   pub(crate) struct ReadOnlySnapshot {
       runtime_phase: RuntimePhase,
       gateway_phase: GatewayPhase,
       surface_phase: SurfacePhase,
       update_phase: UpdatePhase,
       revision: u64,
   }
   
   impl ReadOnlySnapshot {
       pub fn collect(app: &AppHandle) -> Self { ... }
   }
   ```
2. 统一加锁顺序：runtime → surface → gateway → update（文档化）
3. `bridge.rs` 的所有状态读取改为调 `ReadOnlySnapshot::collect`
4. 消除分散的 `app.state::<AppState>().*.lock()` 调用

**改动文件**：`service/snapshot.rs`（新增）、`bridge.rs`、`state.rs`

---

## P2 — 异步化 + 测试体系（中期）

### P2-1 消除 `spawn_blocking` + `sleep` 轮询（TD-02）

**问题**：`startup.rs` 的 `reveal_clean_runtime_fallback`（50×100ms）和 `supervisor.rs` 的 `wait_for_managed_processes`（30s 上限）都在 `spawn_blocking` 内 `sleep` 轮询。

**方案**：

1. `reveal_clean_runtime_fallback`：改为 `tokio::time::interval` + `tokio::time::timeout`，在 async 上下文中执行
2. `wait_for_managed_processes`：改为 `tokio::select!` 等待 `managed_operations_idle` 信号 + `timeout`
3. 如果 WebView2 事件回调可提供信号，用 channel 替代轮询

**改动文件**：`startup.rs`、`supervisor.rs`

### P2-2 填补 e2e 测试空覆盖（TD-10）

**问题**：`tests/e2e/` 仅有 node_modules，无 spec 源文件。

**方案**：

分三轮建设：

**轮 1（核心路径）**：
- 启动 → Runtime ready → WebView 可见 → Shell 渲染
- 关闭 → 所有子进程退出（无孤儿）
- 插件隔离 → 启动失败 → 恢复窗口

**轮 2（能力门控）**：
- HarnessWeb 调用被禁能力 → 被拒
- Gateway 配对 → 移动端连接 → 断开
- Updater 检测更新 → 安装 → 重启

**轮 3（跨平台）**：
- Windows NSIS 安装 → 首启
- macOS DMG 安装 → 首启
- Linux AppImage → 首启

**改动文件**：`tests/e2e/*.spec.ts`（新增）

### P2-3 契约测试去字符串依赖（TD-11）

**问题**：parity 测试大量依赖源码字符串/文件名标记扫描，重构易误伤。

**方案**：

1. 将"禁止 XXX"类断言从字符串匹配改为 AST 解析（用 `@swc/core` 或 `typescript-eslint`）
2. 对于 Rust 侧约束，改为编译时 derive macro 或 `cfg` 断言
3. 保留字符串匹配仅用于"文档存在"类检查

**改动文件**：`tests/parity/*.test.ts`

### P2-4 统一本地与 CI 构建逻辑（TD-12）

**问题**：`local-client.ps1`（13KB）与 `tauri-candidate.yml` 重复逻辑偏重，本地与 CI 路径 drift。

**方案**：

1. 将构建逻辑提取为 `scripts/build-pipeline.mjs`（纯函数 + 配置驱动）
2. `local-client.ps1` 改为薄包装，调用 `build-pipeline.mjs --local`
3. `tauri-candidate.yml` 同样调用 `build-pipeline.mjs --ci`
4. 统一参数：`--target`, `--runtime-source`, `--sign`, `--smoke`

**改动文件**：`scripts/build-pipeline.mjs`（新增）、`scripts/local-client.ps1`（瘦身）、`.github/workflows/tauri-candidate.yml`

---

## P3 — 生态完善 + 发布成熟（长期）

### P3-1 quarantine 跨版本策略（TD-06）

**问题**：插件隔离仅按 `dsh_version` 绑定，跨版本升级时策略失效。

**方案**：

1. quarantine 文件增加 `quarantineSchemaVersion` 字段
2. 支持 `dshVersionRange`（SemVer range）替代固定版本
3. 升级时自动迁移旧格式 quarantine 文件

### P3-2 compat store 深拷贝修复（TD-08）

**问题**：`client.js` 的 `update` 浅拷贝不处理数组，旧插件可能有边界 bug。

**方案**：

1. `update` 改用结构化克隆（`structuredClone` 或 `JSON.parse(JSON.stringify(...))`）
2. 新增测试覆盖嵌套对象/数组更新

### P3-3 清理仓库内大体积 node.exe（TD-13）

**问题**：`runtimes/pack/` 内沉淀 87MB `node.exe`。

**方案**：

1. 将 `runtimes/pack/` 加入 `.gitignore`
2. 改为 `prepare-local-runtime.mjs` 按需下载（SHA256 校验）
3. 仓库内只保留 `runtimes/pack/README.md` 说明

### P3-4 Updater 签名策略落地（TD-14）

**问题**：`tauri-plugin-updater` 已编译但 `createUpdaterArtifacts=false`，签名策略未定。

**方案**：

1. P3 阶段确定签名通道（选项：GitHub Release 手动下载 / 自建签名服务 / Tauri 官方签名）
2. 如选 Tauri 官方：配置 `TAURI_SIGNING_PRIVATE_KEY` + `createUpdaterArtifacts=true`
3. 生成 `latest.json` + `.sig` 资产
4. 更新 `release.yml` 发布 updater 资产

### P3-5 dsh-web-frontend 可审计性（TD-16）

**问题**：dsh-web-frontend 为打包产物，源码不在仓库，可审计性弱。

**方案**：

1. 在 `docs/reference/` 下维护前端 API 调用清单（手动维护，随上游升级更新）
2. 在 `check-embedded-runtime.mjs` 中新增前端 bundle API 调用扫描（与清单比对）
3. 上游升级时自动生成 diff 报告

---

## 实施时间线

```
Week 1-2  │ P0-1 ~ P0-4  │ 稳定性修复 + 版本对齐 + 安全收紧
Week 3-4  │ P1-1 ~ P1-3  │ Host Kernel 并发 + 诊断结构化 + 只读层
Week 5-8  │ P2-1 ~ P2-4  │ 异步化 + e2e 测试 + 契约测试重构 + 构建统一
Week 9+   │ P3-1 ~ P3-5  │ 生态完善 + 签名 + 可审计性
```

每个阶段完成后：
1. 运行 `pnpm check:versions && pnpm check:release && pnpm check:embedded-runtime`
2. 运行 `pnpm test`（parity 契约全绿）
3. 运行 `cargo build --locked`（Rust 编译无 warning）
4. 本地 `pnpm local:client smoke`（启动链路全绿）
5. 提交 → 推送 → CI 全绿 → 合并

---

## 不变量保护

以下架构不变量在优化过程中**不得违反**：

1. 桌面：Full Runtime，首启零下载
2. 移动：Remote Gateway only，不在 Android/iOS 内启动 Node/dsh
3. 正常启动：Runtime ready 后直接显示 Harness Web，不先打开设置页
4. Shell：独立、可选、fail-open
5. WebView：只允许当前 RuntimeLease 对应的 `127.0.0.1` origin
6. 生命周期：Runtime/Gateway/Surface/Update 通过 Host Kernel 统一管理
7. 插件：异常进入隔离/恢复流程，不终止主客户端
8. 发布：只接受同一 `main` SHA 的绿色 CI 与 candidate 资产

---

## 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| P1-1 Host Kernel 改并发引入死锁 | 先加 bench test 基线，改后对比；保留单线程 fallback cfg |
| P2-1 异步化改动启动链路 | 不变量：不修改 `ProcessStarted → RuntimeReady → PrimaryVisible` 阶段链 |
| P2-2 e2e 测试依赖 WebView2 环境 | 用 Playwright + Tauri WebView 模拟器，CI 分平台跑 |
| P2-3 AST 解析引入新依赖 | 用 `@swc/core`（已有间接依赖），不引入新包 |
| P3-4 签名通道延迟 | 保持 GitHub Release 手动下载作为 fallback |

---

## 附录：技术债索引表

| 编号 | 问题 | 阶段 | 改动文件 |
|---|---|---|---|
| TD-01 | status_snapshot 隐式副作用 | P0-1 | runtime.rs, runtime_actor.rs, bridge.rs |
| TD-02 | spawn_blocking + sleep 轮询 | P2-1 | startup.rs, supervisor.rs |
| TD-03 | Host Kernel 全串行 | P1-1 | host_kernel.rs, host_protocol.rs |
| TD-04 | record_event 吞错 | P0-2 | host_kernel.rs, reconciler.rs |
| TD-05 | 插件恢复字符串匹配 | P1-2 | runtime.rs (新增 diagnostic.rs) |
| TD-06 | quarantine 跨版本失效 | P3-1 | plugin_quarantine.rs |
| TD-07 | Shell 版本号漂移 | P0-3 | shell-contract.ts, check-shell-package.mjs |
| TD-08 | compat 浅拷贝 | P3-2 | client.js |
| TD-09 | 能力默认开放 | P0-4 | host-capabilities.ts |
| TD-10 | e2e 空覆盖 | P2-2 | tests/e2e/*.spec.ts |
| TD-11 | 契约测试字符串依赖 | P2-3 | tests/parity/*.test.ts |
| TD-12 | 本地/CI 构建重复 | P2-4 | scripts/build-pipeline.mjs |
| TD-13 | 仓库内大体积 node.exe | P3-3 | .gitignore, prepare-local-runtime.mjs |
| TD-14 | updater 签名未定 | P3-4 | tauri.conf.json, release.yml |
| TD-15 | 状态读路径分散 | P1-3 | service/snapshot.rs, bridge.rs |
| TD-16 | 前端不可审计 | P3-5 | docs/reference/, check-embedded-runtime.mjs |
