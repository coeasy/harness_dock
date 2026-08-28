import { BrowserWindow } from 'electron'
import { t } from './i18n.ts'

/**
 * Small "closing" window shown while the dsh process tree is being stopped.
 * Quitting can take a few seconds (the shutdown ladder + watchdog), so without
 * feedback the app looks frozen. The window is frameless and non-interactive;
 * it is destroyed automatically when the app exits.
 */

let closingWindow: BrowserWindow | undefined

function renderClosingHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;user-select:none;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  background:radial-gradient(120% 90% at 50% 0%, #142233 0%, #0b1120 55%, #080d18 100%)}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;animation:fadeIn .25s ease}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.spinner{width:22px;height:22px;border-radius:50%;border:2px solid rgba(110,231,216,.16);border-top-color:#2dd4bf;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.title{color:#eef2fa;font-size:14px;font-weight:600;letter-spacing:.03em}
.body{color:#8b9bb8;font-size:12px;text-align:center;max-width:260px;letter-spacing:.01em}
</style></head><body>
<div class="wrap">
  <div class="spinner"></div>
  <div class="title">${t('closing.title')}</div>
  <div class="body">${t('closing.body')}</div>
</div>
</body></html>`
}

export function showClosingWindow(): void {
  if (closingWindow && !closingWindow.isDestroyed()) return
  closingWindow = new BrowserWindow({
    width: 320,
    height: 140,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0b1120',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  closingWindow.center()
  void closingWindow
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderClosingHtml())}`)
    .catch(() => undefined)
  closingWindow.once('ready-to-show', () => closingWindow?.show())
  closingWindow.on('closed', () => {
    closingWindow = undefined
  })
}

/**
 * Shows the closing window shortly after shutdown starts, so a fast quit does
 * not flash it; a slow shutdown (ladder up to ~15s) gets visible feedback.
 */
export function scheduleClosingHint(delayMs = 800): void {
  const timer = setTimeout(showClosingWindow, delayMs)
  timer.unref?.()
}
