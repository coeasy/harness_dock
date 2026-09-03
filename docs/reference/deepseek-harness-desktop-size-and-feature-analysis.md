# deepseek-harness-desktop 安装包体积与核心机制分析

> 日期：2026-09-03  
> 参考仓库：`dsh-tauri-desk/deepseek-harness-desktop`  
> 本文只记录可借鉴事实，不是 HarnessDock 的实施规范。HarnessDock 最终规范见 `../v0.2.0-architecture-five-round-final.md`。

---

# 1. 为什么参考项目安装包很小

参考项目 v0.10.2 的主要桌面资产大约：

| 平台/格式 | 大小约 |
| --- | ---: |
| Windows NSIS | 5.97 MB |
| Windows MSI | 9.44 MB |
| macOS arm64 DMG | 9.39 MB |
| macOS x64 DMG | 9.99 MB |
| Linux DEB | 11.65 MB |
| Linux AppImage | 89.92 MB |

真正原因不是把完整 Node+dsh 压缩到了几 MB，而是它把 Host 和 Runtime 分开：

```text
small Tauri installer
 -> first launch
 -> download Node
 -> download dsh package
 -> download package-manager/tooling when needed
```

它的资源说明明确写明：Node Runtime 与 `dependencies/dsh` 安装在用户 AppData，而不是安装器的固定 Full Runtime 中。独立 `deepseek-harness-pkg` 单个平台压缩资产本身约 41 MB，Node 另算。

因此，不能把参考项目约 6 MB 的 Windows NSIS 与“内置 Node+dsh 的 HarnessDock Full Installer”直接比较。

---

# 2. HarnessDock 明确不借鉴的机制

根据 v0.2.0 最终要求：

**桌面安装包必须内置 Node + dsh；首次启动不下载 Node 或 dsh。**

所以不采用：

- Host-only 默认 installer；
- first-run Node download；
- first-run dsh Core download；
- 没有 Runtime 时临时联网补齐；
- 后台悄悄替换正式 dsh Core；
- 为了小体积把 Runtime 生命周期拆出签名客户端 release。

正式 Runtime 与 HarnessDock Candidate SHA 绑定，客户端更新同时更新 Runtime。

---

# 3. 真正值得借鉴的体积优化

## 3.1 Tauri + 系统 WebView

参考项目使用 Tauri 2，不携带 Electron Chromium。这一方向 HarnessDock 已采用，也是减少 Host 自身尺寸的最大基础收益。

## 3.2 production dependency closure

参考项目内置插件使用类似 `pnpm deploy --prod` 的方式，只收集实际生产依赖，不把 monorepo 开发依赖整体复制进 installer。

HarnessDock 应贯彻同样原则：

```text
runtime package != workspace node_modules
```

只允许：

- pinned dsh production closure；
- Host 必需 integration production closure；
- target native dependencies。

## 3.3 target-native pruning

每个平台只保留本平台/架构需要的 native addon/prebuild：

- Windows x64 不带 darwin/linux binaries；
- macOS arm64 不带 macOS x64/Windows/Linux binaries；
- Linux glibc 不带 musl variants；
- universal wasm fallback 只有在真实运行链需要时才保留。

HarnessDock 已经有 sharp/node-pty/Koffi pruning，应继续扩大到所有可验证 native optional packages。

## 3.4 Node 官方发行包裁剪

这是 HarnessDock 在“必须内置 Node”条件下最值得新增的优化。

Node 官方压缩包是开发发行版，除了 Node executable 还包含：

- npm；
- npx；
- corepack；
- headers；
- man/docs；
- 安装 helper。

HarnessDock Runtime 的 dsh production closure 在 Candidate 构建阶段已经准备完成，正常启动只需要 Node executable。因此正式 Runtime 可保留：

```text
node.exe | bin/node
LICENSE
```

并删除 Node 自带 package-manager/development payload。

注意：这不等于删除 dsh root `node_modules`。Windows Node 自带 `node_modules/npm` 与 dsh production closure 可能位于同一 root，必须只删除 npm/corepack 子树。

## 3.5 前端/插件资源边界

参考项目把 preset catalog 作为小 JSON，把真实社区插件按需安装，而不是全部打进应用。

HarnessDock 可以借鉴：

- catalog/manifest 打包；
- 社区插件不预装；
- 只有 Host 必需插件进入 installer；
- 必需插件只打 production closure。

这不会违反“Node+dsh 必须内置”。

---

# 4. 值得借鉴的核心功能

## Runtime/Core

可借鉴：

- Runtime/Core 版本展示；
- integrity/self-check；
- 错误诊断；
- local environment 检测作为开发信息。

不直接借鉴它的“在线 Core 多版本切换”作为 v0.2.0 正式主路径。HarnessDock 的正式 dsh 版本由客户端 Candidate 固定。

## Plugin

值得借鉴：

- 推荐插件 catalog；
- plugin list/status；
- add/remove/update；
- plugin error details；
- 内置 integration auto-heal；
- first-run plugin recommendation 可选，但不能阻塞 Harness Web。

HarnessDock 还应保留自己更强的 quarantine/safe-profile recovery。

## Profile

值得借鉴：

- profile list；
- active profile；
- 快速切换；
- 不同 profile 的 plugin/settings isolation。

但 Profile 数据仍由 dsh 真实机制管理，不做第二套数据库。

## CLI integration

参考项目安装后提供 `dsh` 命令的体验值得借鉴。

HarnessDock 更合适的做法：生成 shim 指向**安装包内置 Node+dsh**，而不是再安装另一套 Runtime。

## Native desktop

可借鉴：

- single-instance；
- autostart；
- native notifications；
- clipboard；
- external URL opener；
- zoom；
- tray；
- native menu；
- window-state restore；
- context menu。

这些能力应在 Host Capability 层实现，不能让 Harness Web 任意获得高权限 Tauri API。

## DSH extension ecosystem

Worktree、Skills/MCP、Archived Chats、Right-click、Sidebar 等功能适合作为独立 dsh plugin / Shell extension，而不是 Host Kernel 核心。

---

# 5. HarnessDock 的最终体积策略

不是：

```text
remove Runtime from installer -> 6 MB
```

而是：

```text
Full Installer
  = optimized Tauri Host
  + compact Node executable distribution
  + exact dsh production closure
  + target-native dependencies
  + minimal Host integration closure
```

第一阶段 size budget：

| Artifact | Budget |
| --- | ---: |
| Windows NSIS | <= 150 MB |
| Windows MSI | <= 170 MB |
| macOS DMG | <= 180 MB |
| Linux DEB | <= 160 MB |
| Linux AppImage | <= 190 MB |

每轮 Candidate 都应输出分层 byte report，继续根据真实数据收紧，而不是通过取消离线能力换取漂亮的安装包数字。
