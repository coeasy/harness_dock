# HarnessDock 文档索引

## 当前有效架构基线

HarnessDock v0.2.0 的最新重构不兼容旧 Host 架构、旧 Electron 方案、旧 Host Bridge 或历史 v0.2.x 过渡设计。

后续实现以以下两份文档为唯一架构与执行基线：

1. [`v0.2.0-architecture-rebuild-final.md`](./v0.2.0-architecture-rebuild-final.md)  
   最终产品定位、Host Kernel、Actor、Runtime Lease、Reconciler、Shell v2、Gateway v2、安全与发布架构。
2. [`plan/v0.2.0-three-round-rebuild-plan.md`](./plan/v0.2.0-three-round-rebuild-plan.md)  
   三轮重构实施顺序、每轮删除项、验收条件、禁止回退规则和最终完成定义。

## 历史文档

以下类型文档仅用于理解项目演进，不再是实现约束：

- `upgrade-refactor-plan.md`
- `upgrade-refactor-plan-v2.md`
- `plan/v0.2.0-client-platform-upgrade-plan.md`
- `plan/v0.2.0-core-chain-hardening.md`
- `plan/v0.2.0-host-core-architecture.md`
- `plan/v0.2.0-shell-first-implementation.md`
- 历史 `v0.2.1` / `v0.2.6` / `v0.2.7` / `v0.2.8` / `v0.2.9` 方案

如果历史文档与当前两份基线冲突，**以当前 v0.2.0 最终架构文档为准**。

## 核心方向

```text
Tauri Adapter
  -> Host Protocol v2
  -> Host Kernel
  -> Desired-State Reconciler
  -> Resource Actors
       RuntimeActor
       SurfaceActor
       GatewayActor
       UpdateActor
  -> Runtime Lease / Capability Broker
```

正常启动的唯一产品主链路仍然是：

```text
Native Host -> Runtime -> Harness Web
```

Recovery、Gateway、Diagnostics 都是按需 Surface；Shell 是 fail-open 展示扩展，不是 Runtime/Harness Web 的启动依赖。