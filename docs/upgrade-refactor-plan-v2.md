# HarnessDock 升级改造计划 v2

> 状态：规划稿（2026-08-28 基于当前仓库实测梳理）
> 前置：`docs/upgrade-refactor-plan.md`（v1）中 Phase D/E/F 已全部落地，本文取代 v1 成为当前唯一有效规划
> 事实基线见 §1（全部为实测数据，非估算）

---

## 1. 项目现状盘点（2026-08-28 实测）

### 1.1 结构与规模

| 模块 | 规模 | 测试 | 说明 |
| --- | --- | --- | --- |
| apps/desktop | 21 文件 / ~2,700 行 | 30 用例 | 主进程已模块化（boot/ window/ diagnostics/） |
| packages/client-runtime | 15 文件 / 1,817 行 | 13 文件 / 1,258 行 | 下载管线已健壮化（并发/硬超时/重试/裁剪） |
| packages/docs-sync | 11 文件 / 672 行 | 7 文件 / 408 行 | 矩阵激活完成（capability-summary.md） |
| packages/bootstrap | 3 文件 / 206 行 | 2 文件 / 192 行 | 共享启动编排（desktop/vscode 双端消费） |
| packages/plugin-embedded-client | 2 文件 / 93 行 | 1 文件 / 37 行 | esbuild 自动构建 |
| apps/vscode | 3 文件 / 422 行 | 2 文件 / 108 行 | 状态栏/keepAlive/错误页/多面板 |
| scripts | 15 文件 / 990 行 | — | check-size / check-release / perf-report / regenerate-icon 等 |
| tests/e2e | 7 文件 / 624 行 | 5 用例 | cold-start / crash / shutdown / single-instance / window-controls |

**单测总量：30 文件 / 170 用例全绿；e2e 5/5；全仓 `tsc --noEmit` 零错误。**

### 1.2 体积基线（check-size 门禁全过）

| 产物 | 实测 | 预算 |
| --- | --- | --- |
| thin Portable / Setup / zip | 80.8 / 81.0 / 113.9 MB | ≤ 90 / 90 / 125 |
| full Portable / Setup / zip | 131.5 / 131.7 / 181.2 MB | ≤ 165 / 165 / 230 |

（full 相比首轮已减 ~24MB：运行时裁剪 + 平台变体清理 + compression maximum）

### 1.3 本会话已完成的能力（v1 计划 + 增量修复）

- 自动更新 Phase A（electron-updater + GitHub provider + NSIS 差分 + Portable 降级 + 发版门禁 check-release + last-known-good 回滚）
- 运行时解耦 Phase B（bundled 种子 + DSH_BUNDLED_FETCH 按需增量 + 下载模式平台裁剪）
- 架构 Phase D（main.ts 拆解 → 94 行装配层；@dsh/bootstrap 共享编排；i18n；体积门禁；矩阵激活）
- 体验 Phase E（诊断面板 + 版本管理；VS Code 增强；Splash 进度条/错误态/虚拟加载）
- 质量 Phase F（e2e 5 用例；perf-report；更新链路手册；170 单测）
- 关键缺陷修复：ESM bundle require 注入、preload 双重路径 + external electron + .cjs、**窗口按钮 isolated-world bridge 断链**（用户报障根因）、wmic→CIM 回退、下载硬超时/重试、Phase A 回滚语义 bug（启动前覆盖好版本）
- 视觉 mac 化：标题栏/Splash/Closing/诊断面板统一调色板 + 淡入淡出 + 青色化图标

### 1.4 关键风险项（未解决，按影响排序）

1. **Git 零提交**：`feat/full-client` 分支无任何 commit。CI（ci.yml / release.yml）、check-release 门禁、回滚能力全部空转——这是当前最高优先级阻塞项。
2. **未签名**：Windows SmartScreen 拦截、macOS Gatekeeper 拦截且 mac 自动更新不可用（Squirrel 校验硬前提）。
3. **自动更新未真机验证**：feed 注入机制已就绪（app-update.yml/latest.yml 生成验证通过），但 R1–R10（评估文档）需真实 GitHub repo + 两个相邻版本才能闭环。
4. **e2e 基建三处 workaround**（见 §3-G4），根因未消。

---

## 2. 改进点全景（按类别）

### A. 工程基础
| # | 项 | 现状 | 影响 |
| --- | --- | --- | --- |
| A1 | Git 初始化提交 | 零提交 | 无历史/回滚/CI/review |
| A2 | CI 从未运行 | workflow 存在 | 测试/打包/门禁未自动执行 |
| A3 | 代码签名 | 无 | 分发阻塞（P3 遗留） |
| A4 | coverage 门禁 | 无 | 回归风险 |
| A5 | 工具链漂移 | corepack 曾升 pnpm 11 | 环境不一致 |

### B. 架构与代码结构
| # | 项 | 现状 | 影响 |
| --- | --- | --- | --- |
| B1 | 内嵌 HTML ×4 各自维护调色板 | splash/closing/diagnostics/preload | 已发生一次配色漂移（诊断面板旧色） |
| B2 | diagnostics.ts 461 行混合职责 | 纯函数+窗口+模板+内嵌JS | 维护性 |
| B3 | preload.ts 250 行混合职责 | 样式+探测+守卫+bridge | 同上 |
| B4 | splash.ts 224 行混合职责 | 模板+驱动+IPC | 同上 |
| B5 | 打包完整性无校验 | files 白名单曾漏 preload | 事故重演风险 |
| B6 | 托盘图标 256px 直接缩放 | Windows 托盘最佳 16/32 | 观感模糊 |
| B7 | boot log 被 404 dump 污染 | auto-update 错误整包打印 | 排障噪音 |
| B8 | DSH_CUSTOM_TITLEBAR 开关在打包版可能失效 | 沙箱 preload env 受限 | 调试开关不可靠 |

### C. 测试
| # | 项 | 现状 |
| --- | --- | --- |
| C1 | download 首启全链路 e2e | 无（mock registry 未建） |
| C2 | bootstrap 回滚集成测试 | 仅包内单测 |
| C3 | vscode activate 自动化 | 仅纯函数测试 |
| C4 | e2e 基建脆弱点 | 3 处 workaround |
| C5 | 性能趋势 | perf-report 仅手动 |

### D. 产品功能
| # | 项 | 现状 |
| --- | --- | --- |
| D1 | 更新 UI（进度/重启安装面板） | 仅托盘入口+系统通知 |
| D2 | 诊断面板缺客户端版本信息 | 仅 dsh 侧信息 |
| D3 | vscode 文案未 i18n | 硬编码英文 |
| D4 | channel 参数化（stable/beta） | 未做（v1-C3 遗留） |
| D5 | 第二实例仅聚焦 | 无 deep link/参数处理 |
| D6 | mac 原生质感（vibrancy） | 未用（纯 CSS 近似） |

### E. 文档与流程
| # | 项 | 现状 |
| --- | --- | --- |
| E1 | CHANGELOG | 缺失 |
| E2 | 发布 runbook | 分散在各文档 |
| E3 | v1 计划文档过时 | 需标记取代 |
| E4 | 贡献指南 | 缺失 |

---

## 3. 分阶段实施计划

### Phase G —— 工程地基（最高优先级，1 周）

> 目标：让版本控制、CI、门禁真正运转起来。G1 是所有后续工作的前提。

**G1. Git 初始化与首提交**
- 清点 `.gitignore`（`.lingxi/`、`.wpscomate/`、`apps/vscode/*.vsix`、`tests/e2e/test-results/` 确认忽略；`packages/docs-sync/released-origin.json` 应提交）
- 首提交 → push → 建 `main` 保护分支；`feat/full-client` 的历史从此可追溯
- 验收：`git log` 有提交；push 后 ci.yml 首跑绿（三 OS 测试矩阵 + pack）

**G2. CI 接入全部门禁**
- ci.yml 增加：`pnpm check:versions`、`pnpm check:release`、`pnpm check:size`（pack 之后）、`pnpm e2e`（Windows runner）
- 验收：故意改坏一个版本号 → CI 红

**G3. 签名准备（不阻塞，并行推进）**
- 启动证书采购（Windows OV/EV + macOS Developer ID）
- release.yml 预留 `CSC_LINK`/`CSC_KEY_PASSWORD` Secrets 与按平台条件化 `CSC_IDENTITY_AUTO_DISCOVERY`
- 验收：证书到位后一键可签（文档化流程）

**G4. e2e 基建固化**
- 现有三处 workaround（手动轮询替代 expect.poll、evaluate 派发点击、closeApp 超时竞速）沉淀为 `tests/e2e/lib/*.ts` 工具并注释根因
- 尝试升级 @playwright/test 观察 upstream 是否修复，可则去 workaround
- 验收：e2e 连续 3 轮全绿无 flake

**G5. 工具链钉死**
- `packageManager` 已钉 pnpm@10.12.0；补 `.npmrc` `engine-strict`（已有）+ README 记录 corepack 用法，避免再被升到 pnpm 11
- 验收：新机器 clone 后 `corepack enable && pnpm install` 一次成功

### Phase H —— 架构收敛（1–2 周）

**H1. design-tokens 抽取（消 B1）**
- 新建 `apps/desktop/src/ui/design-tokens.ts`：导出共享 CSS 变量字符串（调色板/圆角/阴影/字体栈/动画曲线），splash/closing/diagnostics/preload 四处模板拼接引用
- 验收：改一处调色板 → 四界面同步变化；grep 确认无散落 hex

**H2. 大文件拆分（消 B2/B3/B4）**
- diagnostics.ts → `diagnostics/pure.ts`（tailLines/computeKeepSet/selectOldVersions/cacheSizeBytes，已有测试）+ `diagnostics/window.ts`（窗口生命周期）+ `diagnostics/template.ts`（HTML）
- preload.ts → `caption/template.ts` + `caption/theme.ts` + `caption/guard.ts`（bundle 入口仍是单文件 preload.ts）
- splash.ts → `splash/template.ts` + `splash/driver.ts`
- 验收：单文件均 <200 行；tsc/e2e/170 测试全绿（纯移动，零行为变更）

**H3. 打包完整性门禁（消 B5）**
- pack.mjs 在 electron-builder 结束后断言 asar 含 `dist/main.js` + 三个 `*.cjs` preload（用 `asar list`）
- 验收：删掉一个 preload 产物 → pack 失败并明示

**H4. 细节治理（消 B6/B7/B8）**
- 托盘：regenerate-icon.ps1 增加 16/32 生成，tray.ts 优先小尺寸
- boot-log：auto-update 错误 dump 截断至 200 字符
- `DSH_CUSTOM_TITLEBAR` 开关改为 `process.env.DSH_DISABLE_TITLEBAR`（经 commandLine/原生参数传递，不依赖沙箱 env）或直接删除该开关（保留始终启用）
- 验收：托盘清晰、日志干净、开关行为确定

### Phase I —— 测试补强（1–2 周，可与 H 并行）

**I1. download 首启 e2e（消 C1）**
- `tests/e2e/mock-registry.mjs`：本地 http server 提供 `/@deepseek-ai/dsh/<ver>` 元数据 + tarball（用 npm pack 生成的真 tarball 或手工 fixture）
- 用例：首启 resolve→fetch 进度→完成→boot ok；中断续传；损坏 integrity 失败提示
- 验收：DSH_NPM_MIRROR 指向 mock 的首启 e2e 绿

**I2. bootstrap 回滚集成测试（消 C2）**
- fake dsh 脚本按版本失败（bad 版本 exit 1，good 版本 ready）→ 断言 rolledBack + previous-origin 未被覆盖
- 放 `packages/bootstrap/tests` 或 desktop e2e
- 验收：回滚路径有自动化覆盖

**I3. coverage 门禁（消 A4）**
- vitest v8 coverage + `pnpm test:coverage`；CI 阈值：client-runtime ≥85%、bootstrap ≥85%、docs-sync ≥75%
- 验收：CI 产出覆盖率报告并卡阈值

**I4. vscode activate 冒烟（消 C3）**
- 用 `@vscode/test-electron` 跑 activate → 状态栏出现 → stop 命令；CI 可选 job
- 验收：扩展激活有自动化验证

**I5. 性能趋势（消 C5）**
- e2e cold-start 记录 boot 耗时 → CI artifact JSON → 趋势对比脚本
- 验收：连续构建可看启动耗时曲线

### Phase J —— 产品完善（2–3 周）

**J1. 更新 UI（消 D1）**
- 诊断面板加「更新」区块：当前版本/最新版本/下载进度条（复用 autoUpdater download-progress）/「重启安装」按钮
- 验收：托盘检查更新 → 面板见进度 → 一键重启安装

**J2. 诊断面板补客户端信息（消 D2）**
- clientVersion（读 app.getVersion）+ electron/node 版本 + 图标化平台标识
- 验收：面板显示三端版本三元组

**J3. vscode i18n（消 D3）**
- 复用 desktop i18n key-value 模式，扩展内建 locale 判定；错误页/状态栏文案双语
- 验收：中英系统语言下文案正确

**J4. channel 参数化（消 D4，衔接 v1-C3）**
- `pack.mjs --channel beta` → 注入 beta origin（docs-sync 支持 rc 钉版选择）+ 版本后缀；release.yml 手动触发可选 channel
- 验收：同一 tag 可出 stable/beta 两套产物且 updater 不串

**J5. 第二实例参数处理（消 D5）**
- `second-instance` 读取 argv（如 `--focus-diagnostics`）驱动面板打开；为未来 deep link 留钩子
- 验收：带参二次启动打开诊断面板

**J6. mac 质感（消 D6，可选）**
- darwin 上 BrowserWindow `vibrancy: 'sidebar'` + caption 半透明适配实测；Win11 可评估 `backgroundMaterial: 'mica'`
- 验收：mac 构建视觉一致（需真机）

### Phase K —— 发布与运营（贯穿，收尾 1 周）

**K1. CHANGELOG（消 E1）**：Keep a Changelog 格式，从首提交起补 0.1.0 全量记录
**K2. 发布 runbook（消 E2）**：`docs/release-runbook.md` 串起 sync:dsh → bump → check:release → tag → release.yml → mark:released → 签名 → 验证（含更新链路手册引用）
**K3. v1 计划归档（消 E3）**：upgrade-refactor-plan.md 顶部标注 "superseded by v2"
**K4. 贡献指南（消 E4）**：CONTRIBUTING.md（构建/测试/e2e/发版链接）
**K5. 自动更新真机闭环（消风险3）**：真实 repo 出 v0.1.0→v0.1.1，按 update-link-integration-manual.md 跑通差分更新 + 回滚，核验 R1/R2/R3/R9
**K6. 首个对外发布**：签名就绪后打 v0.1.0 tag 走 release.yml，产出六平台产物 + release notes（capability-summary.md 注入）

---

## 4. 里程碑与依赖

```
M0 (第1周)   G1 Git + G2 CI + G5 工具链          ── 一切的前提
M1 (第2-3周) H1-H3 架构收敛 + G4 e2e固化          ── 可与 G3 并行
M2 (第3-4周) H4 细节 + I1-I3 测试补强
M3 (第5-6周) J1-J3 产品完善（更新UI/诊断/i18n）
M4 (第7周+)  J4-J5 + K1-K6 发布运营 + 真机更新闭环 ── 依赖签名证书
```

依赖关系：G1 → 全部；G3(证书) → K5/K6；H1 → J1（更新 UI 用统一 tokens）；I1 依赖 mock registry 搭建；J4 依赖 docs-sync rc 选版支持。

---

## 5. 风险与应对

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| 证书采购周期不可控 | 高 | M0 即启动流程；未签名期间 Windows 自签+文档说明，mac 维持手动下载降级 |
| 首提交体量大、review 困难 | 中 | 按模块分批提交（packages → apps → scripts → docs），每批可独立构建 |
| e2e flake 拖累 CI | 中 | G4 固化 workaround + retry 策略；e2e 允许 1 次重试 |
| preload 拆分引入打包回归 | 中 | H2 严格"纯移动"原则 + H3 asar 完整性门禁兜底 |
| 拆分 design-tokens 后样式回归 | 低 | 四界面截图对比（e2e screenshot 断言可选） |
| 真实 repo 更新链路不通过 | 中 | K5 在签名前先用 generic feed（DSH_UPDATE_FEED_URL）验证机制，再切 GitHub |

---

## 6. 明确不做（Non-Goals，延续 v1）

- 不 fork / 不改写官方 Web UI
- 不引入遥测
- 不做账号体系 / 云同步
- 版本切换仍限定 origin 历史钉版集合
- deb/rpm 不做自动更新
- 不追求窗口原生圆角/透明（Windows 最大化边界问题，CSS 近似足够）

---

## 附录：v1 → v2 完成度对照

| v1 项 | 状态 |
| --- | --- |
| C1/C2 签名 | 未做 → 移入 G3/K5 |
| C3 channel | 未做 → 移入 J4 |
| D1 main.ts 拆解 | ✅ 完成（94 行） |
| D2 @dsh/bootstrap | ✅ 完成 |
| D3 i18n | ✅ 完成（desktop） |
| D4 体积门禁 | ✅ 完成（check-size + 裁剪 −24MB） |
| D5 矩阵激活 | ✅ 完成 |
| E1-E4 体验增强 | ✅ 完成（+ 修复按钮断链/关闭动画等 v1 未预见缺陷） |
| F1 e2e | ✅ 完成（5 用例，含 window-controls） |
| F2 perf-report | ✅ 完成 |
| F3 更新手册 | ✅ 完成 |
| F4 测试补强 | ✅ 170 用例；coverage 门禁移入 I3 |
