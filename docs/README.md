# HarnessDock 文档索引

## 当前唯一有效架构基线

HarnessDock v0.2.0 的最新重构不兼容旧 Host 架构、旧 Electron 方案、旧 Host Bridge、隐藏控制页或历史 v0.2.x 过渡设计。

后续实现只以以下两份文档为架构与执行基线：

1. [`v0.2.0-architecture-five-round-final.md`](./v0.2.0-architecture-five-round-final.md)  
   **唯一架构设计基线**。定义 Native Host Kernel、Host Protocol v2、Resource Actor、Runtime Lease、Desired-State Reconciler、Recovery Policy、Capability Broker、Native Gateway、可验证状态机、性能与 Release Graph。
2. [`plan/v0.2.0-five-round-rebuild-plan.md`](./plan/v0.2.0-five-round-rebuild-plan.md)  
   **唯一实施计划**。定义五轮连续重构、每轮删除项、建设项、审计项、故障修复规则、自动化门禁和最终完成定义。

如果任何其它文档与上述两份基线冲突，**以上述五轮架构基线为准**。

## 五轮重构路线

```text
Round 1  Protocol + Kernel + Adapter 边界重建
Round 2  Resource Actor + 显式状态机 + 唯一资源所有权
Round 3  RuntimeLease + Resource Graph + Reconciler + Recovery Policy
Round 4  Capability Broker + Protocol Codegen + Native Gateway + Security Contract
Round 5  Model/Property/Fault Test + Performance + Release Graph + 最终清理
```

五轮不是重复检查同一套代码，而是五次连续架构收敛。每轮发现的主链、状态、安全和发布问题必须在本轮修复完毕后才能进入下一轮。

## 最终核心方向

```text
                           Tauri Adapter
                                |
                       Host Protocol v2
                                |
                         Capability Broker
                                |
                            Host Kernel
                                |
                    Desired State / Event Bus
                                |
                          Reconciler + Policy
                                |
               +----------------+----------------+
               |                |                |
          RuntimeActor      SurfaceActor      UpdateActor
               |
          RuntimeLease
               |
          GatewayActor

      Diagnostics <- typed snapshots + bounded journal
      Shell       <- host-sdk + capability snapshot
      Mobile      <- HTTPS Gateway only
```

正常启动唯一主链：

```text
Native Host -> RuntimeActor -> RuntimeLease -> HarnessSurface -> Harness Web
```

Recovery、Gateway、Diagnostics 全部按需创建；Shell 是 fail-open 展示扩展，不是 Runtime/Harness Web 的启动依赖。

## 历史文档

以下文档仅保留用于理解项目演进，不再是实现约束：

- `v0.2.0-architecture-rebuild-final.md`
- `plan/v0.2.0-three-round-rebuild-plan.md`
- `upgrade-refactor-plan.md`
- `upgrade-refactor-plan-v2.md`
- `plan/v0.2.0-client-platform-upgrade-plan.md`
- `plan/v0.2.0-core-chain-hardening.md`
- `plan/v0.2.0-host-core-architecture.md`
- `plan/v0.2.0-shell-first-implementation.md`
- 历史 `v0.2.1` / `v0.2.6` / `v0.2.7` / `v0.2.8` / `v0.2.9` 方案

历史文档中的 Electron、Host Bridge v1、隐藏控制页、多 AtomicBool 生命周期、Node Gateway sidecar 主路径、旧 IPC 兼容等设计均不得重新进入新架构。
