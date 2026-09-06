# HarnessDock 重构优化方案 V4（基于最新 main 实证复核）

> 状态：**建议作为下一轮实施基线**  
> 核验基线：`main@b3a830e39b44ced2519c8a4ca9492889b8694444`  
> 核验日期：2026-09-06  
> 对照文档：`docs/REFACTOR_PLAN_V3.md`  
> 本文目标：不是继续放大 V3 的结论，而是逐项验证 V3 的问题是否仍真实存在，纠正已经过时、证据不足或定级过重的判断，并据此给出可落地、可回滚、不会误伤现有发布链路的优化方案。

---

## 0. 结论摘要

V3 的核心方向中，**“桌面 Rust Host 为主实现、移动端 remote-only、契约应收敛、parity 应减少源码字符串断言”**仍然有价值；但对当前 `main` 重新检查后，发现 V3 混合了三类情况：

1. **真实且需要优先修复的问题**
   - Shell API 版本存在真实漂移：`manifest.json` / `release-manifest.json` 为 `1`，运行时 Bridge / TS contract / plugin entry 为 `2`。
   - `check-shell-package.mjs` 只守住 3 处版本，没有守住发布 manifest。
   - Node/TS `DshRuntime` 启动环境没有传递 Runtime ready 安全绑定变量，而 `plugin-embedded-client` 已经 fail-closed 要求这些变量。
   - 移动端已有 remote-only 入口和配对 UI，但仓库没有专门的 mobile capability；当前 CI 证明“能编译”，不能证明移动 WebView 真能调用 `platform_info` / `gateway_health` / `pair_gateway`。
   - `tauri-candidate.yml` 仍两次检查已经不存在的 `apps/tauri/src-tauri/src/gateway_host.rs`，而当前实现已拆成 `gateway_host/mod.rs`。这是 **V3 没发现的新 CI 阻断问题**。
   - CI 仍缺少 `clippy` 和稳定的供应链审计门禁。

2. **问题存在，但 V3 的定级或修法过重**
   - `mobile.rs` 确实是孤儿文件，但 mobile 真正入口已经直接写在 `lib.rs`，配对界面也已经在 `apps/tauri/web/app.js` 实现。因此不应“重写 mobile.rs 才算打通移动端”，更合理的是**删除孤儿 adapter，或仅在确有组合根价值时接回它**。
   - `apps/vscode/dist/` 未提交并不能证明 VS Code 扩展“从未构建”。仓库已有 `bundle.mjs`，明确产出 `dist/extension.cjs`。真实问题是 **CI/Release 没有持续证明 VSIX 可构建、可打包、可启动**。
   - Gateway 并非“无自动化验证”：`gateway.rs` 和 `gateway_host/mod.rs` 已有不少安全/协议测试；同时 Windows 有真实安装包启动 E2E。真实缺口是路由、票据、生命周期竞争等高价值行为覆盖仍不够。
   - 两个生产 `expect` 都位于前置状态校验之后，属于内部不变量断言，不应列为 P0 外部可触发崩溃；可以防御性消除，但优先级应下降。
   - 两个 `ensureDownloadedRuntime` 是“高层 bundle-aware wrapper + 低层 registry/NPM fallback”，不是两套等价实现。应改名，而不是删除其中一套。

3. **V3 在最新 main 上已经不成立或证据不足的问题**
   - `tauri.conf.json` 已经没有重复的顶层 `windows` / `app.windows` splash 定义，P0-6 已过时。
   - Android/iOS CI 不是占位：`tauri-ci.yml` 已真实执行 `android init/build`、`ios init/build`；`tauri-candidate.yml` 也真实产出 APK/AAB 和 iOS simulator artifact。
   - `gen/android` / `gen/apple` 没提交不能推导出“移动骨架从未生成”；当前 CI 就是按需生成。除非需要维护原生定制，否则**不建议为了证明存在而把 generated project 固化进 Git**。
   - `revision` 不是两个独立自增真相源：`KernelPublicState.revision` 在记录事件时从 `AppState.revision` 读取并投影，因此目前没有证据支持“两个 revision 各自维护导致乱序”。
   - `lifecycle.rs` 与 `service/snapshot.rs` 有字段重叠，但用途和投影不同，不是逐行重复实现；可以收敛 read model，但不是高优先级缺陷。

**因此，本轮不建议直接照 V3 的 S0→S8 执行。** 最优路线应改为：

> **先修发布/契约真缺陷 → 明确 VS Code 产品定位 → 再按职责切分 TS 层 → 补移动运行时 capability/E2E → 精简 parity → 最后做结构卫生。**

---

# 第一部分：最新代码现状

## 1.1 当前主链路

桌面主链路仍然是：

```text
Tauri Native Host (Rust)
  -> RuntimeActor / Runtime spawn
  -> plugin-embedded-client ready.json
  -> RuntimeLease
  -> Harness WebView
  -> harness-shell bridge
  -> Host Protocol / Capability Broker
```

该方向没有必要推倒重来。前一轮 R1-R7 对 Rust Host 做的模块拆分已经形成较清晰的 Actor / Kernel / Reconciler 边界，应继续保留。

## 1.2 当前移动端真实形态

当前移动端不是“空实现”：

- `lib.rs` 已存在 `#[cfg(mobile)] #[tauri::mobile_entry_point] pub fn run()`；
- mobile invoke handler 已注册：
  - `platform::platform_info`
  - `gateway::gateway_health`
  - `gateway::pair_gateway`
- `platform.rs` 在 mobile 下返回：
  - `surface = "mobile"`
  - `runtime_mode = "remote"`
- `apps/tauri/web/app.js` 已存在 `mobile-remote` surface：
  - 输入 Gateway 地址
  - 健康检查
  - 输入 8 位配对码
  - 调用 `pair_gateway`
  - 成功后 `window.location.assign(paired.connectUrl)`
- `tauri-ci.yml` 已真实构建 Android APK 与 iOS simulator app；
- `tauri-candidate.yml` 已真实构建 Android APK/AAB 与 iOS simulator candidate。

所以，移动端真正剩下的是 **权限/运行时验证与产品级 E2E**，而不是“从零实现入口”。

## 1.3 当前 TS 层的真实职责

不能把 `packages/client-runtime` 简化理解为“只服务 VS Code 的重复 Runtime Host”。当前它至少承担两类职责：

1. Node/VSCode Runtime host：`DshRuntime`、ready 等逻辑；
2. **Tauri 正式发布链仍在使用的 Runtime 打包工具**：
   - `bundle-runtime`
   - `smoke-runtime`
   - `prepare-cli.ts`
   - `ensure-pnpm-cli.ts`
   - `prune-node-cli.ts`

`tauri-candidate.yml` 明确通过 `@dsh/client-runtime` 准备官方 Runtime closure 并做 smoke。因此直接删除或整体“降级为测试夹具”会破坏当前正式构建链。

正确做法不是“一刀删除 TS”，而是把“构建工具”和“第二 Runtime Host”拆成不同责任边界。

---

# 第二部分：V3 问题逐项核验

## 2.1 P0 核验

| V3 ID | V3 判断 | V4 复核 | 新定级 | 处理建议 |
|---|---|---|---|---|
| P0-1 | `mobile.rs` 死代码，移动端未接通 | **部分成立**：`mobile.rs` 确实未被 `mod`；但 `lib.rs` 已直接实现 mobile entry，且 remote pairing UI 已存在 | P2 清理 + P1 mobile runtime gate | 不重写功能；优先删孤儿 `mobile.rs`，或仅在需要统一 composition root 时接回 |
| P0-2 | Shell `manifest.json apiVersion=1` 与 Runtime v2 冲突 | **成立** | P0 契约 | 建立单一 Shell contract SSOT，消除 1/2 漂移 |
| P0-3 | `check-release.mjs` 强制 shell apiVersion=1 | **成立** | P0 契约 | 明确字段语义；如果代表 Bridge API，应统一到 2；如果代表 manifest schema，应改名 |
| P0-4 | VSCode main 指向不存在 dist，扩展从未构建 | **证据不足** | P1 发布门禁 | `dist` 作为构建产物不应强制入库；新增 bundle/vsix CI 才是正确修复 |
| P0-5 | 缺移动 capability | **成立，高置信** | P0/P1 mobile runtime | 新增 mobile 最小 capability，并用运行时 smoke 验证 invoke 权限 |
| P0-6 | `tauri.conf.json` 重复 splash | **不成立，最新 main 已无重复** | 已关闭 | 不再改 |
| P0-7 | TS ready 契约缺 3 个安全绑定变量 | **成立** | P0（如果 Node Host 保留） | Node Host 必须生成并校验 generation/nonce/image identity；不能让 embedded plugin 放宽 fail-closed |
| P0-8 | 两处生产 `expect` 是 P0 panic | **存在代码，但定级过重** | P2 hardening | 可改为 `ok_or_else`/错误返回；不应阻断架构阶段 |
| P0-9 | 无 clippy/e2e/audit | **部分成立**：clippy/audit 缺失；但 Windows packaged startup 已是真 E2E，移动 CI 也是真构建 | P1 CI | 加 clippy/audit；整合而非重复建设 E2E |

## 2.2 P1 核验

| V3 ID | V4 复核 | 新结论 |
|---|---|---|
| P1-1 双实现 | **部分成立** | Rust/TS 确有 Runtime host 语义重复，但 TS 包同时承担 Tauri Runtime 打包职责，不能整体删除。应按责任拆包 |
| P1-2 revision 双真相源 | **不成立/缺证据** | `KernelPublicState.revision` 是从 `AppState.revision` 读取的事件投影，不是独立自增真相源 |
| P1-3 snapshot 重复 | **部分成立** | 两个 read model 有重叠但字段和用途不同，可后续合并为共享 read model，不是紧急缺陷 |
| P1-4 核心路径零测试 | **部分成立** | 不是“零测试”：Gateway 有 parent module tests，Windows 有真实 packaged E2E；但 Runtime retry、Gateway route/auth/race 等仍应补行为测试 |
| P1-5 两个 `ensureDownloadedRuntime` | **命名问题，不是双实现** | 高层 wrapper 调低层 registry fallback；建议改低层名为 `ensureRegistryRuntime` / `ensureNpmRuntime` |
| P1-6 超长函数 | **成立** | 应在契约和行为测试补足之后拆，避免先拆再补测试 |
| P1-7 `local-client.cmd` 孤儿 | **可清理但非缺陷** | 当前只是 PowerShell launcher；若文档不再直接提供 `.cmd` 入口可删，否则保留作为 Windows UX shortcut |
| P1-8 test 混入 src | **成立但低风险** | 迁移到 tests 目录 |
| P1-9 魔法数字 | **成立** | 统一到 `constants.rs` / typed config，但不应过度配置化安全上限 |
| P1-10 `include_str!` 跨目录路径 | **成立** | 通过 build step/资源包/生成文件减少跨层相对路径耦合 |
| P1-11 parity 源码字符串测试脆弱 | **成立** | `tests/parity/rust-source.ts` 明确拼接 Rust 源码供 `toContain` 类断言，长期应收敛 |

## 2.3 P2 核验

| V3 ID | V4 结论 |
|---|---|
| P2-1 文档路径陈旧 | 成立，放在最后一轮统一清理 |
| P2-2 历史规划未归档 | 成立，但不要删除仍作为决策记录的文档；统一迁移到 `docs/archive/` 更合理 |
| P2-3 无供应链审计 | 与 P0-9 重复，应合并为 CI/security workstream |
| P2-4 mobile cfg 桩块 | 清理项；由于整个 `harness_window` 本身 desktop-only，不应把这类桩误认为 mobile 主实现 |

---

# 第三部分：V3 未发现的新问题

## N0-1：`tauri-candidate.yml` 仍引用已删除的 `gateway_host.rs`

当前 Rust 模块已经拆为：

```text
apps/tauri/src-tauri/src/gateway_host/mod.rs
apps/tauri/src-tauri/src/gateway_host/*.rs
```

但 `tauri-candidate.yml` 仍至少两处：

```bash
test -s apps/tauri/src-tauri/src/gateway_host.rs
```

当前该文件实际不存在。这意味着 candidate workflow 只要运行到这些校验，就会被旧路径直接阻断。

### 修复

统一所有 workflow 的源码结构检查，不要手写散落路径：

```text
scripts/check-tauri-source-layout.mjs
  -> runtime/mod.rs
  -> gateway_host/mod.rs
  -> harness_window/mod.rs
  -> util.rs
  -> error.rs
```

然后 `ci.yml`、`tauri-ci.yml`、`tauri-candidate.yml` 全部只调用这一个检查脚本。

**禁止再次在多个 YAML 中复制同一文件路径清单。**

## N1-2：V3 的 VSCode `/api/host/status` 方案依赖了一个可选生命周期

V3 建议让 VS Code 固定探测：

```text
http://127.0.0.1:43137/api/host/status
```

并把端点塞进 `gateway_host`。

但当前 `gateway_host` 不是常驻 Host control plane，它是用户按需启动的 Mobile Gateway，并且依赖 live RuntimeLease。也就是说：

- VS Code 在 HarnessDock 尚未启动时探测不到；
- HarnessDock 已启动但用户没有启动 Gateway 时也探测不到；
- 为了 VS Code 被迫常驻 Gateway，会改变当前产品的安全/生命周期语义。

所以不应直接落地 V3 的这个端点。

如果未来明确选择“VS Code 只是 HarnessDock Companion”，应新建 **独立 local control plane**：

- 独立生命周期，不依赖 Gateway 是否开启；
- loopback only；
- 带进程级随机 token / OS-local ACL；
- 只暴露最小状态和 focus/open 等动作；
- 不复用移动 Gateway 的远程设备会话语义。

否则，VS Code 应继续作为独立 host，并把 Node Host 契约修正确。

## N1-3：构建 E2E 与 Playwright E2E 存在“双套但一套未纳入门禁”的状态

当前仓库已经有很强的 `windows-packaged-startup.yml`：

- 下载精确 candidate；
- 静默安装；
- 从中性 cwd 启动；
- 等待 startup trace；
- 读取真实 `ready.json`；
- 执行 launch token → cookie → clean URL 的真实浏览器会话语义；
- 连续探测 HTML。

同时 `tests/parity` 又存在 Playwright `e2e` script。

应明确唯一主线：

- **发布门禁继续以 packaged startup 为主**；
- Playwright 仅保留它能覆盖、而 packaged smoke 覆盖不到的 WebView/DOM/Bridge 行为；
- 如果 Playwright 只是重复“页面能打开”，就删除它，避免一套长期失修。

---

# 第四部分：修正后的目标架构

## 4.1 原则一：Rust 是桌面 Host 唯一业务实现，但 TS 打包工具不是重复 Host

目标不要写成“删除 client-runtime”，而应写成：

```text
packages/
  runtime-packaging/          # 构建工具：prepare/bundle/prune/smoke，Tauri Release 使用
  node-runtime-host/          # 可选：仅当 VS Code / Node host 继续被支持
  host-contracts/             # Shell / Gateway / Host capability 的结构化 SSOT
  plugin-embedded-client/     # dsh 侧 ready producer
  plugin-harness-shell/       # Shell plugin + web asset
```

迁移可以先逻辑分层、后物理拆包，避免一次性改动所有 workspace 引用。

### 必须保持

- Tauri Runtime 打包链可继续离线准备 sealed runtime；
- `smoke-runtime` 继续作为正式 candidate 前置验证；
- `plugin-embedded-client` 的 fail-closed ready 契约不能为了兼容 TS 而降级。

## 4.2 原则二：VS Code 先定产品形态，再重构实现

V3 直接选了“VS Code 复用 Tauri”，但最新代码说明这会引入新的 Host 间通信与常驻控制面。

本轮应把它变成一个明确 gate：

### 方案 A：VS Code 是独立客户端（推荐默认，最少改变现状）

- 保留瘦版 `node-runtime-host`；
- 修复 ready security contract；
- 添加 `bundle + vsce package + extension smoke` CI；
- 与 Rust Host 共享**契约/类型/测试向量**，不共享进程控制实现。

优点：VS Code 不要求用户先安装/启动 HarnessDock。

### 方案 B：VS Code 是 HarnessDock Companion

- 删除 Node Runtime host；
- VS Code 只负责 focus/open/embed；
- 新建独立 local control plane，而不是复用可选 Mobile Gateway；
- 必须有安装发现、版本协商、token、单实例与升级兼容策略。

优点：真正只有一个 Runtime Host；缺点是产品耦合显著增加。

### 方案 C：VS Code 不再维护

- 删除 `apps/vscode`；
- 再按引用图删除 `packages/bootstrap` 中只服务 VS Code 的 orchestration；
- `client-runtime` 仅留下 Runtime packaging tooling。

**在 A/B/C 没定之前，不执行 V3 的 S4/S5 大删除。**

## 4.3 原则三：移动端保持 remote-only，修权限与真实运行链，不重造入口

目标移动链：

```text
Android/iOS Tauri app
  -> local mobile-remote UI
  -> platform_info
  -> gateway_health
  -> pair_gateway
  -> connectUrl
  -> remote Gateway Web session
```

### 需要做的只是

1. 增加 mobile-scoped capability；
2. 确认移动窗口 label / platform selector 与 generated project 一致；
3. 权限只开放：
   - `platform-info`
   - `gateway-health`
   - `gateway-pair`
   - 页面导航/必要 WebView primitive
4. 不给 desktop runtime/start/update/tray/single-instance 权限；
5. CI 新增 mobile runtime smoke：至少证明这三个 invoke 不因 ACL 失败；
6. 在可行平台增加一次 mock/local Gateway 的配对协议测试。

### 不建议

- 不为了“gen 目录存在”而提交生成的 Android/iOS 工程；
- 不把 Node Runtime 搬到 mobile；
- 不重写已有 `app.js` pairing flow；
- 不给 mobile `core:default` 作为偷懒方案。

## 4.4 原则四：Shell / Ready / Host Protocol 都必须有结构化 SSOT

### Shell contract

建议新建：

```text
protocol/shell-contract.json
```

至少包含：

```json
{
  "apiVersion": 2,
  "pluginId": "harness-shell",
  "commands": [
    "window.minimize",
    "window.toggleMaximize",
    "window.state",
    "window.close",
    "web.reload",
    "web.restart",
    "runtime.safe-mode",
    "gateway.manage",
    "diagnostics.open"
  ]
}
```

由脚本生成或校验：

- `packages/bootstrap/src/shell-contract.ts`
- `packages/plugin-harness-shell/src/index.ts`
- Rust Bridge 常量/command mapping
- `packages/plugin-harness-shell/manifest.json`
- `release-manifest.json`
- README 展示版本

### 版本字段语义必须一次讲清

如果 `manifest.json.apiVersion` 是 **Shell Bridge API**，统一为 `2`。

如果它原本想表达 **plugin manifest schema version**，则改为：

```json
{
  "manifestVersion": 1,
  "shellApiVersion": 2
}
```

不能继续用同名 `apiVersion` 在发布层表示 1、在运行层表示 2。

### Runtime ready contract

同样建议做结构化契约：

```text
protocol/runtime-ready-contract.json
```

定义：

- env keys
- ready.json fields
- generation type
- nonce requirement
- image identity requirement
- host restrictions

Rust Host、Node Host、plugin writer 的测试都读取同一个契约或生成常量。

---

# 第五部分：测试体系重构

## 5.1 不按“测试文件数量”做 KPI

V3 用“84 → ≥140”“parity ≤30”作为验收指标，这会诱导补低价值测试。

V4 改成按**行为门禁**验收：

- Runtime 启动失败后不会发布陈旧 lease；
- stale generation 不能 publish ready；
- Gateway pairing code 过期/复用/暴力尝试均 fail closed；
- Gateway stop/start race 不泄露 server；
- Shell 命令集合与 capability broker 一致；
- mobile 三个 invoke 真实可用；
- installed Windows candidate 能进入 Harness Web；
- VSIX（如果保留）能 bundle/package/activate。

## 5.2 parity 三分法保留，但标准调整

### A. 保留：真正跨语言契约

- Host Protocol JSON → Rust/TS generated artifacts
- Shell contract
- Runtime ready contract
- Release manifest 与 origin/version contract

要求：**解析结构，而不是 grep 源码文本。**

### B. 迁移：行为性质

迁到 Rust unit/integration 或 TS unit test：

- loopback URL
- Gateway request parsing
- pairing/token rules
- Runtime state transition
- diagnostics redaction

### C. 删除：实现形态断言

删除这类测试：

- 某 `.rs` 文件必须出现某字符串；
- 某函数必须在指定文件；
- README 必须出现实现描述；
- 模块拆分后仍要求旧文件名。

## 5.3 高价值新增测试

优先顺序：

1. `runtime/start`：成功、重试、取消、超时、stale generation；
2. `gateway_host/handler`：health、pair、connect、cookie、token expiry、proxy error；
3. Gateway lifecycle race：start-vs-stop / RuntimeLease invalidation；
4. Shell contract generated lock；
5. Runtime ready cross-host contract；
6. mobile capability invoke smoke；
7. VS Code build/activate smoke（仅 A/B 方案选择后）。

---

# 第六部分：CI / Release 优化

## 6.1 立即修 candidate stale path

新增 `scripts/check-tauri-source-layout.mjs`，所有 workflow 共用。

禁止 YAML 自己维护模块路径列表。

## 6.2 Rust 门禁

PR 必须：

```bash
cargo fmt -- --check
cargo check --locked
cargo test --locked --lib
cargo clippy --locked --all-targets -- -D warnings
```

若现有 warning 暂时无法一次清零，可先 `-D clippy::correctness` + warning baseline，随后收紧；但最终目标应是 clippy clean。

## 6.3 供应链门禁

建议两层：

### PR blocking

- lockfile 固定；
- `cargo metadata --locked`；
- 自有 release contract；
- `cargo deny check`（license/bans/sources/advisories 可配置）。

### scheduled security

- `cargo audit`；
- `pnpm audit --prod` 或等价审计；
- 上游 Runtime closure dependency report；
- SBOM（CycloneDX/SPDX）随 candidate artifact 输出。

原因：公共 advisory feed/registry 短暂异常不应让每个 PR 都完全不可用，所以网络依赖强的审计更适合 schedule + release gate。

## 6.4 E2E 收敛

保留：

- `windows-packaged-startup.yml` 作为最强发布 smoke；
- Android/iOS real build jobs。

补充：

- macOS/Linux candidate 至少做 binary launch / resource presence smoke；
- mobile invoke permission smoke；
- Playwright 只留 Bridge/DOM 行为，不重复 packaged startup。

## 6.5 VS Code（若继续支持）

新增 CI：

```bash
pnpm --filter ./apps/vscode run bundle
pnpm --filter ./apps/vscode run pack:vsix
```

并校验：

- `dist/extension.cjs` 存在；
- `.vsix` 可解包且包含 main；
- extension manifest `main` 与 package contents 一致。

`dist/` 仍然可以保持 gitignored。

---

# 第七部分：代码结构优化

## 7.1 Runtime Host / Runtime Packaging 分离

第一步先在现包内部建立目录边界：

```text
packages/client-runtime/src/
  host/       # DshRuntime, ready, process lifecycle
  packaging/  # prepare, bundle, prune, smoke, fetch closure
  shared/     # types/hash/path utilities
```

等引用稳定后再考虑物理拆包，避免一次性 workspace 大迁移。

## 7.2 拆 `runtime.ts::startImpl`

前置条件：Runtime ready contract test + retry/cancel tests 已存在。

建议拆为：

```text
resolveRuntimeImage()
createRuntimeWorkspace()
createRuntimeBinding()
spawnRuntimeProcess()
awaitRuntimeReady()
recoverRuntimeStart()
commitRuntimeSession()
```

每个阶段只返回显式 value，不通过大量外部可变字段隐式传递状态。

## 7.3 统一 read model，但不要强行合并不同用途 snapshot

可以新增：

```rust
struct HostReadModel {
    runtime: RuntimeReadState,
    surface: SurfaceReadState,
    gateway: GatewayReadState,
    update: UpdateReadState,
}
```

`LifecycleSnapshot` 和 `ReadOnlySnapshot` 从这个 model 派生。

这样解决重复 lock/read 规则，而不把两个语义不同的 snapshot 强行变成一个巨大结构。

## 7.4 防御性消除 `expect`

对：

- `generation must exist after image binding`
- `published gateway`

改为显式错误，目的不是修“已证明的 P0”，而是让未来重构破坏内部不变量时仍 fail closed、不会直接终止 GUI Host。

## 7.5 常量分层

集中：

- Gateway 默认端口
- pairing TTL
- Runtime start timeout/retry policy
- shutdown timeout

但安全边界值应保持源码常量，不要全部开放为用户配置。

---

# 第八部分：实施顺序（V4）

## Phase A — Release / Contract 止血

### A1. 修 candidate stale source checks

- 修 `gateway_host.rs` → `gateway_host/mod.rs`；
- 抽共享 source-layout checker；
- 检查所有 workflow 是否还引用 pre-split 文件。

### A2. 修 Shell contract 1/2 漂移

- 定义 `protocol/shell-contract.json`；
- 统一/重命名 manifest 字段；
- 更新 README / check-release / check-shell-package；
- 加“故意改坏一处必须红”的 contract test。

### A3. 修 Runtime ready cross-host contract

若 VS Code Node Host 继续支持：

- `DshRuntime` 生成 generation/nonce/image identity；
- 注入 3 个 `HARNESSDOCK_*` env；
- 验证 ready 内容与进程/版本/identity 对齐；
- 删除或收敛旧 `writeReadyFile` 旁路。

若 VS Code 决定 retire/companion：

- 不投入修第二 Host；直接进入 Phase B 对应迁移。

### A4. 增加 mobile 最小 capability

- 只授权 remote client 所需命令；
- 增加 invoke smoke；
- 不改变现有 remote-only UI。

**Gate A：**

```text
check:versions
check:release
check:shell-package
pnpm test
cargo fmt/check/test
android-smoke
ios-smoke
```

---

## Phase B — 明确产品边界并消除真正的双维护

### B1. 决定 VS Code A/B/C

没有这个决定，不做大删除。

### B2. 切分 Runtime packaging 与 Node Host

先目录切分，再按需要拆包。

### B3. 收敛 `packages/bootstrap`

如果 VS Code 独立：保留纯 orchestration + contract；
如果 companion/retire：删除 runtime lease/update/provider 等第二实现，只保留跨端 contract。

### B4. 不把 VSCode Host bridge 塞进 Mobile Gateway

Companion 模式下新建独立 local control plane。

**Gate B：**

- Tauri candidate Runtime packaging 不回归；
- Windows packaged startup 仍通过；
- VSIX gate（如保留 VS Code）通过。

---

## Phase C — 测试体系收敛

### C1. 先补关键行为测试

Runtime retry/cancel、Gateway route/auth/race。

### C2. 再删源码字符串 parity

只有当行为测试/结构化 contract 已接替保护后才删除。

### C3. 整合 Playwright 与 packaged E2E

避免两套“页面能打开”的重复门禁。

**Gate C：**

- 改 Rust 文件位置但不改契约时，contract test 不应失败；
- 改契约值但不更新消费者时，contract test 必须失败。

---

## Phase D — 维护性与卫生

- 拆超长函数；
- rename `ensureDownloadedRuntime` 低层函数；
- 迁移 `packed-closure.test.ts`；
- 清理真正无引用的脚本；
- 集中常量；
- 收敛 read model；
- 消除内部 `expect`；
- 归档历史规划。

**Gate D：** 全平台测试/候选构建不能因为纯重构发生行为变化。

---

# 第九部分：提交与回滚策略

不再采用 V3 的“一个大工作批次内一次性全量落地”。建议 6 个可独立回滚的提交/PR 单元：

| Commit | 内容 | 可独立回滚 |
|---|---|---|
| C1 | CI stale path + source-layout checker | 是 |
| C2 | Shell contract SSOT + release semantics | 是 |
| C3 | Runtime ready contract / Node Host（按 VS Code 决策） | 是 |
| C4 | mobile capability + runtime smoke | 是 |
| C5 | client-runtime/bootstrap responsibility split | 是 |
| C6 | parity/test/docs/hygiene cleanup | 是 |

任何阶段如果 candidate 或 packaged-startup 红，回滚当前 commit，不把“后续会修”当成合并理由。

---

# 第十部分：最终验收标准

## 10.1 契约

- Shell API 只有一个语义明确的版本源；
- `manifest.json`、release manifest、Bridge、plugin、TS contract 不再出现未解释的 1/2 分裂；
- ready env / ready fields 有 SSOT；
- 故意制造 drift 时 CI 必须失败。

## 10.2 Desktop

- Rust Host 仍是桌面唯一 Runtime business host；
- Runtime start/stop/restart/safe-mode 主链不退化；
- Windows 安装包真实启动 E2E 通过；
- candidate workflow 不再引用已删除源码路径。

## 10.3 Mobile

- Android/iOS build 继续成功；
- mobile capability 最小授权；
- `platform_info` / `gateway_health` / `pair_gateway` runtime invoke smoke 通过；
- 不在移动端启动 Node；
- remote pairing flow 无需重写现有 UI。

## 10.4 VS Code

如果保留：

- `bundle` 产出 `dist/extension.cjs`；
- VSIX 可打包；
- Node Host ready 契约与 embedded plugin 一致，或 companion control plane 有明确协议。

如果不保留：

- `apps/vscode` 与只服务它的 host orchestration 清理干净；
- Runtime packaging 链仍完整。

## 10.5 CI / Security

- fmt / check / test / clippy 全部纳入；
- advisory/license/source 审计有明确 blocking/scheduled 分层；
- 不再通过在多个 workflow 复制源文件路径实现“架构锁”。

---

# 第十一部分：本轮明确不做的错误优化

1. **不因为 `mobile.rs` 是死文件就重写一套 mobile 功能**——真实 mobile entry 已在 `lib.rs`。
2. **不因为 `gen/android` 没提交就把 generated project 强行入库**——CI 已按需生成。
3. **不因为 VSCode `dist` 不在 Git 就认定扩展不可构建**——应增加 CI 证明，而不是提交 build output。
4. **不整体删除 `client-runtime`**——Tauri candidate 正在依赖它做 Runtime 打包与 smoke。
5. **不把 `/api/host/status` 直接塞进按需 Mobile Gateway**——这会混淆两个生命周期和安全边界。
6. **不以测试数量作为主要 KPI**——以关键行为和 failure-mode gate 为准。
7. **不把内部不变量 `expect` 当成已证实的用户可触发 P0**——防御性改造可以做，但不能抢占真实契约/发布问题优先级。
8. **不重复建设已经存在的 Windows packaged E2E 和 Android/iOS 真构建**——补缺口而不是重做。

---

# 附录 A：关键实证文件

| 结论 | 证据 |
|---|---|
| 当前 main 基线 | `b3a830e39b44ced2519c8a4ca9492889b8694444` |
| mobile 真入口 | `apps/tauri/src-tauri/src/lib.rs` |
| 孤儿 mobile adapter | `apps/tauri/src-tauri/src/mobile.rs` |
| mobile remote UI | `apps/tauri/web/app.js` |
| mobile platform profile | `apps/tauri/src-tauri/src/platform.rs` |
| Gateway client/pair | `apps/tauri/src-tauri/src/gateway.rs` |
| mobile CI 真构建 | `.github/workflows/tauri-ci.yml`、`.github/workflows/tauri-candidate.yml` |
| mobile capability 缺口 | `apps/tauri/src-tauri/capabilities/*.json` |
| Shell manifest v1 | `packages/plugin-harness-shell/manifest.json` |
| Shell runtime v2 | `packages/plugin-harness-shell/src/index.ts`、`packages/bootstrap/src/shell-contract.ts`、`packages/plugin-harness-shell/src/web/shell.js` |
| release 强制 v1 | `scripts/check-release.mjs`、`release-manifest.json` |
| shell gate 漏 manifest | `scripts/check-shell-package.mjs` |
| TS ready env 缺 binding | `packages/client-runtime/src/runtime.ts` |
| embedded ready fail-closed | `packages/plugin-embedded-client/src/index.ts` |
| client-runtime 仍承担发布工具 | `packages/client-runtime/package.json`、`.github/workflows/tauri-candidate.yml` |
| VS Code bundle 能力存在 | `apps/vscode/scripts/bundle.mjs` |
| Gateway 已有测试 | `apps/tauri/src-tauri/src/gateway.rs`、`gateway_host/mod.rs` |
| packaged real E2E | `.github/workflows/windows-packaged-startup.yml` |
| parity source-text helper | `tests/parity/rust-source.ts` |
| candidate stale path | `.github/workflows/tauri-candidate.yml` 中 `gateway_host.rs` 检查 |

---

# 附录 B：建议下一步实施顺序

如果马上进入代码实施，按以下顺序最安全：

```text
1. 修 tauri-candidate stale gateway_host.rs 检查
2. 建 Shell contract SSOT，解决 apiVersion 1/2 语义冲突
3. 补 mobile capability + invoke smoke
4. 明确 VS Code A/B/C 产品定位
5. 按产品定位修/移 Node Runtime Host ready contract
6. 切分 Runtime packaging 与 Runtime hosting 责任
7. 补 Runtime/Gateway 高价值行为测试
8. 删除被替代的源码字符串 parity
9. 加 clippy + security audit 分层
10. 最后做长函数、命名、常量、历史文档卫生清理
```

这个顺序优先修**会直接阻断发布或造成契约漂移的真实问题**，同时避免在产品边界尚未确认前大规模删除当前仍被 Tauri candidate 使用的构建代码。