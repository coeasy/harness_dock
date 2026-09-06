# HarnessDock V4.2 实施记录：Host Kernel / WebFirst / 插件隔离

> 产品版本：`0.1.2`  
> 目标：在 V4 契约收敛基础上完成 Host Kernel 高层生命周期、WebFirst 启动架构以及插件故障域隔离，并以真实发布门禁重新发布 `v0.1.2` 测试预发布版本。

## 1. Host Kernel 完整化

V4.2 **没有再创建第二套可变 Host 状态机**。现有 Resource Actors 继续是唯一生命周期真相源：

- `RuntimeActor`
- `SurfaceActor`
- `GatewayActor`
- `UpdateActor`

新增高层 `HostPhase` 只是 `HostReadModel` 的纯派生投影：

```text
Booting
  -> RuntimeStarting
  -> RuntimeReady
  -> WebLoading
  -> Running

任意明确故障 -> Recovering
quitting=true -> ShuttingDown
```

这样 Native menu、Host Protocol、diagnostics、shutdown 等消费者可以读取统一 Host 生命周期，而不会出现“Host 状态已 Running，但 RuntimeActor 仍 Starting”一类双真相源漂移。

## 2. WebFirst 启动架构

桌面启动改为：

```text
Process started
  -> 本地 WebFirst surface 立即可见
  -> sealed Runtime 后台启动
  -> generation/nonce/imageIdentity/PID 绑定 ready.json
  -> browser-faithful Harness HTML readiness
  -> RuntimeLease 发布
  -> Harness WebView navigation
  -> listener/origin/generation 再验证
  -> Harness HTML Finished
  -> 原子切换到 Harness Web
```

关键规则：

1. 正常启动不显示 Node/dsh 预检界面，也不检测系统 Node。
2. Runtime 尚未 ready 时不出现空白桌面；本地 WebFirst surface 持续可见。
3. WebFirst surface 不是 Runtime ready 信号，不能绕过 `ready.json`。
4. Harness Web 只有在 generation、origin、loopback listener 和实际 page-load 都通过后才能成为 primary surface。
5. 用户在 WebFirst 阶段主动关闭窗口会触发完整 Supervisor 退出，不能留下后台 Runtime。
6. Runtime/Loader/插件失败进入明确 recovery，不能把 Chromium/WebView2 网络错误页当成成功页面。

## 3. 插件生态隔离

插件故障域划分为三类：

### 3.1 官方 Runtime 插件

`@deepseek-ai/*` 以及官方 node_modules 路径不进入 HarnessDock quarantine。

### 3.2 HarnessDock Host 自有插件

以下 ID 永远不能被 quarantine：

- `embedded-client`
- `harnessdock-client-runtime-compat`
- `harness-shell`

保护同时存在于：

- recovery candidate 选择；
- recovery patch 生成；
- quarantine 写入；
- quarantine 持久化读取。

因此即使 quarantine JSON 被手工修改、部分损坏或来自旧代码，也不能通过隔离 Host 自有插件破坏 ready contract 或 Shell fallback。

### 3.3 第三方/用户插件

只有第三方和用户增加的 plugin rows 进入故障隔离集合：

```text
normal boot failure
  -> boot-free config discovery
  -> diagnostic attribution
  -> 隔离全部外部插件做 recovery boot
  -> 成功后写 Host-owned quarantine
  -> 后续启动复用有时限的 quarantine
```

用户配置本身不被 HarnessDock 修改。

## 4. Quarantine schema v2

Rust Host 与 Node Host 统一以下语义：

- 新记录使用 schema v2；
- 记录携带 dsh 基础版本；
- `0.1.2-rc.1 -> 0.1.2-rc.2 -> 0.1.2` 可继续沿用已证明的隔离集合；
- `0.1.2 -> 0.2.0` 自动失效；
- schema v1 仅按精确版本兼容读取；
- 过期记录自动失效；
- Host 自有 plugin ID 出现在 isolation set 时记录立即失效。

## 5. 不变安全约束

V4.2 不允许通过以下方式换取 CI 绿色：

- 恢复 stdout URL 作为 ready 信号；
- 放宽 generation/nonce/imageIdentity/PID 绑定；
- 允许桌面 WebView 导航到非 `127.0.0.1` 的本地 Runtime origin；
- 给 mobile 下放 desktop Runtime 权限；
- 恢复 Electron；
- 插件异常阻断 Harness Web 的 native-control fallback；
- 跳过真实安装包启动验证。

## 6. 发布门禁

`v0.1.2` 只有在同一个 `main` SHA 同时满足以下条件后才能发布：

1. `ci` 全绿；
2. `tauri-ci` / 三平台核心构建全绿；
3. `tauri-candidate` 成功并生成精确候选产物；
4. Windows 安装后的真实 `windows-packaged-startup` 成功；
5. Runtime ready -> Lease -> Harness HTML -> primary visible 主链真实通过；
6. Release 从同一个 successful candidate run 组装资产；
7. tag 必须指向该 `main` SHA；
8. `v0.1.2` 作为测试 prerelease 发布，不补充证书。

## 7. 最终架构边界

```text
Native UI / Harness Shell
          |
          v
      Host Kernel
          |
      Reconciler
     /    |     \
Runtime Surface Gateway  Update Actors
   |       |
RuntimeLease| generation-bound navigation
   |       v
sealed dsh -> Harness Web

Plugin fault domain:
Official + Host-owned  !=  External/User quarantine
```

本文件记录 V4.2 的落地边界。后续结构重构如果改变文件位置，不应改变以上契约和故障域。