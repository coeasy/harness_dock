# HarnessDock 文档索引

## 当前活动版本

HarnessDock 当前产品版本：**v0.1.2**。

当前锁定的 DeepSeek Harness Runtime：**`dsh-v0.1.2-rc.1`**，commit `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。

桌面产品不再使用 Electron。唯一桌面宿主为 `apps/tauri`，正常启动链路是：

```text
Tauri Native Host
  -> sealed Full Runtime
  -> RuntimeLease
  -> Harness WebView
  -> Harness Web
  -> optional Harness Shell
```

安装包必须内置 Node + pinned dsh + 必要 Runtime Tool；首次启动不下载 Node/dsh。Harness Web 是唯一正常主业务 Surface，Recovery / Gateway / Diagnostics / Update 均为按需能力。

## 版本规则

从 v0.1.2 起：

- HarnessDock 产品版本使用 pinned 最新 dsh 的**基础 SemVer**；
- 上游 `-rc.* / -beta.* / -alpha.*` 后缀只保留在 Runtime provenance；
- 例如 `dsh-v0.1.2-rc.1 -> HarnessDock 0.1.2`；
- Release gate 会检查 root/workspace/Tauri/Rust/Shell/origin/manifest 版本一致，并检查 HarnessDock 与 dsh 基础 SemVer 一致；
- Runtime `version + gitTag + gitCommit` 必须在 `release-manifest.json` 与 `origin.json` 完全一致。

详见 [`VERSIONING.md`](./VERSIONING.md)。

## 当前使用文档

1. [`../README.md`](../README.md)  
   用户入口、平台支持、安装使用、核心能力、发布门禁。
2. [`PROJECT_INTRO.md`](./PROJECT_INTRO.md)  
   项目定位、架构边界、开发和发布说明。
3. [`../apps/tauri/README.md`](../apps/tauri/README.md)  
   Tauri Native Host、Runtime、WebView、Shell、Gateway 与构建说明。
4. [`VERSIONING.md`](./VERSIONING.md)  
   HarnessDock 与 DeepSeek Harness/dsh 的版本对齐政策。
5. [`../.github/release-notes/v0.1.2-beta.1.md`](../.github/release-notes/v0.1.2-beta.1.md)  
   当前测试版发布说明。

## 当前架构不变量

- 桌面：Full Runtime，首启零下载。
- 移动：Remote Gateway only，不在 Android/iOS 内启动 Node/dsh。
- 正常启动：Runtime ready 后直接显示 Harness Web，不先打开设置页。
- Shell：独立、可选、fail-open；Shell 故障必须回退原生窗口控件。
- WebView：只允许当前 RuntimeLease 对应的 `127.0.0.1` origin。
- 生命周期：Runtime/Gateway/Surface/Update 通过 Host Kernel、Reconciler 和 Actor 状态管理，避免孤儿逻辑与重复并发操作。
- 插件：异常进入隔离/恢复流程，不让第三方插件故障终止主客户端。
- 发布：只接受同一 `main` SHA 的绿色 CI 与 candidate 资产。

## 历史架构设计文档

仓库中保留了一组文件名含 `v0.2.0` / `v0.2.x` 的设计稿，例如：

- `v0.2.0-architecture-five-round-final.md`
- `plan/v0.2.0-five-round-rebuild-plan.md`
- `plan/v0.2.0-leading-client-architecture-three-round-optimization-final.md`
- `plan/v0.2.0-embedded-runtime-tooling.md`

这些文档记录了 Native Host 重构过程和架构决策，**文件名是历史设计阶段标签，不再定义当前产品版本**。如历史文档与当前代码、`release-manifest.json`、根 README 或本索引冲突，以当前活动版本和代码契约为准。

以下更早内容同样只作为演进记录：

- `v0.2.0-architecture-rebuild-final.md`
- `plan/v0.2.0-three-round-rebuild-plan.md`
- `upgrade-refactor-plan.md`
- `upgrade-refactor-plan-v2.md`
- 历史 `v0.2.1` / `v0.2.6` / `v0.2.7` / `v0.2.8` / `v0.2.9` 方案

历史文档中的 Electron、Host-only 默认安装包、first-run Node/dsh download、Host Bridge v1 等路径不得重新成为当前主路径。
