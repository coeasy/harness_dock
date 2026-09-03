# HarnessDock 文档索引

## 当前唯一有效架构基线

HarnessDock v0.2.0 的桌面分发策略已经最终确定：

**安装包必须内置 Node + dsh；首次启动不下载 Node 或 dsh；断网仍可直接启动 Harness Web。**

后续实现只以以下两份文档为架构与执行基线：

1. [`v0.2.0-architecture-five-round-final.md`](./v0.2.0-architecture-five-round-final.md)  
   **唯一架构设计基线**。定义 Native Host Kernel、Immutable Embedded Runtime、Host Protocol v2、Resource Actor、RuntimeLease、Reconciler、Capability Broker、Native Gateway、体积与 Release 不变量。
2. [`plan/v0.2.0-five-round-rebuild-plan.md`](./plan/v0.2.0-five-round-rebuild-plan.md)  
   **唯一五轮实施计划**。定义五轮连续开发、删除项、建设项、审计项、自动化门禁和最终完成条件。

当前有效实施补充：

- [`plan/v0.2.0-leading-client-architecture-three-round-optimization-final.md`](./plan/v0.2.0-leading-client-architecture-three-round-optimization-final.md)  
  **五轮架构之后的三轮生产化收口方案**。对标 VS Code Agent/Extension Host、Chromium Site Isolation、Tauri v2 Capability 与现代软件供应链，继续收敛 HostKernelTask、真正 Reconciler、HostEvent、single-instance、RuntimeSupervisor、Native Gateway HTTP stack、Plugin/Profile transaction、diagnostics、SBOM 与 artifact provenance。该文档不改变 Full Runtime 产品定义。
- [`plan/v0.2.0-embedded-runtime-tooling.md`](./plan/v0.2.0-embedded-runtime-tooling.md)  
  定义 Full Runtime 的工具层：Node 自带 npm/corepack 可裁剪，但必须内置 pinned pnpm 并通过受控 Runtime execution environment 提供给 `dsh plugin`，从而保持插件安装/更新能力而不依赖用户系统 pnpm。

事实参考：

- [`reference/deepseek-harness-desktop-size-and-feature-analysis.md`](./reference/deepseek-harness-desktop-size-and-feature-analysis.md)  
  解释参考项目为什么安装包小，以及哪些机制可借鉴。注意：参考项目的 first-run Runtime download **不属于 HarnessDock 最终方案**。

如果任何其它文档与上述基线冲突，以当前五轮架构基线、三轮生产化收口方案和 Embedded Runtime Tooling Contract 为准；其中三轮方案只能继续收紧控制平面和安全边界，不能反向改变“Full Runtime 内置、首启零下载、Harness Web 为唯一主业务 Surface”的产品不变量。

## 最终桌面主链

```text
Signed Full Installer
  -> embedded compact Node + pinned dsh + pinned pnpm tool
  -> Tauri Adapter
  -> Host Protocol
  -> Host Kernel
  -> RuntimeActor
  -> RuntimeLease
  -> HarnessSurface
  -> Harness Web
```

首次启动没有 Runtime 下载阶段。

## 五轮基础路线

```text
Round 1  Protocol + Adapter + Embedded Full Runtime Contract
Round 2  RuntimeActor + Compact Immutable Runtime Image
Round 3  RuntimeLease + Resource Graph + Reconciler + Surface/Recovery
Round 4  Capability Broker + Native Gateway + Shell v2 + CLI/Profile/Plugin
Round 5  Model/Fault Tests + Performance/Size SLO + Release Graph + Cleanup
```

## 三轮生产化补充路线

```text
Optimization Round A  Control Plane + Trust Boundary
Optimization Round B  Supervision + Gateway + Plugin Transaction
Optimization Round C  Production Proof + Supply Chain + Observability
```

重点不是再换一次技术栈，而是把现有先进组件真正连成一条单一控制链：

```text
command
 -> capability
 -> desired state
 -> reconciler
 -> resource actor
 -> event
 -> snapshot/resync
```

## 当前实施状态

当前实现已经跨越早期 Round 1：

- `lib.rs` 已恢复 composition-root 方向；
- `bridge.rs / desktop.rs / service/workflow.rs` 已建立；
- Tray/Menu 已使用 typed Host intent；
- Host Protocol v2 canonical schema/codegen 已存在；
- RuntimeActor / RuntimeGeneration / RuntimeLease 已落地；
- SurfaceActor / GatewayActor / UpdateActor 已落地；
- Capability Broker 已存在；
- Full Runtime candidate pipeline 保持 Node+dsh 内置；
- Node 官方发行包已进入瘦身和 Runtime image identity 路线；
- pinned pnpm 作为独立 Runtime Tool 内置，避免 `dsh plugin` 依赖系统 pnpm；
- embedded-runtime contract 已接入 CI；
- Native Gateway 已替代 Node Gateway sidecar 主路径。

但当前 PR head 仍未达到最终完成条件：`ci / tauri-ci / upstream-compat` 仍需在同一最新 SHA 上全部变绿；legacy IPC、真正 Reconciler、HostEvent、single-instance、主动 Supervisor、Plugin/Profile transaction、Gateway 成熟 HTTP stack、SBOM/provenance 等继续按照三轮优化方案收尾。

## 历史文档

以下仅用于理解项目演进，不再约束实现：

- `v0.2.0-architecture-rebuild-final.md`
- `plan/v0.2.0-three-round-rebuild-plan.md`
- `upgrade-refactor-plan.md`
- `upgrade-refactor-plan-v2.md`
- `plan/v0.2.0-client-platform-upgrade-plan.md`
- `plan/v0.2.0-core-chain-hardening.md`
- `plan/v0.2.0-host-core-architecture.md`
- `plan/v0.2.0-shell-first-implementation.md`
- 历史 `v0.2.1` / `v0.2.6` / `v0.2.7` / `v0.2.8` / `v0.2.9` 方案

历史文档中的 Electron、Host-only 默认安装包、first-run Node/dsh download、Host Bridge v1、隐藏控制页、多 AtomicBool 最终状态模型等都不得重新成为新架构主路径。
