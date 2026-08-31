import { app } from 'electron'

/**
 * Minimal i18n (D3). No framework: a flat key → { 'zh-CN', en } table plus a
 * `t()` lookup that follows `app.getLocale()` (`zh*` → zh-CN, anything else →
 * en). `t(key, locale?)` accepts an explicit locale so the pure lookup is
 * unit-testable without an Electron runtime; when omitted it resolves the
 * system locale lazily (guarded so tests / early-boot calls never crash).
 *
 * Dynamic values are injected with `fmt(template, params)` using `{name}`
 * placeholders — still plain string replacement, not a framework.
 */

export type Locale = 'zh-CN' | 'en'

export type MessageEntry = { 'zh-CN': string; en: string }

export const messages: Record<string, MessageEntry> = {
  // ---------- app / common ----------
  'common.appTitle': { 'zh-CN': 'HarnessDock', en: 'HarnessDock' },
  'common.close': { 'zh-CN': '关闭', en: 'Close' },
  'common.copied': { 'zh-CN': '已复制', en: 'Copied' },
  // ---------- closing window ----------
  'closing.title': { 'zh-CN': '正在关闭 HarnessDock…', en: 'Closing HarnessDock…' },
  'closing.body': { 'zh-CN': '正在停止运行时，请稍候…', en: 'Stopping the runtime, please wait…' },

  // ---------- boot failure ----------
  'boot.failed.title': { 'zh-CN': 'HarnessDock 启动失败', en: 'Failed to start HarnessDock' },
  'boot.failed.summary': { 'zh-CN': '无法启动 HarnessDock', en: 'Failed to start HarnessDock' },
  'boot.failed.retry': { 'zh-CN': '重试', en: 'Retry' },
  'boot.failed.message': {
    'zh-CN':
      '首次启动需联网下载当前系统与 CPU 架构所需运行时，实际体积因平台而异。\n\n常见修复：\n' +
      '  • 检查网络连接 / 代理 / 防火墙；\n' +
      '  • 重启应用——部分下载会自动续传；\n' +
      '  • 公司网络：设置环境变量 DSH_NPM_MIRROR 指向 npm 镜像。\n\n' +
      '日志文件：{logFile}',
    en:
      'First launch downloads only the runtime required for this OS and CPU architecture; size varies by platform.\n\n' +
      'Common fixes:\n' +
      '  • Check your internet connection / proxy / firewall;\n' +
      '  • Restart the app — partial downloads are retried automatically;\n' +
      '  • Corporate networks: set env DSH_NPM_MIRROR to an npm mirror.\n\n' +
      'Log file: {logFile}',
  },

  // ---------- download (main window) ----------
  'download.failed.title': { 'zh-CN': '下载失败', en: 'Download failed' },
  'download.failed.detail': { 'zh-CN': '无法保存到 {path}', en: 'Could not save {path}' },

  // ---------- renderer crash / unresponsive ----------
  'crash.renderer.title': { 'zh-CN': '工作区渲染进程崩溃', en: 'The workspace renderer crashed' },
  'crash.renderer.detail': {
    'zh-CN': '自动恢复在 {count} 次尝试后失败（原因：{reason}）。',
    en: 'Automatic recovery failed after {count} attempts (reason: {reason}).',
  },
  'crash.renderer.reload': { 'zh-CN': '重新加载', en: 'Reload' },
  'crash.renderer.ignore': { 'zh-CN': '忽略', en: 'Ignore' },
  'crash.unresponsive.title': { 'zh-CN': '工作区无响应', en: 'The workspace is not responding' },
  'crash.unresponsive.detail': { 'zh-CN': '渲染进程似乎已卡住。', en: 'The renderer process appears to be stuck.' },
  'crash.unresponsive.wait': { 'zh-CN': '继续等待', en: 'Keep waiting' },
  'crash.unresponsive.reload': { 'zh-CN': '重新加载', en: 'Reload' },

  // ---------- crash guard (main process) ----------
  'crash.guard.title': { 'zh-CN': 'HarnessDock 崩溃', en: 'HarnessDock crashed' },
  'crash.guard.message': {
    'zh-CN': '发生意外错误，应用必须关闭。\n\n{error}\n\n日志文件：{logFile}',
    en: 'An unexpected error occurred and the app must close.\n\n{error}\n\nLog file: {logFile}',
  },

  // ---------- auto-update ----------
  'update.available.title': { 'zh-CN': 'HarnessDock 更新', en: 'HarnessDock update' },
  'update.available.body': {
    'zh-CN': '发现新版本 {version}，正在后台下载…',
    en: 'New version {version} found, downloading in the background…',
  },
  'update.downloaded.title': { 'zh-CN': 'HarnessDock 更新已就绪', en: 'HarnessDock update ready' },
  'update.downloaded.body': {
    'zh-CN': '新版本 {version} 已下载完成，重启后安装。',
    en: 'New version {version} downloaded, will install on restart.',
  },
  'update.restart.title': { 'zh-CN': '新版本 {version} 已下载完成', en: 'New version {version} downloaded' },
  'update.restart.detail': {
    'zh-CN': '重启应用即可完成安装。更新只替换安装目录，不会影响你的数据（~/.dsh）。',
    en: 'Restart the app to finish installing. Updates only replace the install directory and do not affect your data (~/.dsh).',
  },
  'update.restart.now': { 'zh-CN': '立即重启安装', en: 'Restart & install now' },
  'update.restart.later': { 'zh-CN': '稍后', en: 'Later' },
  'update.noFeed.body': {
    'zh-CN': '当前构建未配置更新源。请前往项目 GitHub Releases 页手动下载新版。',
    en: 'This build has no update feed configured. Please download the new version manually from the GitHub Releases page.',
  },

  // ---------- rollback notification ----------
  'rollback.notification': {
    'zh-CN': '新版 dsh {from} 启动失败，已回退到上一版本 {to}。',
    en: 'New dsh {from} failed to start; rolled back to the previous version {to}.',
  },

  // ---------- tray ----------
  'tray.toggle': { 'zh-CN': '显示 / 隐藏工作台', en: 'Show / Hide workspace' },
  'tray.checkUpdate': { 'zh-CN': '检查更新…', en: 'Check for updates…' },
  'tray.openLog': { 'zh-CN': '打开日志目录', en: 'Open log directory' },
  'tray.diagnostics': { 'zh-CN': '诊断', en: 'Diagnostics' },
  'tray.versions': { 'zh-CN': '版本管理…', en: 'Runtime versions…' },
  'tray.quit': { 'zh-CN': '退出 HarnessDock', en: 'Quit HarnessDock' },
  'tray.tooltip': { 'zh-CN': 'HarnessDock — dsh 客户端', en: 'HarnessDock — dsh client' },

  // ---------- splash ----------
  'splash.starting': { 'zh-CN': '正在启动…', en: 'Starting…' },
  'splash.loading': { 'zh-CN': '正在加载配置…', en: 'Loading configuration…' },
  'splash.startingRuntime': { 'zh-CN': '正在启动运行时…', en: 'Starting runtime…' },
  'splash.firstLaunch': {
    'zh-CN': '首次启动：正在下载当前平台运行时，体积因系统与 CPU 架构而异…',
    en: 'First launch: downloading the runtime for this OS/CPU; size varies by platform…',
  },
  'splash.downloading': {
    'zh-CN': '正在下载当前平台运行时：{pct}（组件 {done}/{total}，已下载 {bytes}）\n{name}',
    en: 'Downloading runtime for this platform: {pct} ({done}/{total} components, {bytes} downloaded)\n{name}',
  },
  'splash.resolving': { 'zh-CN': '正在解析 {total} 个当前平台运行时包…', en: 'Resolving {total} platform runtime packages…' },
  'splash.resolvingUnknown': {
    'zh-CN': '正在解析当前平台运行时包…（{done}）',
    en: 'Resolving platform runtime packages… ({done})',
  },
  'splash.ready': { 'zh-CN': '运行时就绪，正在启动…', en: 'Runtime ready, starting…' },
  'splash.loadingInterface': { 'zh-CN': '正在加载界面…', en: 'Loading interface…' },
  'splash.hint.network': {
    'zh-CN': '首次启动仅下载当前系统与 CPU 架构所需运行时，体积因平台而异；\n请保持网络畅通并耐心等待。',
    en: 'First launch downloads only the runtime required for this OS/CPU; size varies by platform.\nPlease keep your connection stable and wait.',
  },
  'splash.hint.stuck': {
    'zh-CN': '如长时间停留在当前步骤：检查网络 / 代理与防火墙；\n也可设置镜像环境变量 DSH_NPM_MIRROR 后重试。',
    en: 'If it stays on the current step: check your network / proxy and firewall;\nyou can also set the mirror env var DSH_NPM_MIRROR and retry.',
  },
  'splash.hint.resume': {
    'zh-CN': '重新启动会自动恢复下载，已完成的部分无需重做。',
    en: 'Restarting resumes the download automatically; already-downloaded parts are not redone.',
  },
  'splash.error.title': { 'zh-CN': '启动失败', en: 'Startup failed' },
  'splash.error.retry': { 'zh-CN': '重试', en: 'Retry' },
  'splash.error.openLog': { 'zh-CN': '打开日志', en: 'Open log' },
  'splash.error.copyError': { 'zh-CN': '复制错误', en: 'Copy error' },
  'splash.error.copied': { 'zh-CN': '已复制', en: 'Copied' },

  // ---------- diagnostics panel ----------
  'diag.title': { 'zh-CN': '诊断与版本管理', en: 'Diagnostics & Runtime Versions' },
  'diag.tab.info': { 'zh-CN': '诊断', en: 'Diagnostics' },
  'diag.tab.versions': { 'zh-CN': '版本管理', en: 'Runtime versions' },
  'diag.tab.log': { 'zh-CN': '日志', en: 'Log' },
  'diag.field.current': { 'zh-CN': '当前 dsh 版本', en: 'Current dsh version' },
  'diag.field.pinned': { 'zh-CN': 'origin 钉版', en: 'Pinned (origin)' },
  'diag.field.override': { 'zh-CN': '本地覆盖', en: 'Local override' },
  'diag.field.mode': { 'zh-CN': '运行时模式', en: 'Runtime mode' },
  'diag.field.bundled': { 'zh-CN': '内置种子可用', en: 'Bundled seed available' },
  'diag.field.seed': { 'zh-CN': '种子版本', en: 'Seed version' },
  'diag.field.cacheDir': { 'zh-CN': '缓存目录', en: 'Cache directory' },
  'diag.field.cacheSize': { 'zh-CN': '缓存占用', en: 'Cache size' },
  'diag.field.pid': { 'zh-CN': 'dsh PID', en: 'dsh PID' },
  'diag.btn.export': { 'zh-CN': '导出诊断包', en: 'Export diagnostics' },
  'diag.btn.cleanOld': { 'zh-CN': '清理旧版本', en: 'Clean old versions' },
  'diag.btn.tail': { 'zh-CN': '查看日志尾部', en: 'View log tail' },
  'diag.btn.openLog': { 'zh-CN': '打开日志目录', en: 'Open log directory' },
  'diag.btn.switch': { 'zh-CN': '切换到 {version}', en: 'Switch to {version}' },
  'diag.btn.current': { 'zh-CN': '当前版本', en: 'Current version' },
  'diag.btn.restorePinned': { 'zh-CN': '恢复钉版', en: 'Restore pinned version' },
  'diag.btn.restartNow': { 'zh-CN': '立即重启', en: 'Restart now' },
  'diag.badge.pinned': { 'zh-CN': '钉版', en: 'pinned' },
  'diag.badge.seed': { 'zh-CN': '种子', en: 'seed' },
  'diag.badge.current': { 'zh-CN': '当前', en: 'current' },
  'diag.badge.override': { 'zh-CN': '覆盖', en: 'override' },
  'diag.status.noVersions': { 'zh-CN': '暂无已缓存版本', en: 'No cached versions' },
  'diag.status.noOld': { 'zh-CN': '没有可清理的旧版本', en: 'No old versions to clean' },
  'diag.status.overrideHint': { 'zh-CN': '切换已写入，重启后生效。', en: 'Override written; takes effect after restart.' },
  'diag.status.clearHint': { 'zh-CN': '已恢复钉版，重启后生效。', en: 'Pinned version restored; takes effect after restart.' },
  'diag.status.exporting': { 'zh-CN': '正在打包诊断包…', en: 'Packaging diagnostics…' },
  'diag.status.exported': { 'zh-CN': '诊断包已导出：{path}', en: 'Diagnostics exported: {path}' },
  'diag.status.cleaning': { 'zh-CN': '正在清理…', en: 'Cleaning…' },
  'diag.status.cleaned': { 'zh-CN': '已清理：{versions}', en: 'Cleaned: {versions}' },
  'diag.status.logEmpty': { 'zh-CN': '日志文件不存在或为空。', en: 'Log file missing or empty.' },
  'diag.status.notAllowed': { 'zh-CN': '不允许切换到该版本（仅支持钉版 / 种子 / 已缓存版本）。', en: 'Switching to this version is not allowed (pinned / seed / cached only).' },
}

let cachedSystemLocale: string | null = null

/**
 * Resolve the effective UI locale. `app.getLocale()` is only available in the
 * Electron main process; the call is guarded so unit tests (plain Node) and
 * early-boot paths fall back to English without crashing.
 */
export function systemLocale(): string {
  if (cachedSystemLocale !== null) return cachedSystemLocale
  try {
    cachedSystemLocale = app.getLocale()
  } catch {
    cachedSystemLocale = 'en'
  }
  return cachedSystemLocale
}

export function localeOf(locale: string | undefined): Locale {
  const value = (locale ?? systemLocale()).toLowerCase()
  return value.startsWith('zh') ? 'zh-CN' : 'en'
}

/** Look up a message; missing keys fall back to the key itself. */
export function t(key: string, locale?: string): string {
  const entry = messages[key]
  if (!entry) return key
  return entry[localeOf(locale)]
}

/** Replace `{name}` placeholders in a (localized) template with values. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value == null ? match : String(value)
  })
}
