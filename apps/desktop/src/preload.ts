/**
 * Preload: injects a custom brand caption bar into the official dsh web UI.
 *
 * The BrowserWindow is frameless; on Windows/Linux this script draws its own
 * minimize / maximize-restore / close buttons (wired to the main process over
 * IPC) so the window controls always match the caption theme. On macOS the
 * native traffic lights are used instead (titleBarStyle hiddenInset) and the
 * custom buttons are hidden.
 *
 * The caption is theme-aware: it follows the embedded SPA's theme signal
 * (data-theme / class / color-scheme on <html>, falling back to
 * prefers-color-scheme) and flips its palette between dark and light.
 *
 * Set DSH_CUSTOM_TITLEBAR=0 to disable the brand bar and keep the stock look.
 */
import { contextBridge, ipcRenderer } from 'electron'

declare global {
  interface Window {
    /** Bridge exposed below; the caption bar buttons call through it. */
    dshWindowControls?: {
      minimize(): void
      toggleMaximize(): void
      close(): void
    }
  }
}

const ENABLED = process.env.DSH_CUSTOM_TITLEBAR !== '0'
const IS_MAC = process.platform === 'darwin'

const CAPTION_HEIGHT = 44

const TITLEBAR_HTML = `
<style id="dsh-caption-style">
  html, body { margin: 0 !important; }
  body { padding-top: ${CAPTION_HEIGHT}px !important; box-sizing: border-box; }
  #dsh-caption {
    position: fixed; top: 0; left: 0; right: 0; height: ${CAPTION_HEIGHT}px; z-index: 2147483647;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0; margin: 0;
    --cap-bg: linear-gradient(180deg, rgba(22,31,49,0.96) 0%, rgba(12,18,32,0.98) 100%);
    --cap-border: rgba(152,182,220,0.14);
    --cap-title: #e9eef7;
    --cap-sub: #7f8fa9;
    --cap-btn-fg: rgba(208,220,238,0.78);
    --cap-btn-hover: rgba(152,182,220,0.14);
    --cap-btn-active: rgba(152,182,220,0.22);
    --cap-close-hover: rgba(226,32,50,0.9);
    --cap-close-fg: #fff;
    background: var(--cap-bg);
    border-bottom: 1px solid var(--cap-border);
    box-shadow: 0 1px 0 rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    user-select: none; -webkit-user-select: none;
  }
  #dsh-caption .cap-left {
    display: flex; align-items: center; gap: 10px; padding-left: 16px; min-width: 0;
    -webkit-app-region: drag;
  }
  #dsh-caption .cap-spacer {
    flex: 1 1 auto; height: 100%; min-width: 8px;
    -webkit-app-region: drag;
  }
  #dsh-caption[data-theme="light"] {
    --cap-bg: linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(240,244,250,0.98) 100%);
    --cap-border: rgba(15,23,42,0.10);
    --cap-title: #1c2437;
    --cap-sub: #6b7890;
    --cap-btn-fg: rgba(40,52,76,0.72);
    --cap-btn-hover: rgba(15,23,42,0.08);
    --cap-btn-active: rgba(15,23,42,0.12);
    --cap-close-hover: rgba(226,32,50,0.9);
    --cap-close-fg: #fff;
  }
  #dsh-caption .dsh-logo {
    width: 18px; height: 18px; flex: 0 0 18px; border-radius: 5.5px;
    background: radial-gradient(circle at 35% 30%, #6ee7d8 0%, #14b8a6 58%, #0d9488 100%);
    box-shadow: 0 0 9px rgba(20,184,166,0.4), inset 0 0 0 1px rgba(255,255,255,0.18);
  }
  #dsh-caption .dsh-logo::after {
    content: ""; display: block; margin: 4.5px; height: 9px; width: 9px;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 35%, #d9fff6 0%, #2dd4bf 65%, #0f766e 100%);
    box-shadow: 0 0 5px rgba(126,231,214,0.6);
  }
  #dsh-caption .dsh-title {
    color: var(--cap-title); font-size: 12.5px; font-weight: 600;
    letter-spacing: 0.03em; white-space: nowrap;
  }
  #dsh-caption .dsh-sub {
    color: var(--cap-sub); font-size: 11px; font-weight: 400; margin-left: 2px;
    letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #dsh-caption .cap-controls {
    display: flex !important; align-items: center; height: 100%;
    padding-right: 8px; gap: 2px; -webkit-app-region: no-drag;
  }
  #dsh-caption .cap-btn {
    width: 42px; height: 26px; border: none; margin: 0; padding: 0; cursor: default;
    display: inline-flex !important; align-items: center; justify-content: center;
    border-radius: 7px;
    background: transparent !important; color: var(--cap-btn-fg);
    transition: background-color .18s ease, color .18s ease, transform .08s ease, box-shadow .18s ease;
  }
  #dsh-caption .cap-btn:hover { background: var(--cap-btn-hover) !important; color: var(--cap-title); }
  #dsh-caption .cap-btn:active { background: var(--cap-btn-active) !important; transform: scale(0.92); }
  #dsh-caption .cap-btn.cap-close:hover { background: var(--cap-close-hover) !important; color: var(--cap-close-fg) !important; box-shadow: 0 0 8px rgba(226,32,50,0.4); }
  #dsh-caption .cap-btn svg { width: 11px; height: 11px; display: block; }
  @media (max-width: 480px) { #dsh-caption .dsh-sub { display: none; } }
</style>
<div id="dsh-caption" data-theme="dark" style="position:fixed;top:0;left:0;right:0;height:44px;z-index:2147483647;margin:0">
  <div class="cap-left" style="display:flex;align-items:center;gap:10px;padding-left:16px;min-width:0">
    <span class="dsh-logo"></span>
    <span class="dsh-title">HarnessDock</span>
    <span class="dsh-sub">dsh client</span>
  </div>
  <div class="cap-spacer" style="flex:1 1 auto;height:100%;min-width:8px"></div>
  <div class="cap-controls" style="display:flex;align-items:center;height:100%;padding-right:8px;gap:2px">
    <button class="cap-btn" data-action="minimize" title="最小化" aria-label="最小化" style="width:42px;height:26px;border:none;background:transparent;color:var(--cap-btn-fg)">
      <svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>
    </button>
    <button class="cap-btn" data-action="toggle-maximize" title="最大化" aria-label="最大化" style="width:42px;height:26px;border:none;background:transparent;color:var(--cap-btn-fg)">
      <svg class="ic-max" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>
      <svg class="ic-restore" viewBox="0 0 10 10" style="display:none"><path d="M2.5 0.5v2M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1"/></svg>
    </button>
    <button class="cap-btn cap-close" data-action="close" title="关闭" aria-label="关闭" style="width:42px;height:26px;border:none;background:transparent;color:var(--cap-btn-fg)">
      <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>
    </button>
  </div>
</div>
`

let controls: { minimize(): void; toggleMaximize(): void; close(): void; setMaximized(max: boolean): void }

function installCaption(): void {
  if (!ENABLED || document.getElementById('dsh-caption')) return
  const div = document.createElement('div')
  div.innerHTML = TITLEBAR_HTML
  ;(document.body ?? document.documentElement).appendChild(div)

  const caption = div.querySelector('#dsh-caption') as HTMLElement
  const maxIcon = caption.querySelector('.ic-max') as HTMLElement
  const restoreIcon = caption.querySelector('.ic-restore') as HTMLElement
  const maxBtn = caption.querySelector('[data-action="toggle-maximize"]') as HTMLElement

  controls = {
    // The buttons run in the preload's ISOLATED world, where the main-world
    // `window.dshWindowControls` bridge (contextBridge) is NOT visible — so they
    // must send IPC directly via ipcRenderer instead of calling the bridge.
    minimize: () => ipcRenderer.send('dsh:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('dsh:window', 'toggle-maximize'),
    close: () => ipcRenderer.send('dsh:window', 'close'),
    setMaximized(max: boolean) {
      if (maxIcon && restoreIcon) {
        maxIcon.style.display = max ? 'none' : ''
        restoreIcon.style.display = max ? '' : 'none'
        maxBtn?.setAttribute('title', max ? '还原' : '最大化')
        maxBtn?.setAttribute('aria-label', max ? '还原' : '最大化')
      }
    },
  }

  caption.querySelectorAll('.cap-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const action = (btn as HTMLElement).dataset.action
      if (action === 'minimize') controls.minimize()
      else if (action === 'toggle-maximize') controls.toggleMaximize()
      else if (action === 'close') controls.close()
    })
  })

  // macOS: keep the native traffic lights, hide our buttons.
  if (IS_MAC) {
    const controlsEl = caption.querySelector('.cap-controls') as HTMLElement
    if (controlsEl) controlsEl.style.display = 'none'
  }

  // Maximize state is pushed from the main process.
  window.addEventListener('dsh:window-state', ((event: CustomEvent<{ maximized: boolean }>) => {
    controls?.setMaximized(Boolean(event.detail?.maximized))
  }) as EventListener)

  attachThemeObserver(caption)
  attachCaptionGuard(caption)
}

/**
 * Re-injects the caption if the SPA ever removes/replaces it (frameworks often
 * swap <body> content on re-render, e.g. after a resize / maximize), which would
 * otherwise silently kill the window controls. Debounced to avoid churn.
 */
function attachCaptionGuard(caption: HTMLElement): void {
  if (!document.body) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (!document.getElementById('dsh-caption')) {
        installCaption()
      }
    }, 200)
  }
  const mo = new MutationObserver(guard)
  mo.observe(document.body, { childList: true, subtree: false })
  window.addEventListener('dsh:rebuild-titlebar', guard)
}

function attachThemeObserver(caption: HTMLElement): void {
  const apply = (): void => {
    const doc = document.documentElement
    const body = document.body
    // Primary marker of the embedded dsh SPA: `data-ds-dark-theme` on <body>
    // (see @deepseek-ai/dsh-client-ui-theme: body.toggleAttribute('data-ds-dark-theme')).
    const darkOnBody = body?.hasAttribute?.('data-ds-dark-theme') ?? false
    const attr = doc.getAttribute('data-theme')
    const clsDark = doc.classList.contains('dark') || doc.classList.contains('theme-dark')
    const clsLight = doc.classList.contains('light') || doc.classList.contains('theme-light')
    const scheme = (doc.style.colorScheme as string) || ''
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    let dark = true
    if (darkOnBody) dark = true
    else if (attr === 'light' || clsLight || scheme === 'light') dark = false
    else if (attr === 'dark' || clsDark || scheme === 'dark') dark = true
    else dark = prefersDark
    caption.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
  apply()
  const mo = new MutationObserver(apply)
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  })
  if (document.body) {
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
  }
  try {
    window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', apply)
  } catch {
    // older webviews
  }
  // The SPA may swap <html>/<body> later; keep re-observing + a manual rebuild hook.
  window.addEventListener('dsh:rebuild-theme', apply as EventListener)
}

// The official web app may render after our DOMContentLoaded; keep re-asserting
// for a short window to survive any body replacement by the framework.
window.addEventListener('DOMContentLoaded', () => installCaption())
if (document.readyState === 'loading') {
  window.addEventListener('load', () => installCaption())
} else {
  installCaption()
}
window.addEventListener('dsh:rebuild-titlebar', () => installCaption())

// ---- IPC bridge for the caption window controls ----
contextBridge.exposeInMainWorld('dshWindowControls', {
  minimize: () => ipcRenderer.send('dsh:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('dsh:window', 'toggle-maximize'),
  close: () => ipcRenderer.send('dsh:window', 'close'),
})

ipcRenderer.on('dsh:window-state', (_event, state: { maximized: boolean }) => {
  window.dispatchEvent(new CustomEvent('dsh:window-state', { detail: state }))
})
