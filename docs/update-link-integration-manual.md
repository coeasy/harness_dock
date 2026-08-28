# 更新链路集成测试手册（F3）

> 适用范围：`apps/desktop`（Electron 37 + electron-updater ^6.8.9）的「检查 → blockmap 差分下载 → 退出安装」全链路验证。
> 状态：**文档化的手动验证手册**（F3，方案 `docs/upgrade-refactor-plan.md` 的 F3）。自动化成本高，先以本手册做发布前人工核验；标 🔴 的步骤必须真机/真实 release 环境，其余可本地 generic feed 模拟。
> 依据：`docs/auto-update-assessment.md`（Phase A/B）、`apps/desktop/src/auto-update.ts`、`apps/desktop/scripts/pack.mjs`、`scripts/check-release.mjs`。

## 目标

验证 electron-updater 的「检查更新 → blockmap 差分下载 → 退出后安装 → 版本跳变」整条链路，并覆盖三条可靠性基线：**差分下载量**（远小于全量）、**断网降级**（照常使用）、**last-known-good 回滚**（thin/full 均测）。更新源优先用本地 generic feed（`DSH_UPDATE_FEED_URL` 已支持），**无需真实 GitHub**。

## 验证范围与前提

- 主推进载体是 **Windows NSIS 安装版**（唯一「差分 + 静默退出安装」载体）；Portable 单文件 exe 不支持自更（检测到 `PORTABLE_EXECUTABLE_FILE` 即禁用并降级为打开 Releases 页）；macOS 自动更新硬依赖签名（Phase C）；Linux AppImage 无差分（永远全量）。
- `auto-update.ts` 仅在 **packaged 且非 portable 且存在 `resources/app-update.yml`** 时激活（`hasUpdateFeed()` 守卫）。因此**即使走本地 feed，构建时仍需设 `GH_OWNER`/`GH_REPO` 占位值**以烘焙 feed；运行期用 `DSH_UPDATE_FEED_URL` 覆盖为本地地址。
- 事件与日志：所有 auto-update 事件写入 boot log（`%APPDATA%\HarnessDock\logs\boot-YYYY-MM-DD.log`，或托盘「打开日志目录」），关键节点另有原生 Notification / dialog。
- 版本一致性纪律：发版 = 新客户端版本 + 新钉版 `origin.json`（updater 以客户端版本为推进单元，同版本不会派发）；根 `package.json`、`apps/desktop/package.json`、`origin.json.clientVersion` 三者必须一致（`pnpm check:release` 强制）。

## 前置条件

1. Node ≥ 22.19 + pnpm 10（裸机可先 `pnpm setup`）。
2. 主进程产物基线就绪：`pnpm --filter @dsh/desktop bundle` 产出 `apps/desktop/dist/main.js`（`pack.mjs` 内部也会重新 bundle，此处确保可运行）。
3. 一台 Windows 真机；准备一个空闲端口（下文示例 `8712`）。
4. 静态文件服务器任选：`python -m http.server`、`npx serve`、`http-server` 均可（generic feed 只需 GET 静态文件）。

## 步骤 A：本地 generic feed 全链路（v0.1.0 → v0.1.1）

1. **构建 v0.1.0（已安装基线）**：确认版本为 `0.1.0`，执行：
   ```sh
   GH_OWNER=local GH_REPO=local pnpm --filter @dsh/desktop pack:win   # thin
   ```
   产物在 `apps/desktop/release/thin/`：`HarnessDock-Setup-0.1.0-*-thin.exe`。安装它（NSIS 安装版，非 portable）。若输出目录被 Windows/杀软占用，用 `DSH_PACK_OUTPUT=<目录>` 覆盖。
2. **构建 v0.1.1（更新源）**：把根 `package.json` 与 `apps/desktop/package.json` 版本 bump 到 `0.1.1`（并同步 `origin.json.clientVersion` 与 docs-sync 基线），重新 pack。产物应含 `latest.yml`、`HarnessDock-Setup-0.1.1-*-thin.exe`、`HarnessDock-Setup-0.1.1-*-thin.exe.blockmap`。
   - 🔴 若 `latest.yml`/`.blockmap` 未生成或 `resources/app-update.yml` 未烘焙（对应评估 R2：`--publish never` 下 feed 生成行为），记录为阻塞并反馈，勿跳过本步。
3. **挂载本地静态服务器**：把 v0.1.1 的 `latest.yml` + Setup exe + `.blockmap` 放进同一目录并服务：
   ```sh
   cd <feed-dir> && python -m http.server 8712    # 绑定 127.0.0.1:8712
   ```
   generic provider 先取 `latest.yml` 拿新版本信息，再按其中**相对路径**下载 exe 与 blockmap，三个文件必须在同一可访问路径下。
4. **启动 v0.1.0 安装版**（带 feed 覆盖）：
   ```sh
   set DSH_UPDATE_FEED_URL=http://127.0.0.1:8712 && HarnessDock.exe
   ```
   启动 5s 后首次自动 check（`auto-update.ts` 的 `setTimeout(checkNow, 5000)`），也可直接托盘「检查更新…」。
5. **观察 boot log** 依次出现（每 10% 记一次进度）：
   `checking-for-update` → `update-available (0.1.1)` → `download-progress`（百分比/KB）→ `update-downloaded (0.1.1)`；随后通知「HarnessDock 更新已就绪」。
6. **点「立即重启安装」**（或选「稍后」，之后正常退出时因 `autoInstallOnAppQuit: true` 自动安装）→ 应用退出，NSIS 安装新版本 → 重启后版本跳变到 `0.1.1`（关于/设置面板、日志 `clientVersion`、或 `origin.json` 确认）。
7. **数据安全确认**：更新只替换安装目录，`~/.dsh` 数据不受影响（NSIS 升级覆盖安装目录但不碰用户数据）。

### 观察点速查

| 阶段 | 期望日志/表现 | 异常排查 |
| --- | --- | --- |
| 检查 | `checking-for-update` → `update-available` | 无 `update-available`：feed 未烘焙（R2）、版本未 +1（同版本不更新）、服务器端口不通 |
| 下载 | `download-progress …/… KB`，百分比递增 | 一直 0%：blockmap 缺失、服务器没挂 `.blockmap` |
| 就绪 | `update-downloaded` + 通知 | 无通知：通知不可用仅日志 |
| 安装 | 退出后安装器拉起 | 被 `app.exit(1)` 崩溃路径跳过（R9） |

### 预期 boot log 样例（对照用）

```
[10:00:05] auto-update: checking for updates
[10:00:06] auto-update: update available 0.1.1
[10:00:09] auto-update: download 10% (123/1230 KB)
[10:00:12] auto-update: download 30% (369/1230 KB)
[10:00:15] auto-update: download 60% (738/1230 KB)
[10:00:18] auto-update: download 100% (1230/1230 KB)
[10:00:19] auto-update: update downloaded (0.1.1), ready to install
[10:00:21] auto-update: checkForUpdates resolved (0.1.1)
```

差分场景下 `transferred` 应显著小于全量 Setup 体积（步骤 B 记录实际值对比）。

## 步骤 B：差分验证（仅改 asar 一个文件再发版）

1. 在 v0.1.1 源码上**只改一个 asar 内文件**（例如 `apps/desktop/src/main.ts` 里一个 bootLog 文案），bump 到 `0.1.2`，重新 pack。
2. 把 v0.1.2 的 `latest.yml` + Setup exe + `.blockmap` 换入服务器同目录；已装 v0.1.1 的实例（仍带 `DSH_UPDATE_FEED_URL`）检查更新。
3. 记录 `download-progress` 的 `transferred/total KB`：**应远小于全量 Setup exe 体积**（blockmap 差分只下载差异块；thin 场景 dsh 运行时未变，理想情况只差壳）。
   - 先看 Setup exe 文件大小作全量参照，再对比实际下载字节，记录差值。
   - 🔴 此步即评估 R3（差分是否默认开启、实际下载量）。thin/full 资产同 release 共存时不串（thin 只装 thin）也在此一并留意（R1）。

## 步骤 C：GitHub Releases 真实链路

1. `release.yml` 已把 6 场景产物 + `.blockmap` 上传 GitHub Releases；GitHub provider 取**最新非草稿 release**（手动流程生成草稿，天然不会被拾取）。
2. 构建时用真实仓库：`GH_OWNER=<owner> GH_REPO=<repo> pnpm --filter @dsh/desktop pack:win`，烘焙的 `resources/app-update.yml` 指向 `github.com/<owner>/<repo>`；发布后**不设** `DSH_UPDATE_FEED_URL`。
3. 安装旧版 → 托盘检查 → 从 GitHub Releases 差分下载 → 退出安装 → 版本跳变。
4. 🔴 **真机项**：需真实 GitHub 仓库 + 已发布 release。评估 R1（`-thin`/`-full` 资产匹配不串）、R8（channel/prerelease 过滤）、R3（差分）均需真实环境核验，本手册未联网实测，不作已验证事实。

## 失败注入与回滚验证

- **断网降级**：停掉静态服务器（或拔网）后触发检查/下载 → boot log 记 `error`，应用**照常启动与使用**；恢复后重试成功。后台下载失败不安装（安装只发生在退出后），不影响已装 dsh。
- **last-known-good 回滚（thin/full 均测）**：每次启动前把当前钉版备份到 `userData/previous-origin.json`；手动注入坏钉版（把 `resources/origin.json` 的 `dshVersion` 改成不存在的版本，或损坏下载缓存）→ 启动 → 新版 dsh 启动失败 → 自动回退上一钉版并提示。
  - 🔴 回退逻辑按评估 Phase A/B 设计（thin 缓存里有旧版则立即可用，full 在 Phase B 解耦后同样可用），需真机核验「启动失败判定」与「回退触发」时序。
- **安装失败**：退出安装被中断（安装器报错/被杀软拦）→ 下次启动仍是旧版本；electron-updater 无中间态，可反复重试。未签名阶段 SmartScreen 会拦截自下载安装包，属预期（评估 3.4）。

## 发布前 checklist（引用 `scripts/check-release.mjs` 纪律）

- [ ] `pnpm check:versions`（全仓版本一致）
- [ ] `pnpm check:release`：**origin.json.dshVersion 变化时必须伴随客户端版本 +1**，否则拒绝发版（updater 以客户端版本为推进单元，同版本不会派发）
- [ ] `pnpm test` 全绿（docs-sync / parity 含 capability 摘要告警）
- [ ] 更新 origin（`pnpm sync:dsh`，非 dry-run）→ bump 客户端版本 → 打 `v*` tag → `release.yml` 发布
- [ ] 发版后 `pnpm mark:released` 记录基线
- [ ] 真机过一遍步骤 A/C，确认版本跳变且 `~/.dsh` 数据完好

## 真机/真实环境核验项（诚实标注）

以下**未在本手册验证**，需真实构建/真机完成：R2（`--publish never` 下 `app-update.yml` 生成）、R3（差分下载量）、R1（`-thin`/`-full` 资产匹配不串）、R8（channel/prerelease 过滤）、R9（退出安装与单实例锁 + 停机 ladder 时序）、R7（portable 检测）、R5（macOS 签名+公证后自动更新）。未签名阶段的 SmartScreen 拦截、full 场景 dsh 版本变化 ≈ 全量下载（评估 3.4 / 3.3）同样需真机确认。

## 与评估文档的衔接

| 本手册步骤 | 对应评估章节/验收 |
| --- | --- |
| 步骤 A 本地 feed 全链路 | Phase A「验证方式」1 的本地化替代（draft release → generic feed） |
| 步骤 B 差分验证 | Phase A「验证方式」2、验收「Windows NSIS thin/full 均可差分更新」；评估 R3 |
| 步骤 C GitHub 真实链路 | Phase A「验证方式」1（真实 release）、R1/R8 |
| 断网降级 | Phase A「验证方式」3、「下载失败不影响运行」 |
| last-known-good 回滚 | Phase A-4 / Phase B-3，评估 3.5「运行时级回滚」 |
| 发布 checklist | Phase A-5 发布纪律 + `scripts/check-release.mjs` |

> 后续阶段（Phase B full 运行时解耦、Phase C 签名与多 channel）就位后，本手册将相应扩展 full 解耦与 channel 分流用例；当前仅覆盖 Phase A 已落地能力。
