# HarnessDock 文档索引

## 当前唯一有效架构基线

HarnessDock v0.2.0 的桌面分发策略已经最终确定：

**安装包必须内置 Node + dsh；首次启动不下载 Node 或 dsh；断网仍可直接启动 Harness Web。**

后续实现只以以下两份文档为架构与执行基线：

1. [`v0.2.0-architecture-five-round-final.md`](./v0.2.0-architecture-five-round-final.md)  
   **唯一架构设计基线**。定义 Native Host Kernel、Immutable Embedded Runtime、Host Protocol v2、Resource Actor、RuntimeLease、Reconciler、Capability Broker、Native Gateway、体积与 Release 不变量。
2. [`plan/v0.2.0-five-round-rebuild-plan.md`](./plan/v0.2.0-five-round-rebuild-plan.md)  
   **唯一实施计划**。定义五轮连续开发、删除项、建设项、审计项、自动化门禁和最终完成条件。

事实参考：

- [`reference/deepseek-harness-desktop-size-and-feature-analysis.md`](./reference/deepseek-harness-desktop-size-and-feature-analysis.md)  
  解释参考项目为什么安装包小，以及哪些机制可借鉴。注意：参考项目的 first-run Runtime download **不属于 HarnessDock 最终方案**。

如果任何其它文档与上述两份基线冲突，以当前五轮架构基线为准。

## 最终桌面主链

```text
Signed Full Installer
  -> embedded compact Node + pinned dsh
  -> Tauri Adapter
  -> Host Protocol v2
  -> Host Kernel
  -> RuntimeActor
  -> RuntimeLease
  -> HarnessSurface
  -> Harness Web
```

首次启动没有 Runtime 下载阶段。

## 五轮路线

```text
Round 1  Protocol + Adapter + Embedded Full Runtime Contract
Round 2  RuntimeActor + Compact Immutable Runtime Image
Round 3  RuntimeLease + Resource Graph + Reconciler + Surface/Recovery
Round 4  Capability Broker + Native Gateway + Shell v2 + CLI/Profile/Plugin
Round 5  Model/Fault Tests + Performance/Size SLO + Release Graph + Cleanup
```

## 当前实施状态

Round 1 已开始：

- `lib.rs` 已恢复 composition-root 方向；
- `bridge.rs / desktop.rs / service/workflow.rs` 已建立；
- Tray/Menu 开始统一使用 typed Host intent；
- Host Protocol v2 typed model 已开始落地；
- Full Runtime candidate pipeline 保持 Node+dsh 内置；
- 新增 Node 官方发行包瘦身；
- 正在把 embedded-runtime contract 固化为 CI 门禁。

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
