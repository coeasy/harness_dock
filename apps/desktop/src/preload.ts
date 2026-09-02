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
  #dsh-caption .cap-menu { position: relative; display: inline-flex; align-items: center; height: 100%; }
  #dsh-caption .cap-menu-btn { width: 42px; height: 26px; border: none; margin: 0; padding: 0; cursor: default; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; background: transparent; color: var(--cap-btn-fg); font-size: 15px; }
  #dsh-caption .cap-menu-btn:hover { background: var(--cap-btn-hover); color: var(--cap-title); }
  #dsh-caption .cap-menu-panel { position: absolute; top: 34px; right: 0; z-index: 2; display: none; width: 224px; padding: 6px; border: 1px solid var(--cap-border); border-radius: 10px; background: rgba(12,18,32,.98); box-shadow: 0 14px 30px rgba(0,0,0,.38); }
  #dsh-caption .cap-menu-panel.is-open { display: flex; flex-direction: column; gap: 3px; }
  #dsh-caption .cap-menu-panel button { width: 100%; min-height: 30px; padding: 0 9px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--cap-title); text-align: left; font: 12px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; cursor: default; }
  #dsh-caption .cap-menu-panel button:hover { background: var(--cap-btn-hover); }
  #dsh-caption .cap-menu-panel button[hidden] { display: none; }
  #dsh-shell-toast { position: fixed; top: 52px; right: 12px; z-index: 2147483647; max-width: 360px; padding: 8px 11px; border: 1px solid rgba(45,212,191,.42); border-radius: 9px; background: rgba(7,47,38,.96); color: #b8fff2; font: 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif; opacity: 0; pointer-events: none; transform: translateY(-4px); transition: opacity .16s ease, transform .16s ease; }
  #dsh-shell-toast.is-visible { opacity: 1; transform: translateY(0); }
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
    <div class="cap-menu">
      <button class="cap-menu-btn" data-action="menu" title="菜单" aria-label="菜单" aria-expanded="false">☰</button>
      <div class="cap-menu-panel" role="menu" aria-label="HarnessDock 菜单">
        <button data-command="web.reload" role="menuitem">刷新 Harness Web</button>
        <button data-command="web.restart" role="menuitem">重启 Harness Web</button>
        <button data-command="runtime.safe-mode" role="menuitem">隔离插件启动</button>
        <button data-command="runtime.clear-quarantine" role="menuitem">清除插件隔离并重启</button>
        <button data-command="diagnostics.open" role="menuitem">打开插件诊断</button>
        <button data-command="app.update.check" role="menuitem">检查 GitHub 更新</button>
        <button data-command="app.update.install" role="menuitem">安装 GitHub 更新</button>
        <button data-command="app.quit" role="menuitem">退出 HarnessDock</button>
      </div>
    </div>
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
  <div id="dsh-shell-toast" role="status" aria-live="polite"></div>
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
  const menuButton = caption.querySelector('[data-action="menu"]') as HTMLElement
  const menuPanel = caption.querySelector('.cap-menu-panel') as HTMLElement
  const toast = caption.querySelector('#dsh-shell-toast') as HTMLElement

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

  const notify = (message: string, error = false): void => {
    if (!toast) return
    toast.textContent = message
    toast.style.borderColor = error ? 'rgba(248,113,113,.45)' : ''
    toast.style.background = error ? 'rgba(49,19,28,.96)' : ''
    toast.style.color = error ? '#fecaca' : ''
    toast.classList.add('is-visible')
    window.setTimeout(() => toast.classList.remove('is-visible'), 3200)
  }

  const configureShellMenu = async (): Promise<void> => {
    let capabilities: Record<string, boolean> = {}
    try {
      capabilities = await ipcRenderer.invoke('dsh:shell-capabilities') as Record<string, boolean>
    } catch {
      notify('外壳菜单尚未就绪，请稍后重试。', true)
    }
    menuPanel?.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
      const command = button.dataset.command
      if (!command || capabilities[command] === false) {
        button.hidden = true
        return
      }
      button.addEventListener('click', async (event) => {
        event.stopPropagation()
        menuPanel.classList.remove('is-open')
        menuButton?.setAttribute('aria-expanded', 'false')
        button.disabled = true
        try {
          await ipcRenderer.invoke('dsh:shell', command)
          notify(`${button.textContent || '操作'}已执行`)
        } catch (error) {
          notify(`${button.textContent || '操作'}失败：${error instanceof Error ? error.message : String(error)}`, true)
        } finally {
          button.disabled = false
        }
      })
    })
  }

  menuButton?.addEventListener('click', (event) => {
    event.stopPropagation()
    const open = !menuPanel?.classList.contains('is-open')
    menuPanel?.classList.toggle('is-open', open)
    menuButton.setAttribute('aria-expanded', open ? 'true' : 'false')
  })
  document.addEventListener('click', () => {
    menuPanel?.classList.remove('is-open')
    menuButton?.setAttribute('aria-expanded', 'false')
  })
  void configureShellMenu()

  // macOS: keep the native traffic lights, hide our buttons.
  if (IS_MAC) {
    caption.querySelectorAll<HTMLElement>('[data-action="minimize"], [data-action="toggle-maximize"], [data-action="close"]')
      .forEach((element) => { element.style.display = 'none' })
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
