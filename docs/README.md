# HarnessDock 文档索引

## 当前唯一有效架构基线

HarnessDock v0.2.0 的最新重构不兼容旧 Host 架构、旧 Electron、Host Bridge v1、隐藏控制页、历史 Full Runtime 默认分发或旧 v0.2.x 过渡设计。

后续实现只以以下文档为当前基线：

1. [`v0.2.0-architecture-five-round-final.md`](./v0.2.0-architecture-five-round-final.md)  
   **唯一架构设计基线**。定义轻量 Native Host、Host Protocol v2、Layered Runtime Store、Resource Actor、Runtime Lease、Desired-State Reconciler、Recovery Policy、Capability Broker、Native Gateway、CLI、可验证状态机、体积/性能 SLO 与 Host/Runtime Release Graph。
2. [`plan/v0.2.0-five-round-rebuild-plan.md`](./plan/v0.2.0-five-round-rebuild-plan.md)  
   **唯一实施计划**。定义五轮连续重构、每轮删除项、建设项、体积目标、Runtime bootstrap、回滚、审计项、故障修复规则、自动化门禁和最终完成定义。
3. [`reference/deepseek-harness-desktop-size-and-feature-analysis.md`](./reference/deepseek-harness-desktop-size-and-feature-analysis.md)  
   **参考事实分析**。解释 `dsh-tauri-desk/deepseek-harness-desktop` 为什么安装包很小、真实 Runtime 如何后置下载、哪些下载/Core/CLI/插件/Native 功能值得借鉴，以及哪些机制不应照搬。

如果任何其它文档与前两份基线冲突，**以前两份五轮架构文档为准**。参考分析只提供事实和决策依据。

---

# 最新核心方向

```text
                      Small Tauri Host Installer
                                |
                       Host Protocol v2
                                |
                         Capability Broker
                                |
                            Host Kernel
                                |
                 +--------------+---------------+
                 |                              |
          Runtime Store Actor              Event Bus
                 |
       Signed Layered Runtime Image
      Node + DSH + Integration layers
                 |
            RuntimeActor
                 |
            RuntimeLease
                 |
          +------+------+
          |             |
    SurfaceActor    GatewayActor
          |
      Harness Web
```

默认安装器不再包含完整 Node/dsh Runtime。

首次无 Runtime：

```text
Host -> Bootstrap -> Resolve signed manifest -> Download layers
     -> Verify -> Atomic activate -> Runtime -> Harness Web
```

已有 Runtime：

```text
Host -> Active Runtime Image -> Runtime -> Harness Web
```

离线 Full Bundle 是独立可选产物，不再强迫所有用户下载完整 Runtime。

---

# 五轮重构路线

```text
Round 1
Protocol + Kernel + Adapter + Host-only Packaging + Size Baseline

Round 2
Layered Runtime Store + Resume/Retry/Verify + RuntimeActor

Round 3
RuntimeLease + Resource Graph + Reconciler + Surface + Multi-version Rollback

Round 4
Capability Broker + Native Gateway + Shell v2 + CLI + Plugin Integration

Round 5
Model/Property/Fault Test + Performance/Size SLO + Host/Runtime Release Graph + Cleanup
```

每轮发现的结构、状态、安全、下载、主链、体积和发布问题必须在本轮清零后才能进入下一轮。

---

# 关键产品不变量

1. Harness Web 始终是唯一主业务界面。
2. 正常启动不依赖隐藏控制页。
3. Shell/Tray/Diagnostics/Updater/Gateway 管理失败不能阻断健康 Harness Web。
4. 默认正式 Runtime 来自经过签名验证的 Managed Runtime Image。
5. System Node/dsh 只能是显式 Advanced/Developer Provider，不是默认主路径。
6. Runtime、Surface、Gateway 通过 generation-bound RuntimeLease 关联。
7. Runtime/Gateway 不使用多个 AtomicBool 拼生命周期。
8. UI 不手工编排 stop/start/restart。
9. 默认 Host Installer 不携带完整 Node/dsh。
10. Runtime 更新与 Desktop Host 更新是独立 transaction。
11. Node 未变化时，dsh 更新不应重复下载 Node layer。
12. Host-required integration 只按 production dependency closure 打包。
13. Community plugin 不进入默认 Host Installer。
14. Runtime layer 必须先验证 digest/signature 再激活。
15. Candidate Runtime 失败必须可以回滚 previous。
16. Remote/mobile 页面永远没有 desktop privileged capability。
17. 当前 head 才能作为 CI/Release 证据。

---

# 体积目标

CI 预算：

| Artifact | Budget |
| --- | ---: |
| Windows NSIS | <= 15 MB |
| Windows MSI | <= 20 MB |
| macOS DMG | <= 20 MB |
| Linux DEB | <= 25 MB |
| Linux AppImage | <= 100 MB |
| Host Integration Layer | <= 10 MB |
| Runtime Image compressed | <= 100 MB |

参考项目当前真实 Release 证明 Windows/macOS Host-only 安装器可以做到约 6~10 MB 量级；HarnessDock 的预算保留 updater、protocol、recovery、安全校验等余量。

---

# 历史文档

以下文档仅用于理解演进，不再约束实现：

- `v0.2.0-architecture-rebuild-final.md`
- `plan/v0.2.0-three-round-rebuild-plan.md`
- `upgrade-refactor-plan.md`
- `upgrade-refactor-plan-v2.md`
- `plan/v0.2.0-client-platform-upgrade-plan.md`
- `plan/v0.2.0-core-chain-hardening.md`
- `plan/v0.2.0-host-core-architecture.md`
- `plan/v0.2.0-shell-first-implementation.md`
- 历史 `v0.2.1` / `v0.2.6` / `v0.2.7` / `v0.2.8` / `v0.2.9` 方案

历史文档中的 Electron、Host Bridge v1、hidden main、多 AtomicBool、Node Gateway sidecar 主路径、默认 Full Runtime Host package、旧 IPC 兼容等机制均不得重新进入新架构。
