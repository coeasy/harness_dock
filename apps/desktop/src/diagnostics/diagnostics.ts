import { BrowserWindow } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { t } from '../i18n.ts'
import { diagnosticsPreloadPath } from '../paths.ts'

/**
 * Diagnostics panel (E1) + runtime version management (E2), merged into a
 * single window with two tabs (diagnostics / runtime versions) plus a log tab
 * to avoid multiple helper windows. The panel is an inline dark-themed HTML
 * page loaded from a data: URL in a sandboxed + contextIsolated window; it
 * talks to the main process through `dshDiagnostics` (see
 * diagnostics-preload.ts / diagnostics-ipc.ts).
 *
 * Pure helpers (tailLines / computeKeepSet / selectOldVersions / cacheSizeBytes)
 * are exported so the deletion and truncation logic is unit-testable.
 */

export type DiagnosticsSection = 'info' | 'versions' | 'log'

export interface DiagnosticsInfo {
  dshVersion: string
  pinnedVersion: string
  overrideVersion: string | null
  mode: string
  bundledAvailable: boolean
  cacheDir: string
  cacheSizeBytes: number
  seedVersion: string | null
  cachedVersions: string[]
  dshPid: number | undefined
  platform: NodeJS.Platform
  electron: string
  generatedAt: string
}

// ---------- pure helpers ----------

/** Keep the last `maxLines` lines of a log text (CRLF-normalized). */
export function tailLines(text: string, maxLines = 200): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  return lines.slice(-maxLines).join('\n')
}

/**
 * The set of cached runtime versions that must never be deleted: the pinned
 * origin version, the bundled seed version, the currently-running version, and
 * any active override.
 */
export function computeKeepSet(input: {
  pinned?: string
  seed?: string | null
  current?: string
  override?: string | null
}): Set<string> {
  const keep = new Set<string>()
  for (const v of [input.pinned, input.seed, input.current, input.override]) {
    if (v) keep.add(v)
  }
  return keep
}

/** Cached versions NOT in the keep set — these are safe to delete. */
export function selectOldVersions(cached: string[], keep: Set<string>): string[] {
  return cached.filter((v) => !keep.has(v))
}

/** Recursive total size of a directory tree in bytes (missing dir -> 0). */
export async function cacheSizeBytes(dir: string): Promise<number> {
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // unreadable file — count as 0
        }
      }
    }
  }
  return total
}

// ---------- window ----------

let diagWindow: BrowserWindow | undefined

export function openDiagnosticsWindow(section: DiagnosticsSection = 'info'): void {
  if (diagWindow && !diagWindow.isDestroyed()) {
    if (!diagWindow.isVisible()) diagWindow.show()
    diagWindow.focus()
    diagWindow.webContents
      .executeJavaScript(
        `(function(){if(window.__dshDiagnosticsShow)window.__dshDiagnosticsShow(${JSON.stringify(section)})})()`,
      )
      .catch(() => undefined)
    return
  }
  diagWindow = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 620,
    minHeight: 480,
    title: 'HarnessDock',
    backgroundColor: '#0b1120',
    show: false,
    webPreferences: {
      preload: diagnosticsPreloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  diagWindow.on('closed', () => {
    diagWindow = undefined
  })
  const html = renderDiagnosticsHtml(section)
  void diagWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  diagWindow.once('ready-to-show', () => diagWindow?.show())
}

interface DiagRuntimeLabels {
  fieldCurrent: string
  fieldPinned: string
  fieldOverride: string
  fieldMode: string
  fieldBundled: string
  fieldSeed: string
  fieldCacheDir: string
  fieldCacheSize: string
  fieldPid: string
  badgePinned: string
  badgeSeed: string
  badgeCurrent: string
  badgeOverride: string
  btnSwitch: string
  btnCurrent: string
  noVersions: string
  noOld: string
  overrideHint: string
  clearHint: string
  exporting: string
  exported: string
  cleaning: string
  cleaned: string
  logEmpty: string
  notAllowed: string
  initialSection: DiagnosticsSection
}

function diagRuntimeLabels(section: DiagnosticsSection): DiagRuntimeLabels {
  return {
    fieldCurrent: t('diag.field.current'),
    fieldPinned: t('diag.field.pinned'),
    fieldOverride: t('diag.field.override'),
    fieldMode: t('diag.field.mode'),
    fieldBundled: t('diag.field.bundled'),
    fieldSeed: t('diag.field.seed'),
    fieldCacheDir: t('diag.field.cacheDir'),
    fieldCacheSize: t('diag.field.cacheSize'),
    fieldPid: t('diag.field.pid'),
    badgePinned: t('diag.badge.pinned'),
    badgeSeed: t('diag.badge.seed'),
    badgeCurrent: t('diag.badge.current'),
    badgeOverride: t('diag.badge.override'),
    btnSwitch: t('diag.btn.switch'),
    btnCurrent: t('diag.btn.current'),
    noVersions: t('diag.status.noVersions'),
    noOld: t('diag.status.noOld'),
    overrideHint: t('diag.status.overrideHint'),
    clearHint: t('diag.status.clearHint'),
    exporting: t('diag.status.exporting'),
    exported: t('diag.status.exported'),
    cleaning: t('diag.status.cleaning'),
    cleaned: t('diag.status.cleaned'),
    logEmpty: t('diag.status.logEmpty'),
    notAllowed: t('diag.status.notAllowed'),
    initialSection: section,
  }
}

function renderDiagnosticsHtml(section: DiagnosticsSection): string {
  const labelsJson = JSON.stringify(diagRuntimeLabels(section))
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;
  background:radial-gradient(120% 90% at 50% 0%, #142233 0%, #0b1120 55%, #080d18 100%);
  color:#c7d2e3}
.app{height:100%;display:flex;flex-direction:column;animation:fadeIn .25s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
header{padding:14px 18px 10px;display:flex;align-items:baseline;gap:9px;border-bottom:1px solid rgba(148,178,214,.14);-webkit-app-region:drag}
header .brand{color:#eef2fa;font-size:15px;font-weight:700;letter-spacing:.04em}
header .sub{color:#7f8fa9;font-size:11px;letter-spacing:.02em}
.tabs{display:flex;gap:4px;padding:10px 14px 0;border-bottom:1px solid rgba(148,178,214,.14)}
.tab{background:transparent;border:1px solid transparent;border-bottom:none;color:#7f8fa9;padding:7px 15px;font-size:12.5px;cursor:pointer;border-radius:9px 9px 0 0;transition:color .15s ease,background .15s ease}
.tab:hover{color:#c7d2e3}
.tab.active{background:rgba(148,178,214,.08);color:#6ee7d8;border-color:rgba(148,178,214,.14);font-weight:600}
main{flex:1;overflow:auto;padding:16px 18px}
.pane{display:flex;flex-direction:column;gap:12px;height:100%}
.hidden{display:none!important}
.card{background:rgba(148,178,214,.06);border:1px solid rgba(148,178,214,.14);border-radius:12px;padding:14px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.grid-item{display:flex;flex-direction:column;gap:2px;padding:7px 9px;background:rgba(8,13,24,.6);border:1px solid rgba(148,178,214,.1);border-radius:9px}
.grid-item .k{color:#7f8fa9;font-size:11px;letter-spacing:.02em}
.grid-item .v{color:#eef2fa;font-size:12.5px;word-break:break-all;font-family:ui-monospace,Consolas,monospace}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.result{color:#6ee7d8;font-size:12px;min-height:16px;word-break:break-all;line-height:1.5}
.btn{background:rgba(148,178,214,.12);color:#c7d2e3;border:1px solid rgba(148,178,214,.2);border-radius:9px;padding:6px 13px;font-size:12px;cursor:pointer;transition:background-color .15s ease}
.btn:hover{background:rgba(148,178,214,.2)}
.btn.primary{background:#14b8a6;color:#06201b;border-color:#14b8a6;font-weight:600}
.btn.primary:hover{background:#2dd4bf}
.btn:disabled{opacity:.5;cursor:default}
.btn.cur{background:transparent;border-color:transparent;color:#5d6f8d;cursor:default}
.row-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.row-head .card-title{color:#7f8fa9;font-size:12px}
.vlist{list-style:none;display:flex;flex-direction:column;gap:6px}
.vlist li.vrow{display:flex;align-items:center;gap:10px;padding:8px 11px;background:rgba(8,13,24,.6);border:1px solid rgba(148,178,214,.1);border-radius:9px}
.vlist .vname{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#eef2fa;flex:0 0 auto}
.vlist .vbadges{display:flex;gap:5px;flex:1 1 auto;flex-wrap:wrap}
.vbadge{font-size:10px;color:#6ee7d8;border:1px solid rgba(148,178,214,.2);border-radius:5px;padding:1px 7px;background:rgba(148,178,214,.08)}
.vlist .vaction{flex:0 0 auto}
.vlist .empty{color:#5d6f8d;padding:8px;font-size:12px}
.restart-bar{display:flex;align-items:center;gap:10px;background:rgba(20,184,166,.08);border:1px solid rgba(45,212,191,.35);border-radius:11px;padding:10px 13px;font-size:12px;color:#c7d2e3;box-shadow:0 0 16px rgba(20,184,166,.12)}
.log{flex:1;background:rgba(8,13,24,.7);border:1px solid rgba(148,178,214,.12);border-radius:11px;padding:11px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#9db0cb;white-space:pre-wrap;word-break:break-all;line-height:1.5}
</style></head><body>
<div class="app">
<header>
  <span class="brand">HarnessDock</span><span class="sub">dsh client</span>
</header>
<nav class="tabs">
  <button class="tab active" data-tab="info">${t('diag.tab.info')}</button>
  <button class="tab" data-tab="versions">${t('diag.tab.versions')}</button>
  <button class="tab" data-tab="log">${t('diag.tab.log')}</button>
</nav>
<main>
  <section id="pane-info" class="pane">
    <div class="card"><div class="grid" id="info-grid"></div></div>
    <div class="actions">
      <button id="btn-clean" class="btn">${t('diag.btn.cleanOld')}</button>
      <button id="btn-export" class="btn primary">${t('diag.btn.export')}</button>
    </div>
    <div id="info-result" class="result"></div>
  </section>
  <section id="pane-versions" class="pane hidden">
    <div class="card">
      <div class="row-head">
        <span class="card-title">${t('diag.tab.versions')}</span>
        <button id="btn-restore" class="btn">${t('diag.btn.restorePinned')}</button>
      </div>
      <ul id="version-list" class="vlist"></ul>
    </div>
    <div id="versions-result" class="result"></div>
    <div id="restart-bar" class="restart-bar hidden">
      <span id="restart-hint"></span>
      <button id="btn-restart" class="btn primary">${t('diag.btn.restartNow')}</button>
    </div>
  </section>
  <section id="pane-log" class="pane hidden">
    <div class="actions">
      <button id="btn-tail" class="btn">${t('diag.btn.tail')}</button>
      <button id="btn-open-log" class="btn">${t('diag.btn.openLog')}</button>
    </div>
    <pre id="log-tail" class="log">—</pre>
  </section>
</main>
</div>
<script>
window.__D = ${labelsJson};
(function () {
  'use strict'
  var L = window.__D || {}
  var api = window.dshDiagnostics
  function $(id) { return document.getElementById(id) }
  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }
  function fmtBytes(n) {
    if (n == null) return '-'
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
    return String(n) + ' B'
  }
  function fill(id, text) { var e = $(id); if (e) e.textContent = text }

  function showTab(name) {
    var panes = ['info', 'versions', 'log']
    for (var i = 0; i < panes.length; i++) {
      var p = $('pane-' + panes[i])
      if (p) p.classList.toggle('hidden', panes[i] !== name)
    }
    var tabs = document.querySelectorAll('.tab')
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].classList.toggle('active', tabs[j].getAttribute('data-tab') === name)
    }
  }
  window.__dshDiagnosticsShow = showTab

  function renderInfo(info) {
    var grid = $('info-grid')
    if (!grid) return
    grid.textContent = ''
    var rows = [
      [L.fieldCurrent, info.dshVersion || '-'],
      [L.fieldPinned, info.pinnedVersion || '-'],
      [L.fieldOverride, info.overrideVersion || '-'],
      [L.fieldMode, info.mode || '-'],
      [L.fieldBundled, info.bundledAvailable ? 'yes' : 'no'],
      [L.fieldSeed, info.seedVersion || '-'],
      [L.fieldCacheDir, info.cacheDir || '-'],
      [L.fieldCacheSize, fmtBytes(info.cacheSizeBytes)],
      [L.fieldPid, info.dshPid ? String(info.dshPid) : '-'],
    ]
    for (var i = 0; i < rows.length; i++) {
      var item = el('div', 'grid-item')
      item.appendChild(el('div', 'k', rows[i][0]))
      item.appendChild(el('div', 'v', rows[i][1]))
      grid.appendChild(item)
    }
  }

  function renderVersions(info) {
    var list = $('version-list')
    if (!list) return
    list.textContent = ''
    var items = []
    var seen = {}
    function push(v, kind) {
      if (!v || seen[v]) return
      seen[v] = true
      items.push({ v: v, kind: kind })
    }
    push(info.pinnedVersion, 'pinned')
    push(info.seedVersion, 'seed')
    var cached = info.cachedVersions || []
    for (var i = 0; i < cached.length; i++) push(cached[i], 'cached')

    if (items.length === 0) {
      list.appendChild(el('li', 'empty', L.noVersions))
      return
    }
    for (var j = 0; j < items.length; j++) {
      var item = items[j]
      var li = el('li', 'vrow')
      var badges = []
      if (info.overrideVersion && item.v === info.overrideVersion) badges.push(L.badgeOverride)
      if (item.kind === 'pinned') badges.push(L.badgePinned)
      if (item.kind === 'seed') badges.push(L.badgeSeed)
      if (info.dshVersion && item.v === info.dshVersion) badges.push(L.badgeCurrent)
      var badgeWrap = el('span', 'vbadges')
      for (var b = 0; b < badges.length; b++) badgeWrap.appendChild(el('span', 'vbadge', badges[b]))
      var action = el('span', 'vaction')
      if (info.dshVersion && item.v === info.dshVersion) {
        action.appendChild(el('button', 'btn cur', '✓ ' + L.btnCurrent))
      } else {
        var btn = el('button', 'btn', String(L.btnSwitch).replace('{version}', item.v))
        ;(function (version, button) {
          button.addEventListener('click', function () { onSwitch(version, button) })
        })(item.v, btn)
        action.appendChild(btn)
      }
      li.appendChild(el('span', 'vname', item.v))
      li.appendChild(badgeWrap)
      li.appendChild(action)
      list.appendChild(li)
    }
  }

  function showRestart(hint) {
    fill('restart-hint', hint)
    var bar = $('restart-bar')
    if (bar) bar.classList.remove('hidden')
  }

  function onSwitch(version, btn) {
    btn.disabled = true
    api.switchVersion(version).then(function (res) {
      btn.disabled = false
      if (res && res.ok) {
        fill('versions-result', '')
        showRestart(L.overrideHint)
        refresh()
      } else {
        fill('versions-result', res && res.reason === 'not-allowed' ? L.notAllowed : ((res && res.error) || 'error'))
      }
    }).catch(function () { btn.disabled = false; fill('versions-result', 'error') })
  }

  function refresh() {
    api.getInfo().then(function (info) {
      if (!info) return
      renderInfo(info)
      renderVersions(info)
    }).catch(function () { fill('info-result', 'error') })
  }

  function bind(id, fn) {
    var e = $(id)
    if (e) e.addEventListener('click', fn)
  }

  bind('btn-clean', function (ev) {
    var btn = ev.currentTarget
    btn.disabled = true
    fill('info-result', L.cleaning)
    api.cleanOldVersions().then(function (res) {
      btn.disabled = false
      if (res && res.ok) {
        fill('info-result', res.deleted && res.deleted.length
          ? String(L.cleaned).replace('{versions}', res.deleted.join(', '))
          : L.noOld)
        refresh()
      } else {
        fill('info-result', (res && res.error) || 'error')
      }
    }).catch(function () { btn.disabled = false; fill('info-result', 'error') })
  })

  bind('btn-export', function (ev) {
    var btn = ev.currentTarget
    btn.disabled = true
    fill('info-result', L.exporting)
    api.exportDiagnostics().then(function (res) {
      btn.disabled = false
      if (res && res.ok) {
        fill('info-result', String(L.exported).replace('{path}', res.zipPath || ''))
      } else {
        fill('info-result', (res && res.error) || 'error')
      }
    }).catch(function () { btn.disabled = false; fill('info-result', 'error') })
  })

  bind('btn-tail', function () {
    api.tailLog().then(function (res) {
      var pre = $('log-tail')
      if (!pre) return
      if (res && res.ok && res.log) pre.textContent = res.log
      else if (res && res.ok) pre.textContent = L.logEmpty
      else pre.textContent = (res && res.error) || 'error'
    }).catch(function () { var pre = $('log-tail'); if (pre) pre.textContent = 'error' })
  })

  bind('btn-open-log', function () { api.openLog() })
  bind('btn-restart', function () { api.restart() })
  bind('btn-restore', function (ev) {
    var btn = ev.currentTarget
    btn.disabled = true
    api.clearOverride().then(function (res) {
      btn.disabled = false
      if (res && res.ok) {
        fill('versions-result', '')
        showRestart(L.clearHint)
        refresh()
      } else {
        fill('versions-result', (res && res.error) || 'error')
      }
    }).catch(function () { btn.disabled = false; fill('versions-result', 'error') })
  })

  var tabs = document.querySelectorAll('.tab')
  for (var t = 0; t < tabs.length; t++) {
    ;(function (tb) {
      tb.addEventListener('click', function () { showTab(tb.getAttribute('data-tab')) })
    })(tabs[t])
  }

  refresh()
  showTab(L.initialSection || 'info')
})()
</script>
</body></html>`
}
