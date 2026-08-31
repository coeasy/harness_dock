import { app, BrowserWindow, clipboard, ipcMain, nativeImage } from 'electron'
import { t } from './i18n.ts'
import { openLogDir } from './boot-log.ts'
import { appIconPath, splashPreloadPath } from './paths.ts'

let splashWindow: BrowserWindow | undefined
let splashIpcRegistered = false
let latestSplashError = ''
let splashRetryAction: (() => void) | undefined

function splashIconDataUrl(): string | undefined {
  try {
    const image = nativeImage.createFromPath(appIconPath())
    if (image.isEmpty()) return undefined
    return image.resize({ width: 72, height: 72, quality: 'best' }).toDataURL()
  } catch {
    return undefined
  }
}

// ---------- splash screen shown while dsh boots ----------
// The template stays inline and loads via a `data:` URL (no pack config change).
// It gains a download progress bar and an error state with actionable buttons
// (retry / open log / copy error) wired through the `dshSplash` preload bridge.
function renderSplashHtml(iconDataUrl?: string): string {
  const iconMarkup = iconDataUrl
    ? `<img class="logo-image" src="${iconDataUrl}" alt="HarnessDock" draggable="false">`
    : '<div class="logo-fallback"></div>'
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;user-select:none;-webkit-app-region:drag;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  background:radial-gradient(120% 90% at 50% 0%, #142233 0%, #0b1120 55%, #080d18 100%)}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px 28px;animation:fadeIn .3s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.logo-shell{width:72px;height:72px;min-width:72px;min-height:72px;flex:0 0 72px;display:flex;align-items:center;justify-content:center}
.logo-image{display:block;width:72px;height:72px;min-width:72px;min-height:72px;object-fit:contain;flex:0 0 72px;-webkit-user-drag:none;filter:drop-shadow(0 10px 20px rgba(0,0,0,.35))}
.logo-fallback{width:72px;height:72px;min-width:72px;min-height:72px;flex:0 0 72px;border-radius:20px;position:relative;
  background:radial-gradient(circle at 35% 28%, #6ee7d8 0%, #14b8a6 55%, #0d9488 100%);
  box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 46px rgba(20,184,166,.28),inset 0 0 0 1px rgba(255,255,255,.18)}
.logo-fallback::after{content:"";position:absolute;inset:16px;border-radius:50%;
  background:radial-gradient(circle at 40% 35%, #d9fff6 0%, #2dd4bf 62%, #0f766e 100%);
  box-shadow:0 0 14px rgba(126,231,214,.6)}
.title{color:#eef2fa;font-size:19px;font-weight:700;letter-spacing:.05em;flex:0 0 auto}
.sub{color:#8b9bb8;font-size:12px;letter-spacing:.02em;margin-top:-8px;flex:0 0 auto}
.spinner{width:20px;height:20px;min-width:20px;min-height:20px;flex:0 0 20px;border-radius:50%;border:2px solid rgba(110,231,216,.16);border-top-color:#2dd4bf;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes dsh-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(420%)}}
.status{color:#8b9bb8;font-size:12px;min-height:16px;text-align:center;max-width:330px;white-space:pre-line;letter-spacing:.01em;flex:0 0 auto}
.hint{color:#5d6f8d;font-size:11px;max-width:330px;text-align:center;line-height:1.55;white-space:pre-line;flex:0 0 auto}
.progress-wrap{width:240px;height:6px;min-height:6px;flex:0 0 6px;border-radius:99px;background:rgba(148,178,214,.14);overflow:hidden;position:relative;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.progress-bar{height:100%;width:20%;border-radius:99px;background:linear-gradient(90deg,#0d9488,#2dd4bf,#6ee7d8);box-shadow:0 0 10px rgba(45,212,191,.45);transition:width .25s ease}
.progress-wrap.indeterminate .progress-bar{width:25%;animation:dsh-indeterminate 1.2s ease-in-out infinite}
.progress-wrap.done .progress-bar{width:100% !important;transition:width .3s ease}
.error{display:none;flex-direction:column;align-items:center;gap:11px;width:100%;max-width:340px}
.error .err-title{color:#ff8f9a;font-size:14px;font-weight:600;letter-spacing:.02em}
.error .err-msg{color:#c7d2e3;font-size:12px;white-space:pre-wrap;word-break:break-all;max-height:92px;overflow:auto;background:rgba(148,178,214,.08);border:1px solid rgba(148,178,214,.16);border-radius:10px;padding:9px;width:100%;font-family:ui-monospace,Consolas,monospace}
.error .err-actions{display:flex;gap:8px;margin-top:2px}
button{-webkit-app-region:no-drag;background:rgba(148,178,214,.12);color:#c7d2e3;border:1px solid rgba(148,178,214,.2);border-radius:9px;padding:7px 13px;font-size:12px;cursor:pointer;font-family:inherit;transition:background-color .15s ease}
button:hover{background:rgba(148,178,214,.2)}
button.primary{background:#14b8a6;color:#06201b;border-color:#14b8a6;font-weight:600}
button.primary:hover{background:#2dd4bf}
</style></head><body>
<div class="wrap">
  <div class="logo-shell">${iconMarkup}</div>
  <div class="title">HarnessDock</div>
  <div class="sub">DeepSeek Harness · dock</div>
  <div class="spinner" id="splash-spinner"></div>
  <div class="status" id="splash-status">${t('splash.starting')}</div>
  <div class="hint" id="splash-hint"></div>
  <div class="progress-wrap" id="splash-progress"><div class="progress-bar" id="splash-progress-bar"></div></div>
  <div class="error" id="splash-error">
    <div class="err-title" id="splash-error-title"></div>
    <div class="err-msg" id="splash-error-msg"></div>
    <div class="err-actions">
      <button class="primary" id="splash-retry">${t('splash.error.retry')}</button>
      <button id="splash-openlog">${t('splash.error.openLog')}</button>
      <button id="splash-copy">${t('splash.error.copyError')}</button>
    </div>
  </div>
</div>
<script>
(function () {
  function on(id, fn) {
    var el = document.getElementById(id)
    if (el) el.addEventListener('click', fn)
  }
  on('splash-retry', function () { if (window.dshSplash) window.dshSplash.retry() })
  on('splash-openlog', function () { if (window.dshSplash) window.dshSplash.openLog() })
  on('splash-copy', function () { if (window.dshSplash) window.dshSplash.copyError() })
})()
</script>
</body></html>`
}

export async function createSplash(): Promise<void> {
  if (splashWindow) return
  const iconPath = appIconPath()
  splashWindow = new BrowserWindow({
    width: 400,
    height: 430,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0b1120',
    icon: iconPath,
    webPreferences: {
      preload: splashPreloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  splashWindow.center()
  await splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderSplashHtml(splashIconDataUrl()))}`)
  splashWindow.once('ready-to-show', () => splashWindow?.show())
}

export function updateSplash(text: string): void {
  runInSplash(`(function(){var el=document.getElementById('splash-status');if(el){el.textContent=${JSON.stringify(text)};}})()`)
}

/**
 * Drive the boot progress bar.
 *
 *  - a real number (0-100): determinate — the bar fills to that percentage;
 *  - `null` / `undefined`: "virtual loading" — an indeterminate sliding bar that
 *    keeps moving while the phase has no measurable progress (resolving
 *    metadata, waiting for dsh ready, ...), so the splash never looks frozen.
 */
export function showSplashProgress(percent: number | null | undefined): void {
  const pct =
    typeof percent === 'number' ? Math.max(0, Math.min(100, Math.round(percent))) : null
  const script =
    pct == null
      ? `(function(){var w=document.getElementById('splash-progress');if(w){w.classList.remove('done');w.classList.add('indeterminate')}})()`
      : `(function(){var w=document.getElementById('splash-progress');var b=document.getElementById('splash-progress-bar');` +
        `if(w){w.classList.remove('indeterminate');w.classList.remove('done')}if(b){b.style.width=${pct}+'%'}})()`
  runInSplash(script)
}

/** Mark the boot progress complete (bar fills to 100%). */
export function showSplashDone(): void {
  runInSplash(
    `(function(){var w=document.getElementById('splash-progress');if(w){w.classList.remove('indeterminate');w.classList.add('done')}})()`,
  )
}

export interface SplashErrorOptions {
  /** Error summary shown in the splash error box. */
  message: string
  /** Invoked when the user clicks 重试 (defaults to relaunching the app). */
  onRetry?: () => void
}

/** Switch the splash into the error state (spinner/progress hidden). */
export function showSplashError({ message, onRetry }: SplashErrorOptions): void {
  latestSplashError = message
  splashRetryAction = onRetry
  runInSplash(
    `(function(){var d=document.getElementById('splash-error');if(!d)return;` +
      `d.style.display='flex';` +
      `document.getElementById('splash-error-title').textContent=${JSON.stringify(t('splash.error.title'))};` +
      `document.getElementById('splash-error-msg').textContent=${JSON.stringify(message)};` +
      `var sp=document.getElementById('splash-spinner');if(sp)sp.style.display='none';` +
      `var pr=document.getElementById('splash-progress');if(pr)pr.style.display='none';` +
      `var st=document.getElementById('splash-status');if(st)st.style.display='none';` +
      `var hi=document.getElementById('splash-hint');if(hi)hi.style.display='none';})()`,
  )
}

const FIRST_LAUNCH_HINTS = [
  t('splash.hint.network'),
  t('splash.hint.stuck'),
  t('splash.hint.resume'),
].join('\n')

export function showFirstLaunchHints(): void {
  runInSplash(`(function(){var el=document.getElementById('splash-hint');if(el){el.textContent=${JSON.stringify(FIRST_LAUNCH_HINTS)};}})()`)
}

export function closeSplash(): void {
  const w = splashWindow
  splashWindow = undefined
  if (w && !w.isDestroyed()) {
    w.removeAllListeners('ready-to-show')
    try {
      w.webContents
        .executeJavaScript(
          `(function(){document.body.style.transition='opacity .18s ease';document.body.style.opacity='0'})()`,
        )
        .catch(() => undefined)
    } catch {
      // ignore
    }
    const timer = setTimeout(() => {
      if (!w.isDestroyed()) w.close()
    }, 180)
    timer.unref?.()
  }
}

function runInSplash(script: string): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  splashWindow.webContents.executeJavaScript(script).catch(() => undefined)
}

export function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Register splash IPC once. The splash page is a sandboxed data: URL, so its
 * buttons call the preload bridge (`dshSplash`) which forwards via ipcRenderer:
 *
 *   splash:retry      -> onRetry action (default: app.relaunch(); app.exit(0))
 *   splash:open-log   -> openLogDir()
 *   splash:copy-error -> clipboard.writeText(latest error)
 */
export function registerSplashIpc(): void {
  if (splashIpcRegistered) return
  splashIpcRegistered = true

  ipcMain.on('splash:retry', () => {
    const action = splashRetryAction
    splashRetryAction = undefined
    if (action) {
      action()
      return
    }
    try {
      app.relaunch()
    } catch {
      // relaunch unavailable (dev / bare electron); fall through to exit
    }
    app.exit(0)
  })

  ipcMain.on('splash:open-log', () => {
    void openLogDir()
  })

  ipcMain.on('splash:copy-error', () => {
    if (!latestSplashError) return
    try {
      clipboard.writeText(latestSplashError)
    } catch {
      return
    }
    const copied = JSON.stringify(t('splash.error.copied'))
    runInSplash(`(function(){var c=document.getElementById('splash-copy');if(c){c.textContent=${copied};}})()`)
  })
}
