# HarnessDock 桌面端自动更新（Auto-update）评估文档

> 状态：评估稿（纯分析，未改任何代码）
> 适用范围：`apps/desktop`（Electron 37 桌面壳，thin / full 双场景）
> 结论基调：**可行，推荐 electron-updater + GitHub Releases provider，以 NSIS 安装包为主更新载体**；未签名阶段仅 Windows 具备完整自动更新条件，macOS 需先签名（Phase C），Portable 单文件 exe 不支持自更（需明确降级路径）。
>
> ⚠️ 本文末尾「风险与待核验项」列出的结论未经联网实测，需在真实构建/真机环境核验后再落地；正文中涉及"待核验"处均显式标注，未将其当作已验证事实。

---

## 1. 现状盘点

### 1.1 发布产物与发布链路（来自 `.github/workflows/release.yml`）

- 触发：推送 `v*` tag（全平台全场景非草稿发布）或手动 `workflow_dispatch`（可选平台/场景/自定义 tag，缺省生成草稿 `unreleased-<时间戳>`）。
- 构建矩阵：`windows-latest`（thin/full）、`ubuntu-latest`（thin/full）、`macos-latest`（thin/full）共 6 个 job，脚本为 `pack:desktop:<os>[:full]`。
- 产物收集：`find apps/desktop/release -maxdepth 1 -type f`，匹配 `*.exe / *.dmg / *.zip / *.AppImage / *.deb / *.blockmap` 全部拷入 `dist/`。
- 发布：`softprops/action-gh-release@v2` 把 `artifacts/*` 全部上传到 GitHub Releases，并生成 release notes（其中明确写明 `.blockmap` 支持差分下载、不是安装包）。
- 签名状态：`CSC_IDENTITY_AUTO_DISCOVERY: 'false'` → **全部产物未签名**（Windows Authenticode、macOS Developer ID 均无）。

**结论**：GitHub Releases 已经是"更新源"，且 `.blockmap`（NSIS 差分所需的元数据）已在发布产物里 —— 这是引入 electron-updater 最有利的既有资产。

### 1.2 产物形态（来自 `apps/desktop/package.json` + electron-builder 配置）

| 平台 | 目标 | 说明 |
| --- | --- | --- |
| Windows | `nsis` + `portable` + `zip`（均 x64） | NSIS 安装版 + 单文件 Portable exe + 免安装 zip |
| macOS | `dmg` + `zip`（x64 + arm64） | 磁盘镜像 + zip |
| Linux | `AppImage` + `deb`（均 x64） | 免安装 AppImage + deb 包 |

- thin（`electron-builder.yml`）：`extraResources` 只带 `plugin-embedded-client` + `origin.json`；`artifactName` 带 `-thin` 后缀。
- full（`electron-builder.full.yml`）：额外 `extraResources` 打包 `../../runtimes/pack` → `resources/dsh-runtime`（内置 Node + dsh，即"288MB 运行时"），另有 `afterPack: copy-runtime.cjs`；`artifactName` 带 `-full` 后缀。
- 公共配置（`electron-builder.common.yml`）：`appId: com.dsh.client`、`productName: HarnessDock`、`asar: true`、NSIS `oneClick: false` + `allowToChangeInstallationDirectory: true`。
- 所有打包脚本均带 **`--publish never`**，且配置里**没有任何 `publish` 段**（已全仓 grep 确认）。

### 1.3 版本对齐机制（来自 `packages/docs-sync`）

- `origin.json`：单份精确钉版，含 `dshVersion`（当前 `0.1.1-rc.2`）、`gitTag`、`gitCommit`、`npmPackage`、`npmIntegrity`（sha512）、`npmTarball`、`docsHash`、`clientVersion`（`0.1.0`）。
- `sync.ts`：`CLIENT_VERSION = '0.1.0'` 常量；`syncDsh` 取 **git tag ∩ npm 发布版本**的交集（`rejectFloatingDistTag` 禁止 `latest`/`next` 等浮动 tag），可 `--pin` 指定，或 `--check` 供 CI 检查。更新写入 `origin.json` + `capability-matrix.yaml`。
- CI（`ci.yml` 的 `sync` job）：每天定时 `pnpm sync:dsh` + 手动触发，产出 PR「chore: sync HarnessDock dsh origin to latest documented version」。
- `origin.json` 被**打包进桌面产物**（`resources/origin.json`），`main.ts` 启动时读取它来决定运行时模式。

### 1.4 运行时启动方式（来自 `packages/client-runtime/src/runtime.ts` + `apps/desktop/src/main.ts`）

- `main.ts`：单实例锁（`requestSingleInstanceLock`，二次启动只聚焦已有窗口）、`window-all-closed → quit`、`before-quit → beginShutdown`（dsh 停机 ladder）、崩溃时 `forceKillTree(dshPid)` + `app.exit(1)`。
- 启动流程：读 `resources/origin.json` → `inspectBundledRuntime` 判断 bundled 与否 → thin 走 `download` 模式（`ensureDownloadedRuntime` 从 npm 镜像拉钉版 dsh，`userData/runtime-cache`），full 走 `bundled` 模式（离线）。
- `fetch-runtime.ts` 关键能力（对更新策略很重要）：
  - 缓存**按 dsh 版本分目录**：`<cacheDir>/runtime-<version>`，多版本可共存；
  - 下载**可续传**（每个包 `INSTALL_MARKER` 标记，中断后跳过已完成的包）、根包用 `origin.npmIntegrity` 做 sha512 校验；
  - `DSH_RUNTIME_CLEAN=1` 可强制重下。

---

## 2. 关键结论先行（推荐方案摘要）

1. **方案**：接入 `electron-updater`（electron-builder 生态的更新器，与 electron-builder 26 配套的 ^6.x）+ **GitHub Releases provider**（复用现有发布链路与 `.blockmap`）。
2. **主更新载体：Windows NSIS 安装包**。它支持 blockmap 差分、后台静默下载、退出时安装，且本项目的 `.blockmap` 已在发布产物中。
3. **Portable 单文件 exe 无法自更新**：electron-builder 的 portable 是自解压单文件，运行时无法替换自己。检测到 portable 模式即禁用自动更新，降级为"提示用户下载新版 Portable exe 手动替换"。此局限必须在文档与 UI 中向用户明示。
4. **thin 是最佳自动更新对象**：客户端更新体小（只含壳，NSIS 差分后更小），dsh 运行时升级天然走"按版本增量下载"通道（现有 fetch-runtime），不占用安装包体积。
5. **full 场景的 288MB 更新是主要痛点**：dsh 版本不变时，NSIS 差分几乎不下载（运行时块未变）；**dsh 版本一变 ≈ 全量 288MB**。建议 Phase B 把 full 的运行时从"打包内不可分离"改为"离线引导种子 + 按需增量缓存"（复用 fetch-runtime），把 dsh 升级从安装包更新中解耦出去。
6. **客户端版本是"一致性单元"**：一次发版 = 新客户端版本 + 新 `origin.json`（新钉版 dsh），二者打包在一起。自动更新只推进"新客户端"，新客户端携带钉版 origin，因此**更新后不会出现"客户端新、运行时旧"的错位**。需要发布纪律：dsh 升级必须伴随客户端版本 +1，否则同版本不会被 updater 视为更新。
7. **签名**：Windows 未签名可跑自动更新但 SmartScreen 会反复拦截（体验差、误报风险高）；**macOS 自动更新硬性依赖代码签名**（Squirrel.Mac 校验签名），未签名阶段 mac 只能"提示手动下载"。签名列为 Phase C 前置/并行项，Windows 强烈建议、macOS 必须。
8. **可靠性基线**：后台下载失败不影响现有 dsh 使用（更新只发生在退出后的安装阶段）；回滚靠"保留上一版本 origin 作为 last-known-good" + 运行时级回退（thin/full 都能低成本回退 dsh 版本），而非回滚整个客户端。

---

## 3. 分维度评估

### 3.1 更新载体（electron-updater 对各类产物的支持与局限）

| 载体 | 支持度 | 差分 | 说明与局限 |
| --- | --- | --- | --- |
| **NSIS（Windows，主推）** | ✅ 一等公民 | ✅ blockmap 自动差分 | 需"已通过安装版安装"的实例才能差分；支持后台下载 + 退出时安装。本项目 `.blockmap` 已在 release 资产中，可直接用。`oneClick:false` 影响首次安装交互，不影响更新安装。 |
| Portable exe（Windows） | ❌ 不支持自更 | — | 自解压单文件，无法替换运行中的 exe。用 `PORTABLE_EXECUTABLE_FILE`（electron-builder 运行时注入的环境变量，**待核验变量名/行为**）检测并降级。 |
| zip（Windows） | ⚠️ 支持有限 | 部分 | Windows 下官方推荐 NSIS；zip 更新无安装动作、需自管理替换。不作为主载体（**待核验**：当前版本对 win zip 的确切支持状态）。 |
| dmg / zip（macOS） | ✅（经 Squirrel.Mac） | mac zip 支持差分 | 标准载体是 **zip**（dmg 不是自动更新载体）。**硬前提：当前与目标应用必须已用同一 Developer ID 签名（含 hardened runtime）**，否则签名校验失败。未签名阶段 mac 自动更新不可用。 |
| AppImage（Linux） | ✅ 可更新 | ❌ 无差分 | 差分自 electron-updater 6.x 移除（appimage-update 库移除），**永远全量下载**（**待核验**当前状态）。更新时无安装动作，直接替换 AppImage。 |
| deb / rpm（Linux） | ⚠️ 有限 | 无 | 通常走系统包管理器 / 自建 apt 仓库，electron-updater 的 deb 支持范围有限（**待核验**）。不做主推。 |

**结论**：Windows NSIS 是唯一"差分 + 静默安装 + 成熟"的载体，作为自动更新的主战场；macOS 在签名后就位后跟进；Linux AppImage 可提供"全量下载"式自动更新（低成本），deb 不做自动更新。

### 3.2 更新源（GitHub Releases provider + channel）

- **现状已具备**：`release.yml` 已把全部场景产物 + `.blockmap` 上传 GitHub Releases；tag 推送生成非草稿 release，符合 GitHub provider "取最新非草稿 release"的要求（手动流程生成草稿，天然不会被 updater 拾取，安全）。
- **缺口 1（必改）**：electron-builder 配置无 `publish` 段 + 脚本 `--publish never` → 构建时**不会生成 `resources/app-update.yml`**，electron-updater 运行时拿不到 provider 信息。需在 `electron-builder.common.yml` 加 `publish: { provider: github, owner, repo }`。
  - 注意：`--publish never` 只是不让 electron-builder 自己上传；只要配置了 publish provider，构建期仍应生成 app-update.yml（**待核验**：electron-builder 26 在 `--publish never` 下是否仍生成 app-update.yml，若否需临时用 `--publish onTag` 或生成后不实际上传）。
  - 建议**保留现有 action-gh-release 上传链路不动**，只补 publish 配置，避免动发布流程。
- **asset 匹配**：GitHub provider 按"当前构建配置的 artifactName 模式"匹配 release 资产。本项目自定义 `artifactName` 带 `-thin` / `-full` 及 `os/arch` 后缀，且 thin/full 用不同配置文件构建 → 各自的 app-update.yml 只含各自的模式，理论上不会串（thin updater 不会抓 full 的包）。**待核验**：electron-updater 6.x 对带场景后缀 asset 名的精确匹配行为，需用真实 release 验证。
- **多 channel 与 dsh 钉版配合**：electron-updater GitHub provider 的 channel 由版本号后缀（如 `-beta`）与 release 的 prerelease 标志共同决定。
  - 建议映射：**stable 客户端**（无后缀，如 `0.1.1`）钉 **stable dsh**；**beta 客户端**（如 `0.2.0-beta.1`）钉 **rc dsh**（docs-sync 已能列出含 rc 的精确版本，`origin.json` 当前就是 rc）。
  - 实现上需要"按 channel 注入不同 origin.json"（构建参数化），因为 `origin.json` 是单份。**待核验**：GitHub provider 对 prerelease 过滤 + channel 后缀的精确语义。
  - 次要：GitHub provider 对公开仓库走匿名 API（有速率限制）；私有仓库才需要 token。当前项目公开仓库无需额外凭证。

### 3.3 版本对齐约束（dsh 升级 = 新 origin.json + 新客户端版本）

- **一致性由"客户端版本 = 唯一推进单元"保证**：自动更新下载的是"新客户端二进制"；新客户端内嵌新 `origin.json`（新钉版 dsh）。thin 启动时按钉版拉 dsh（按版本缓存），full 内置钉版运行时。因此**自动更新不可能产生"客户端新、运行时旧"的错位** —— 运行时始终跟随客户端内嵌的钉版。
- **反向也不会**：thin 只拉 `origin.json` 里钉的那个版本；full 只跑内置版本；缓存按 `runtime-<version>` 隔离，多版本共存，不会互相污染。
- **两个必须管理的风险**：
  1. **发布纪律**：`ci.yml` 的 docs-sync PR 只改 `origin.json`，**不 bump 客户端版本**。若直接在该 PR 上发版 → 客户端版本号未变 → electron-updater 认为无更新（同版本不更新），用户拿不到新钉版。**规则**：发版 = 更新 origin + 客户端 patch 版本 +1 + 打 `v*` tag（走 release.yml）。可加一个发布脚本/check 强制"origin.dshVersion 变化 ⇒ package.json version 变化"。
  2. **full 场景 288MB 体验**：
     - dsh 版本不变、仅壳改动 → NSIS 差分下载量极小（dsh-runtime 块未变，blockmap 差分为 0），体验好。
     - **dsh 版本一变 → 近全量 288MB**：full 用户本是冲着"免下载"来的，每次 dsh 升级都要重下运行时，必须处理。
     - **替代思路（Phase B 落地）**：把 full 的 `dsh-runtime` 从"app 内不可分离的一部分"改为 **"离线引导种子 + 按需增量缓存"**：
       - 保留 bundle 作为离线兜底（首启/断网可用）；
       - 启动时若 `origin.dshVersion` ≠ 种子版本且联网 → 用现有 `ensureDownloadedRuntime` 把新版 dsh 拉到 userData 缓存运行（**复用 thin 的按版本缓存、可续传、integrity 校验**）；
       - 于是"客户端升级"与"dsh 运行时升级"解耦：客户端更新走 electron-updater（小、差分），dsh 更新走 fetch-runtime（增量、只下新依赖差量）。
       - 收益：full 用户升级 dsh 不再全量 288MB；获得与 thin 相同的多版本缓存/回退能力。代价：full 不再是"完全离线升级"（离线用户停在种子版本，需手动装新安装包）——需在文档与 UI 中说明。
- 另一个对齐点：Electron 主版本（当前 37）与 asar 结构。electron-updater 是整包替换，无中间态；升级 Electron 大版本本身就是一次普通发版，无额外约束。

### 3.4 签名与安全

| 平台 | 未签名现状的影响 | 自动更新可用性 |
| --- | --- | --- |
| Windows | NSIS 安装包触发 SmartScreen「Windows 已保护你的电脑」；自动更新下载的新安装包同样触发，用户需"更多信息 → 仍要运行"。功能可用，但每次升级 UX 差、被误报/被杀软处置的风险高。 | ✅ 可用（体验差） |
| macOS | 无签名 → Gatekeeper 拦截 + **Squirrel.Mac 更新时校验代码签名会失败**。 | ❌ 不可用，需先签名 |
| Linux | 无强制签名要求（AppImage 可无签/自签）；deb 由系统信任链管理。 | ✅ 可用 |

- **macOS 自动更新的确切要求（待核验）**：electron-updater 在 mac 上要求当前与目标应用均使用同一 Developer ID 签名且满足 hardened runtime / notarization；公证（notarization）在 macOS 12+ 是运行必需。未签名阶段 mac 更新方案只能是"检测到新版本 → 提示下载 dmg/zip 手动安装"。
- **建议**：把签名作为 **Phase C 前置项**（macOS 是硬门槛，Windows 强烈建议）。Windows 用 Authenticode 证书（OV 起步、EV 更佳）；macOS 需要 Developer ID Application 证书 + notarization，release.yml 需配置 `CSC_LINK` / `CSC_KEY_PASSWORD` / Apple 凭证 Secrets，并移除硬编码的 `CSC_IDENTITY_AUTO_DISCOVERY=false`（改为按平台条件）。
- 未签名阶段的安全基线：GitHub provider 走 HTTPS API，`.blockmap` 内含 sha512 校验 → 下载内容一致性有保障；但缺"签名校验"这一层。签名后就位后 electron-updater 的下载物校验更完整。

### 3.5 可靠性（回滚、失败处理、下载策略）

- **失败处理（核心优点）**：electron-updater 默认 `autoDownload: true` 后台下载，失败不安装；**安装发生在应用退出后**（NSIS 由退出流程拉起），若安装失败，下次启动仍是旧版本。更新只动安装目录，**不碰 `~/.dsh` 数据** → 更新失败不影响现有 dsh 使用。本项目单实例锁确保二次启动立即退出，不会重复触发检查/安装。
- **回滚策略**：
  - electron-updater **无内建"上一版本"回滚**，且默认 `allowDowngrade: false`（防被打回旧版）。真正的回滚建议走两层：
    1. **运行时级回滚（重点）**：更新前把当前 `origin.json` 拷贝到 `userData/previous-origin.json`（仅版本变化时更新）。若新版钉版 dsh 启动失败（`waitForReady` 超时/退出），自动回退到 last-known-good 的 dsh 版本 —— thin 缓存里若已有旧版本则**立即可用**，full 在 Phase B 解耦后同样可用。这比回滚整个客户端便宜得多，对 rc 阶段的 dsh 尤为重要。
    2. **客户端级回滚**：GitHub 上旧版本资产保留（action-gh-release 默认不清），用户可手动下载旧 NSIS 安装回滚（版本不冲突、安装目录可换）。
  - 补充：NSIS 升级会覆盖安装目录，dsh 数据在 `~/.dsh`，不受影响。
- **后台静默下载 vs 提示用户（建议）**：
  - 启动时**静默 check** + 后台下载（不打断用户）；
  - 下载完成后 UI 提示「更新已就绪，重启安装」（避免静默强制重启打断正在进行的 dsh 会话）；默认 `autoInstallOnAppQuit: true`，用户正常退出时自动安装；
  - 设置里提供"自动下载 / 仅提醒"开关；
  - 下载进度可复用现有 `onProgress` 模式与 splash 展示，整合进"关于/设置"面板。
- **边界**：崩溃路径 `app.exit(1)` 会跳过退出安装（异常态可接受，需记录日志）；`before-quit → beginShutdown` 有 12s 停机预算，quit 后 NSIS 安装可执行（**需实测**：单实例 + 停机 ladder 与退出安装的时序）。

---

## 4. 分阶段实施建议

### Phase A —— 最小可用（electron-updater 接入 + 手动检查 + NSIS 差分）

**目标**：Windows NSIS（thin/full）从 GitHub Releases 完成差分自动更新；Portable 明确禁用并降级提示；不引入签名、多 channel、full 解耦。

**具体改动点**：
1. `apps/desktop/package.json`：新增依赖 `electron-updater`（与 electron-builder 26 配套的 ^6.x，版本以 lockfile 为准）。
2. `apps/desktop/electron-builder.common.yml`：新增 `publish: { provider: github, owner: <owner>, repo: <repo> }`（owner/repo 值待定或用构建变量）。**不动 release.yml 的 action-gh-release 上传链路**。验证构建产物生成 `resources/app-update.yml`（thin 与 full 各一份）。
3. `apps/desktop/src/main.ts`（+ preload/UI）：
   - 仅当 `app.isPackaged` 且**非 portable**（检测 `PORTABLE_EXECUTABLE_FILE`）时初始化 `autoUpdater` 并 `checkForUpdates()`；
   - 监听 `checking-for-update / update-available / update-not-available / download-progress / update-downloaded`，写入 `bootLog`，并把状态推给渲染层（"关于/设置"面板展示检查结果与下载进度）；
   - `update-downloaded` 后提示「重启安装 / 稍后」，默认 `autoInstallOnAppQuit: true`；
   - portable 分支：跳过自动更新，提供"打开 GitHub Releases 页 → 下载新版 Portable exe 手动替换"。
4. **回滚种子**：启动时若 `origin.json` 与 `userData/previous-origin.json` 版本不同则更新备份；新增"运行时启动失败 → 尝试 last-known-good origin"的兜底（最小版：失败时提示 + 日志，不自动切换也可，但建议做）。
5. **发布纪律**：加一个发布检查（脚本或 CI 步骤）：`origin.json.dshVersion` 变化时强制 `apps/desktop/package.json` 版本 +1，否则拒绝发版。发布路径维持：更新 origin → bump 客户端版本 → 打 `v*` tag → release.yml 自动发布。
6. 文档/UI：写明 Portable 不自更、full 更新体积随 dsh 版本变化的说明。

**验证方式**：
- 本地用临时 GitHub repo 或 draft release 上传 v0.1.0 → v0.1.1 两套 thin NSIS 资产，安装 v0.1.0 后手动触发检查 → 观察下载进度 → 重启安装 → 版本跳变。
- 差分验证：仅改 asar 内一个文件再发版，观察 `download-progress` 总字节应远小于全量；thin/full 资产同 release 共存时互不串（thin 装的是 thin、full 装的是 full）。
- 失败注入：断网触发检查/下载 → 应用照常启动使用；恢复后重试成功。
- 断言 `resources/app-update.yml` 存在且指向正确 owner/repo。

**验收标准**：Windows NSIS thin/full 均可从 GitHub release 差分更新并完成退出安装；下载失败不影响运行；Portable 明确禁用自动更新并引导手动替换；发布检查阻止"origin 变更但版本未 +1"。

### Phase B —— 运行时更新策略 + full 场景优化

**目标**：把 dsh 运行时升级与客户端升级解耦，full 用户升级 dsh 不再全量 288MB；补齐运行时级自动回滚。

**具体改动点**：
1. **full 运行时解耦**（`main.ts` + `runtime.ts` 调用侧）：
   - 保留 `resources/dsh-runtime` 作为**离线引导种子**；
   - 启动时若 `origin.dshVersion` ≠ 种子版本且联网 → 用 `ensureDownloadedRuntime` 拉新版到 `userData/runtime-cache` 运行（复用按版本缓存/续传/integrity）；
   - 离线且种子版本 ≠ 钉版 → 用种子运行 + UI 提示"有新版本，联网后更新"。
   - 由此 full 的"客户端更新"（electron-updater，小）与"dsh 更新"（fetch-runtime，增量）分离。
2. **更新体积预算**：release notes 动态标注"本次 dsh 版本是否变化 + 预计更新大小"（基于 origin diff 估算，full 尤其需要）。
3. **运行时级回滚增强**：新版钉版 dsh 启动失败 → 自动回退 `previous-origin.json` 的 dsh 版本并提示（thin/full 共用）。
4. **更新体验 UI**：把下载进度（复用 `onProgress`）整合进"关于/设置"面板；提供"仅提醒/自动下载"开关。

**验证方式**：
- full 场景模拟 dsh 版本变更：装 vN（dsh 0.1.1）→ 发布 vN+1（dsh 0.1.2，仅依赖差量）→ 升级后 dsh 跑新版本，缓存出现 `runtime-0.1.2`，下载量远小于 288MB。
- 断网升级 full：种子版本回退可用、UI 提示正确。
- 回滚注入：让新版 dsh 启动失败 → 自动回退旧版 dsh 并正常启动。

**验收标准**：full 用户升级 dsh 不再全量 288MB；离线兜底不破坏；运行时级回滚自动化且日志可查；更新下载中断后续传。

### Phase C —— 签名与多 channel

**目标**：三平台自动更新全部可用；stable/beta channel 正确分流；签名校验生效。

**具体改动点**：
1. **Windows 代码签名**：购置 Authenticode 证书（OV 起步，SmartScreen 信誉需时间积累）；release.yml 配置 `CSC_LINK` / `CSC_KEY_PASSWORD`（Secrets），`CSC_IDENTITY_AUTO_DISCOVERY` 改为按平台条件（不再全局 false）。
2. **macOS 签名 + notarization**：Developer ID Application 证书 + hardened runtime + entitlements + notarization（Apple 凭证 Secrets）；`electron-builder.common.yml` 的 mac 段补 `hardenedRuntime` 等；mac zip 自动更新在签名后启用。
3. **多 channel**：
   - 构建参数化注入 origin：`CHANNEL=stable|beta` → 使用对应 `origin.json`（stable 钉非 rc 的最新 dsh，beta 可钉 rc）+ 客户端版本带 channel 后缀；
   - GitHub release 按 channel 打 prerelease 标志 → electron-updater channel 匹配（stable 客户端不会吃到 beta）；
   - `docs-sync` 增加"按 channel 选版本"支持（stable 只取非 rc，beta 可含 rc）。
4. 签名后启用 electron-updater 更完整的下载物校验；补全异常/校验失败的错误提示。

**验证方式**：
- Windows：签名后安装包 SmartScreen 明显弱化/消除；篡改签名 → 安装被拦截。
- macOS：真机验证签名 + 公证 + 自动更新（未签名阶段无法验证，必须先就位签名）。
- channel：同时发布 stable `0.1.1` 与 beta `0.2.0-beta.1` → stable 客户端只收到 stable 更新，beta 客户端收到 beta。

**验收标准**：Windows NSIS 差分更新无 SmartScreen 强拦截；macOS 自动更新可用（签名 + 公证）；Linux AppImage 全量自动更新可用；多 channel 分流正确；签名校验生效。

---

## 5. 风险与待核验项

### 5.1 必须联网实测 / 依赖官方文档核验的结论（本任务未联网验证，勿当已验证）

| # | 待核验项 | 为什么关键 | 影响面 |
| --- | --- | --- | --- |
| R1 | electron-updater（配 electron-builder 26 的 ^6.x 版本）对 **GitHub provider** 的精确行为，特别是**带 `-thin`/`-full` 及 os/arch 后缀的自定义 artifactName** 的 asset 匹配规则（同 release 共存是否可靠不串）。 | 决定 thin/full 资产能否安全共用同一 release。 | Phase A |
| R2 | electron-builder 26 在 **`--publish never`** 下是否仍生成 `resources/app-update.yml`（publish provider 已配置时）。 | 决定是否需要调整打包命令。 | Phase A |
| R3 | NSIS **blockmap 差分**在当前版本是否默认开启、所需前提（已安装版、`.blockmap` 必须存在于源）；差分在"运行时未变、仅壳变"场景的实际下载量。 | 差分是本方案主卖点，需实测下载字节。 | Phase A |
| R4 | Windows **zip** 载体在 electron-updater 当前版本的确切支持状态（是否可更新、是否有差分）。 | 决定是否保留 zip 作为备用载体。 | Phase A/B |
| R5 | **macOS** 自动更新对签名 + 公证的确切要求与行为：Squirrel.Mac 校验细节、`hardenedRuntime`/entitlements 要求、未签名时失败的具体表现。 | mac 自动更新硬前提，决定 Phase C 时间线。 | Phase C |
| R6 | **Linux**：AppImage 差分是否确已在 6.x 移除（当前全量下载）；DebUpdater/RpmUpdater 的支持范围与是否需要自建 apt 仓库。 | 决定 Linux 自动更新策略与是否做。 | Phase C |
| R7 | **Portable**：`PORTABLE_EXECUTABLE_FILE` 在 electron-builder 26 下是否仍由运行时注入、检测是否可靠；有无官方推荐的自更新替代路径。 | Portable 不自更的降级路径依赖此检测。 | Phase A |
| R8 | **channel / prerelease** 过滤的精确语义：GitHub provider 选"最新 release"的规则、draft/prerelease 过滤、`-beta` 后缀与 prerelease 标志的交互。 | 多 channel 正确分流的前提。 | Phase C |
| R9 | 退出安装与**单实例锁 + 停机 ladder** 的时序：`before-quit → beginShutdown` 完成后 NSIS 安装能否可靠拉起；崩溃路径 `app.exit(1)` 跳过安装的行为确认。 | 安装环节可靠性。 | Phase A |
| R10 | 证书获取周期/成本与 **SmartScreen 信誉建立**的现实时间线；未签名阶段杀软对自下载 NSIS 的处置情况。 | 决定签名投入与未签名阶段的运营预期。 | Phase C |

### 5.2 业务/工程风险

- **dsh 处于 rc 阶段**：自动更新可能把用户推进不可用的 dsh 版本。**上线硬前提**：Phase A 的 last-known-good + 运行时级回滚必须先于大规模自动更新。建议早期以"仅提醒 + 手动安装"灰度，再切自动。
- **full 用户"免下载"心智 vs dsh 升级全量下载**的矛盾：若 Phase B 不落地，需在发布说明与 UI 明确"full 升级 dsh 可能 ~288MB"，避免口碑反噬。
- **发布纪律失效**：docs-sync PR 不改客户端版本 → 同版本不发更新。用发布检查（Phase A-5）强制闭环。
- **同 release 双场景资产**：若 R1 验证发现 asset 匹配会串，需拆分（如按场景打不同 release/channel，或统一 artifactName 前缀）。
- **多 channel 引入前**：当前 `origin.json` 钉的是 rc dsh 版本，客户端却是 stable 语义 —— 在 channel 落地前，应明确当前发布实际上属于"beta 性质"，避免 stable 用户被推向 rc 运行时。

---

## 附录 A：事实依据（已读取的仓库文件）

- `README.md`：双场景 thin/full、Portable、版本钉版机制（`pnpm sync:dsh`，禁止 `latest`/`next`）。
- `.github/workflows/release.yml`：6 场景矩阵构建、产物（含 `.blockmap`）上传 GitHub Releases、`CSC_IDENTITY_AUTO_DISCOVERY=false`（未签名）。
- `.github/workflows/ci.yml`：test/pack（不上传）+ 每日 `sync` job 自动升 origin 并开 PR。
- `packages/docs-sync/origin.json`：`dshVersion 0.1.1-rc.2`、`clientVersion 0.1.0`、npm sha512 钉版。
- `packages/docs-sync/src/sync.ts`：`CLIENT_VERSION` 常量、git tag ∩ npm 精确选版、拒绝浮动 tag、写 origin.json。
- `apps/desktop/package.json`：Electron ^37.3.1、electron-builder ^26.0.12、打包脚本均 `--publish never`。
- `apps/desktop/electron-builder.common.yml` / `electron-builder.yml` / `electron-builder.full.yml`：asar、NSIS/portable/zip、dmg/zip、AppImage/deb 目标；full 额外内置 `dsh-runtime`；**无 publish 配置**。
- `packages/client-runtime/src/runtime.ts`、`fetch-runtime.ts`：启动 dsh 方式；按 dsh 版本分目录缓存、可续传、integrity 校验。
- `apps/desktop/src/main.ts`：单实例锁、退出 ladder、崩溃处理、读取 `resources/origin.json`、thin download / full bundled 模式。

## 附录 B：改动点速查（按文件）

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/package.json` | +`electron-updater` 依赖 |
| `apps/desktop/electron-builder.common.yml` | +`publish: { provider: github, ... }`（Phase A） |
| `apps/desktop/src/main.ts`（+ preload/UI） | 接入 autoUpdater、portable 检测降级、last-known-good 备份、运行时回滚（A/B） |
| `packages/docs-sync/src/sync.ts` / origin 注入 | 按 channel 选版 + 构建参数化注入（Phase C） |
| `scripts/` 或 CI | 发布检查：origin 变更 ⇒ 客户端版本 +1（Phase A） |
| `.github/workflows/release.yml` | 签名 Secrets、按平台签名条件（Phase C） |
