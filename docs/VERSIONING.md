# HarnessDock 版本与上游对齐策略

## 目标

HarnessDock 的产品版本用于表达“当前客户端对应哪一代 DeepSeek Harness/dsh 能力”，同时保留上游 Runtime 的精确可复现来源。

从 HarnessDock v0.1.2 起采用以下规则。

## 1. 产品版本跟随 dsh 基础 SemVer

HarnessDock 版本 = 当前发布所锁定 dsh 版本去掉预发布后缀后的 `MAJOR.MINOR.PATCH`。

示例：

```text
dsh-v0.1.2-rc.1   -> HarnessDock 0.1.2
dsh-v0.1.2         -> HarnessDock 0.1.2
dsh-v0.1.3-alpha.4 -> HarnessDock 0.1.3
dsh-v1.0.0-beta.1  -> HarnessDock 1.0.0
```

这意味着 dsh 在同一个基础版本内从 alpha -> beta -> rc -> stable 演进时，HarnessDock 可以保持同一个产品版本，但必须更新 Runtime provenance 和候选产物，并重新通过发布门禁。

## 2. Runtime 必须精确锁定

`packages/docs-sync/origin.json` 与 `release-manifest.json` 必须同时记录：

- 精确 `dshVersion`；
- 精确 `gitTag`；
- 精确 `gitCommit`。

当前 v0.1.2：

```text
HarnessDock: 0.1.2
dshVersion:  0.1.2-rc.1
gitTag:      dsh-v0.1.2-rc.1
gitCommit:   a66e4702047846cdaa10c66c9d3df3951f5ea70d
```

禁止使用 `latest`、`next` 或未固定 commit 的 Runtime 进入发布候选。

## 3. 所有活动产品版本必须一致

以下位置必须与根 `package.json.version` 相等：

- 根 `package.json`；
- 所有 pnpm workspace package；
- `apps/tauri/src-tauri/tauri.conf.json`；
- `apps/tauri/src-tauri/Cargo.toml`；
- `apps/tauri/src-tauri/Cargo.lock` 中 `harnessdock-tauri`；
- `packages/plugin-harness-shell/package.json`；
- `packages/plugin-harness-shell/manifest.json`；
- Shell source/bundle version；
- `packages/docs-sync/origin.json.clientVersion`；
- `release-manifest.json.version` 与 `shell.version`；
- 当前用户可见版本文案。

`pnpm check:versions` 负责机器校验这些不变量。

## 4. Release gate

`pnpm check:release` 在发布前额外检查：

1. HarnessDock 版本等于 pinned dsh 的基础 SemVer；
2. Runtime version/tag/commit 在 manifest 与 origin 中完全一致；
3. 不允许 floating dsh version；
4. Runtime 发生跨基础版本变化时，客户端发布身份必须同步变化；
5. beta Runtime bundle URL 必须指向当前 HarnessDock beta tag。

## 5. 上游升级流程

发现新的 dsh tag 后按以下顺序处理：

```text
确认上游最新 tag + commit
  -> 更新 origin.json Runtime provenance
  -> 计算 dsh 基础 SemVer
  -> 对齐 HarnessDock/root/workspace/Tauri/Rust/Shell 版本
  -> 更新 Runtime bundle Release URL
  -> 更新当前文档与 Release Notes
  -> pnpm check:versions
  -> pnpm check:release
  -> 全量 CI / Tauri candidate
  -> 同 SHA 发布
```

如果上游只在同一基础 SemVer 内更新预发布后缀，例如 `0.1.2-rc.1 -> 0.1.2`，HarnessDock 产品版本仍为 `0.1.2`，但必须产生新的、可区分的发布候选标识；不得覆盖已经发布的不可变资产。

## 6. 历史 `v0.2.x` 文件名

仓库历史设计稿曾使用 `v0.2.x` 作为架构阶段标签。当前已经重新校正产品版本到 `v0.1.2`；这些历史文件名不再作为产品版本来源，也不得参与发布版本判断。

活动版本的唯一权威来源是根 `package.json`，发布关系由 `release-manifest.json` 与 `packages/docs-sync/origin.json` 补充描述。
