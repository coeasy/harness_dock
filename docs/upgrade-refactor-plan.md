# HarnessDock 升级重构方案（历史文档）

> ⚠️ **本文档已归档**：Phase D/E/F 已全部落地，剩余项（签名、channel）已并入
> [`docs/upgrade-refactor-plan-v2.md`](./upgrade-refactor-plan-v2.md)（Phase G–K）。请以 v2 为准。

> v0.2.0 已改为 Tauri-only；本文中的 Electron 构建、更新和 E2E 描述不再适用于当前代码。

> 状态：规划稿（基于 2026-08-27 仓库现状梳理）
> 范围：全仓（apps/desktop、apps/vscode、packages/*、scripts、CI）
> 前置阅读：`docs/PROJECT_INTRO.md`（项目介绍）、`docs/auto-update-assessment.md`（Phase A/B 已落地）

---

## 1. 项目现状：功能全景

### 1.1 已实现能力清单

| 能力 | 实现位置 | 状态 |
| --- | --- | --- |
| 薄壳嵌入官方 Web UI（不 fork、不劫持） | `apps/desktop/src/main.ts` + `plugin-embedded-client` | ✅ 稳定 |
| 版本钉定（git tag ∩ npm 精确版，禁 latest） | `packages/docs-sync`（origin.json + capability-matrix.yaml） | ✅ 稳定 |
| 运行时三模式（local / download / bundled） | `packages/client-runtime/src/runtime.ts`、`resolve.ts` | ✅ 稳定 |
| 首启运行时下载（多镜像、按版本缓存、断点续传、sha512 校验） | `client-runtime/src/fetch-runtime.ts`、`npm-mirrors.ts` | ✅ 稳定 |
| thin / full 双场景交付 + Windows Portable 单文件 exe | `apps/desktop/scripts/pack.mjs` + electron-builder | ✅ 稳定 |
| 裸机一键构建（自动引导 Node/pnpm/依赖） | `scripts/bootstrap.mjs`、`build.bat/.sh` | ✅ 稳定 |
| 三端同构（Electron + VS Code/Cursor 共用 runtime 包） | `apps/vscode/src/extension.ts` | ✅ 基础可用 |
| 自动更新 Phase A（electron-updater + GitHub Releases + blockmap 差分） | `apps/desktop/src/auto-update.ts` | ✅ 已落地 |
| 运行时解耦 Phase B（bundled 种子 + 按需增量，DSH_BUNDLED_FETCH） | `runtime.ts` bundled 分支 | ✅ 已落地 |
| 运行时体积裁剪（289.3MB → 210.1MB，−79MB） | `client-runtime/src/prune.ts` | ✅ 已落地 |
| last-known-good 回滚（previous-origin.json） | `apps/desktop/src/origin-rollback.ts` | ✅ 已落地 |
| 发版门禁（origin 变更必须伴随客户端版本 +1） | `scripts/check-release.mjs` | ✅ 已落地 |
| 健壮性：单实例锁、渲染崩溃自动恢复（3 次）、关机 ladder、boot 日志、托盘、窗口状态记忆、下载接管 | `apps/desktop/src/*` | ✅ 已落地 |
| CI：每日 docs-sync 定时 PR + 6 矩阵 release workflow | `.github/workflows/ci.yml`、`release.yml` | ✅ 已落地 |
| 测试：23 个单测文件（vitest），覆盖 runtime/docs-sync/plugin | `packages/*/tests` | ✅ 良好 |

### 1.2 关键数据基线（2026-08-27 实测）

| 指标 | 数值 |
| --- | --- |
| 源码规模 | ~3,672 行 TS（不含测试） |
| thin 产物 | Portable 84.8MB / Setup 85.1MB / zip 119.5MB |
| full 产物 | Portable 159.1MB / Setup 159.4MB / zip 218.3MB |
| 运行时裁剪后 | 210.1MB（win-x64） |
| 钉版 dsh | 0.1.1-rc.2（clientVersion 0.1.0） |
| 技术栈 | Electron 37 / electron-builder 26 / electron-updater 6.8 / Node 22.19 / pnpm 10 / vitest 3 |

### 1.3 现状短板（按影响排序）

1. **无代码签名（最大分发阻塞项）**：Windows SmartScreen 反复拦截、macOS Gatekeeper 拦截且 Squirrel.Mac 更新校验必然失败 → macOS 自动更新完全不可用。评估文档已列为 Phase C，**尚未实施**。
2. **`main.ts` 职责过重（371 行）**：boot 编排、窗口生命周期、崩溃守卫、单实例、托盘装配全部内联，与 vscode 扩展的启动编排存在重复逻辑（读 origin → 构造 DshRuntime → start → 加载 URL）。
3. **VS Code 扩展功能过薄**：仅 1 个命令 + iframe webview，无状态栏、无错误降级 UI、无进度细节、面板关闭即停 runtime（无后台模式）。
4. **无 E2E 测试**：桌面端仅 `downloads.test.ts` 单测；「启动 → ready → 加载 UI → 停机」全链路无自动化验证，回归靠人工。
5. **体积仍偏大**：thin 85MB 中 Electron 壳占绝对大头（未做 locales/资源裁剪）；full 159MB 对「U 盘即插即用」场景仍显笨重。
6. **capability-matrix.yaml 只产不用**：docs-sync 生成的能力矩阵仅被 parity 测试消费，运行时/文档站未利用，价值未释放。
7. **i18n 缺失**：错误对话框英文、系统通知中文，混杂不一致。
8. **用户不可见运行时状态**：runtime-cache 多版本堆积无清理入口、dsh 版本切换无 UI、诊断信息只能翻日志文件。

---

## 2. 升级重构目标与原则

### 2.1 目标

1. **解锁分发**：签名 + 公证，消除 SmartScreen/Gatekeeper，macOS 自动更新就位；
2. **架构可持续**：拆解 main.ts、抽取共享启动编排，三端真正同构；
3. **体验补齐**：诊断面板、运行时版本管理、VS Code 扩展增强；
4. **质量护栏**：E2E 冒烟、体积预算门禁、启动性能基线。

### 2.2 原则（继承现有设计纪律）

- **薄壳零劫持**不变：不代理、不改写官方 UI 与数据；
- **版本即契约**不变：一切升级以 origin.json 钉版为唯一事实源；
- **每阶段独立可发布**：不搞大爆炸重构，任一 Phase 结束都产出可发版状态；
- **先测后改**：重构前先补 E2E 冒烟，重构期间持续绿灯。

---

## 3. 总体路线图

```
Phase C  签名与分发合规        ── 解锁分发（外部阻塞项，最高优先级）
Phase D  架构重构与工程治理    ── main.ts 拆解、共享 bootstrap、i18n、体积门禁
Phase E  体验增强              ── 诊断面板、运行时管理器、VS Code 扩展增强
Phase F  质量与性能            ── E2E、启动性能基线、更新链路集成测试
```

依赖关系：C 与 D 可并行；E 依赖 D 的共享 bootstrap；F 贯穿全程（D 开始前先落 E2E 冒烟骨架）。

---

## 4. Phase C —— 签名与分发合规（优先级最高）

> 目标：消除「未签名」这一分发硬阻塞，macOS 自动更新从不可用变为可用。

### C1. Windows Authenticode 签名

| 项 | 方案 |
| --- | --- |
| 证书 | OV 起步（年费低、SmartScreen 需积累信誉）；预算允许直接 EV（即时信誉） |
| 签名工具 | electron-builder 内置 `signtool` 集成：配置 `win.signingHashAlgorithms`、`win.sign` 或 `certificateFile/certificatePassword`（推荐 CI 用 `CSC_LINK` base64 p12 + Secret） |
| 签名对象 | NSIS exe、Portable exe、**以及 updater 用的 blockmap**（electron-updater 6.x 校验签名哈希，漏签会导致更新失败） |
| CI 改动 | `release.yml` Windows job 注入 `CSC_LINK`/`CSC_KEY_PASSWORD` Secrets；移除该平台的 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`（改为按平台条件保留） |

### C2. macOS Developer ID + 公证（notarization）

1. `Developer ID Application` 证书 + hardened runtime（electron-builder `mac.identity` + `mac.hardenedRuntime: true`）；
2. `afterSign` 钩子走 `@electron/notarize`（`notarize: true`，Apple ID 凭据走 Secrets）；
3. 签名就位后，macOS 的 electron-updater（Squirrel.Mac）自动更新链路自然打通——**这是 mac 自动更新的硬前提**；
4. 未购证书前的过渡：保持现状（mac 提示手动下载），但把「检测到未签名 → 引导手动下载」的降级路径在 UI 中显式化（当前已部分实现于 `auto-update.ts`，需补 mac 分支文案）。

### C3. 分发渠道补全

- GitHub Releases 保持主源；增加 `latest.yml`/`latest-mac.yml`/`latest-linux.yml` 的 channel 约定（stable 无后缀 / beta `x.y.z-beta.N`），与 docs-sync 的 rc 钉版映射（beta 客户端钉 rc dsh）——评估文档 §3.2 已设计，此处落地为构建参数化：`--channel beta` 注入对应 origin.json；
- 发布 checklist 固化进 `scripts/check-release.mjs`（已存在，扩展 channel 校验）。

**验收标准**：Windows 全产物签名有效（`signtool verify`）、macOS `spctl -a -vv` 通过 + notarization staple 成功、mac 自动更新真机走通一次。

---

## 5. Phase D —— 架构重构与工程治理

### D1. 拆解 `apps/desktop/src/main.ts`（371 行 → 模块化）

```
apps/desktop/src/
├── main.ts              # 仅剩：app 生命周期挂载 + 单实例锁（<80 行）
├── boot/
│   ├── boot-flow.ts     # boot() 编排：origin → runtime → window → tray
│   ├── crash-guard.ts   # uncaughtException / render-process-gone / unresponsive
│   └── rollback.ts      # last-known-good（现 origin-rollback.ts 并入）
├── window/
│   ├── main-window.ts   # createWindow + 窗口事件
│   └── window-state.ts  # 不变
└── ...（splash/tray/boot-log/downloads/shutdown/state 保持）
```

要点：`boot-flow.ts` 只做编排，具体能力全部注入（依赖注入现有 `DshRuntime` options 模式），便于单测与 vscode 复用。

### D2. 抽取共享启动编排包 `@dsh/bootstrap`

现状：desktop `boot()` 与 vscode `activate()` 各写一遍「读 origin → 判 bundled → 构造 DshRuntime → start → 拿 ready.url」。抽取：

```
packages/bootstrap/src/
├── index.ts       # bootstrapRuntime(options): Promise<{ runtime, ready }>
├── origin.ts      # resolveOriginPath(packaged, resourcesPath) 统一三端路径解析
└── progress.ts    # 统一进度事件模型（desktop splash / vscode withProgress 共用）
```

- desktop 与 vscode 均改为消费 `@dsh/bootstrap`；
- 回滚逻辑（last-known-good）一并上移，vscode 端免费获得回滚能力（当前缺失）。

### D3. i18n 基础

- 新增 `apps/desktop/src/i18n.ts`：极简 key-value 表（zh-CN / en），覆盖错误对话框、通知、托盘菜单；
- 以 `app.getLocale()` 判定，默认跟随系统；
- 不引入 i18n 框架（文案量小，避免依赖膨胀）。

### D4. 体积治理

| 措施 | 预期收益 | 改动点 |
| --- | --- | --- |
| `electronLanguages: ["zh-CN", "en-US"]` | thin −10~15MB（Electron locales 目录） | `electron-builder.common.yml` |
| asar unpack 白名单收紧 | 小幅 | 同上 |
| full 运行时二次裁剪审计（mistralai/zod 等 SDK 的 tests、docs 目录） | −5~15MB | `prune.ts` 扩展规则 |
| **体积预算门禁** | 防回弹 | 新增 `scripts/check-size.mjs`：thin ≤ 90MB、full ≤ 165MB（当前基线 +5% 余量），CI 强制 |

### D5. capability-matrix 激活

- `docs-sync` 生成矩阵时同步产出 Markdown 摘要，发布到 GitHub Release notes 与项目 docs；
- parity 测试扩展：矩阵中标记为 removed 的能力触发告警（当前仅比对存在性）。

**验收标准**：`main.ts` < 100 行；desktop/vscode 无重复启动编排；`pnpm check:size` 进 CI；全仓 `tsc --noEmit` + 单测绿灯。

---

## 6. Phase E —— 体验增强

### E1. 诊断面板（桌面端）

新增 `apps/diagnostics`（本地 HTML 面板，托盘菜单「诊断」打开）：

- 当前 dsh 版本 / origin 钉版 / runtime 模式 / 缓存目录占用；
- runtime-cache 版本列表 + 一键清理旧版本（复用 `fetch-runtime` 的按版本目录结构）；
- boot 日志尾部查看（替代「打开日志目录」的降级体验）；
- 「导出诊断包」：打包 origin.json + boot log + 版本信息为 zip（用户主动触发，保持零遥测原则）。

### E2. 运行时版本管理

- 托盘/诊断面板支持「切换 dsh 版本」：列出 runtime-cache 已有版本 + origin 允许的钉版，切换即改写 `userData/origin-override.json`（新增，优先级高于打包 origin）；
- `DshRuntime` 启动时读取 override（`resolve.ts` 加一级解析）；
- 回滚机制天然兼容（override 失败 → 回退打包 origin）。

### E3. VS Code 扩展增强

| 项 | 说明 |
| --- | --- |
| 状态栏指示 | 运行中显示 dsh 版本 + 端口；点击聚焦面板 |
| 后台模式 | 面板关闭不杀 runtime（可配置 `dshClient.keepAlive`），命令显式停止 |
| 错误降级 UI | start 失败时 webview 显示可操作错误页（重试 / 打开日志），替代裸抛 |
| 多面板 | 支持开第二个工作区面板（同一 runtime，不同 webview） |
| 回滚能力 | 消费 `@dsh/bootstrap` 后自动获得（见 D2） |

### E4. Splash 升级

- 从 `data:` URL 改为本地文件加载（支持 i18n、错误态按钮：重试 / 打开日志 / 复制错误）；
- 下载进度条可视化（现有 onProgress 事件已具备数据）。

**验收标准**：诊断面板可清理缓存并导出诊断包；VS Code 扩展具备状态栏与错误降级；splash 错误态可操作。

---

## 7. Phase F —— 质量与性能

### F1. E2E 冒烟测试（先行于 D，作为重构护栏）

- 技术选型：**Playwright + Electron**（`electron.launch()` 支持 main 进程注入）；
- 用例集（`tests/e2e/`）：
  1. 冷启动 → splash → ready → 窗口加载 URL（mock dsh：本地 http server + 假 ready 文件，不依赖真实 dsh）；
  2. 单实例锁：二次启动聚焦已有窗口；
  3. 渲染崩溃注入 → 自动 reload 恢复；
  4. 停机 ladder：退出后无孤儿进程（Windows 用 CIM 查询，复用 `process.ts` 逻辑）；
  5. thin 首启下载路径：mock registry，验证缓存/续传/integrity。
- CI：Windows runner 必跑，mac/linux 可选。

### F2. 启动性能基线

- 指标：`boot start` → `ready-to-show` 耗时（bundled 场景目标 < 5s；download 首启除外）；
- boot log 已有时间戳，新增 `scripts/perf-report.mjs` 汇总 CI 产物，趋势回对比对。

### F3. 更新链路集成测试

- 本地 generic feed（`DSH_UPDATE_FEED_URL` 已支持）+ 两个相邻版本安装包，验证 blockmap 差分下载与退出安装；
- 纳入 release 前手动 checklist（自动化成本高，先文档化）。

### F4. 测试补强

- `main.ts` 拆解后各模块单测（boot-flow 用注入 mock runtime）；
- vscode 扩展目前仅 1 个测试文件，补 activate/错误路径。

**验收标准**：E2E 在 CI 绿灯；启动耗时纳入发布报告；更新链路有可复现的验证手册。

---

## 8. 实施计划与里程碑

| 阶段 | 内容 | 预估工作量 | 交付物 |
| --- | --- | --- | --- |
| **M0（1 周）** | F1 E2E 骨架 + mock dsh harness | 3~5 人日 | `tests/e2e/` + CI job |
| **M1（2~3 周）** | Phase C 签名（Win 先行，mac 视证书采购） | 5~8 人日 + 证书采购 | 签名产物 + mac 自动更新 |
| **M2（2 周）** | Phase D 架构重构（D1/D2/D4 门禁） | 6~8 人日 | main.ts 拆解 + @dsh/bootstrap + check-size |
| **M3（2 周）** | Phase D 收尾（D3 i18n / D5 矩阵激活）+ Phase E1/E4 | 5~7 人日 | 诊断面板 + splash 升级 |
| **M4（2 周）** | Phase E2/E3 运行时管理 + vscode 增强 | 5~7 人日 | 版本切换 + 扩展增强 |
| **M5（1 周）** | Phase F2/F3/F4 性能与更新验证 | 3~5 人日 | 性能基线 + 发布手册 |

> 排序依据：签名是外部依赖（证书采购周期不可控），尽早启动；E2E 先行保护后续重构；架构重构先于功能增强避免在旧结构上叠功能。

---

## 9. 风险与应对

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| 证书采购周期长 / 预算不确定 | 高 | M1 立即启动采购流程；期间 Windows 签名可先用自签 + 文档说明，mac 保持手动下载降级 |
| 重构引入启动回归 | 中 | E2E 冒烟先行（M0）；每步小 PR；boot log 时间戳对比 |
| electron-updater 对带 `-thin/-full` 后缀 asset 的匹配行为未实测 | 中 | 评估文档已标注「待核验」；M1 用真实 release 验证，必要时调整 artifactName 策略 |
| 运行时裁剪误删导致 dsh 功能缺失 | 中 | prune 规则改动必须附带「裁剪前后功能冒烟」；保留 `--prune-only` 干跑模式 |
| origin-override 引入版本漂移 | 低 | override 仅允许 origin 历史钉版集合内的版本（从 released-origin 链读取），禁止任意版本 |
| VS Code API 差异（Cursor 兼容） | 低 | 保持 `^1.94.0` 引擎基线；后台模式默认关闭 |

---

## 10. 附录：改动点速查（按文件）

| 文件/目录 | 阶段 | 动作 |
| --- | --- | --- |
| `.github/workflows/release.yml` | C | 注入签名 Secrets；按平台条件化 `CSC_IDENTITY_AUTO_DISCOVERY` |
| `apps/desktop/electron-builder.*.yml` | C/D | 签名配置；`electronLanguages`；channel 参数化 |
| `apps/desktop/src/main.ts` | D | 拆解为 boot/ + window/ 模块 |
| `packages/bootstrap/`（新增） | D | 共享启动编排，desktop/vscode 消费 |
| `apps/desktop/src/i18n.ts`（新增） | D | zh-CN/en 文案表 |
| `scripts/check-size.mjs`（新增） | D | 体积预算门禁，挂 CI |
| `packages/client-runtime/src/prune.ts` | D | 扩展裁剪规则（SDK tests/docs） |
| `apps/desktop/src/diagnostics/`（新增） | E | 诊断面板 |
| `packages/client-runtime/src/resolve.ts` | E | origin-override 解析级 |
| `apps/vscode/src/*` | E | 状态栏/后台模式/错误降级/多面板 |
| `apps/desktop/src/splash.ts` | E | 本地文件加载 + 错误态操作 |
| `tests/e2e/`（新增） | F | Playwright + Electron 冒烟 |
| `scripts/perf-report.mjs`（新增） | F | 启动耗时汇总 |

---

## 11. 明确不做（Non-Goals）

- **不 fork / 不改写官方 Web UI**——薄壳原则不可破；
- **不引入遥测**——保持零数据收集卖点，诊断包仅用户主动导出；
- **不做自有账号体系 / 云同步**——数据始终走官方 `~/.dsh/`；
- **不支持任意 dsh 版本**——版本切换仅限 origin 历史钉版集合，杜绝版本漂移；
- **deb/rpm 不做自动更新**——维持评估文档结论（系统包管理器负责）。

---

*本方案与 `docs/auto-update-assessment.md` 的 Phase A/B 已完成项衔接，Phase C 命名保持一致以延续既有规划语境。*
