(() => {
  'use strict'

  const bridge = window.__DSH_SHELL_BRIDGE__
  const compatibleBridge = bridge?.apiVersion === 2 && bridge?.pluginId === 'harness-shell'
  const commands = [
    ['web.reload', '刷新 Harness Web'],
    ['web.restart', '重启 Harness Web'],
    ['runtime.safe-mode', '隔离插件启动'],
    ['gateway.manage', '移动设备 / Gateway'],
    ['diagnostics.open', 'GitHub 更新 / 诊断与恢复'],
  ]
  const state = {
    busy: false,
    busyCommand: null,
    maximized: false,
    mounted: false,
    toastTimer: null,
  }

  const actionStatus = Object.freeze({
    'web.reload': '正在刷新 Harness Web',
    'web.restart': '正在重启 Harness Runtime',
    'runtime.safe-mode': '正在隔离插件并重启',
    'gateway.manage': '正在打开移动设备管理',
    'diagnostics.open': '正在打开诊断与更新',
  })

  // Shell errors can originate in native IPC or third-party hosts. Never put a
  // reusable launch token, Authorization value, password or query string into
  // the Harness document even though textContent already prevents HTML injection.
  const publicText = (value) => {
    const raw = value && typeof value === 'object' && 'message' in value
      ? String(value.message || '')
      : String(value ?? '')
    const withoutUrls = raw.replace(/\bhttps?:\/\/[^\s<>"']+/gi, (candidate) => {
      try {
        const url = new URL(candidate)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return candidate.replace(/[?#].*$/, '')
      }
    })
    return withoutUrls
      .replace(/\b(token|authorization|password|secret|api[-_]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  }

  const can = (command) => compatibleBridge
    ? bridge.capabilities?.[command] === true
    : command === 'web.reload'
  const isWindowCommand = (command) => typeof command === 'string' && command.startsWith('window.')
  const invoke = (command, payload) => {
    if (compatibleBridge && bridge.invoke && can(command)) return bridge.invoke(command, payload)
    if (command === 'web.reload') {
      window.location.reload()
      return Promise.resolve()
    }
    return Promise.reject(new Error('此功能需要桌面外壳支持'))
  }

  function css() {
    return `
      :host { all: initial; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .bar { -webkit-app-region: drag; align-items: center; backdrop-filter: blur(18px); background: rgba(20, 24, 32, .96); border-bottom: 1px solid rgba(255,255,255,.12); box-shadow: 0 4px 18px rgba(0,0,0,.28); box-sizing: border-box; color: #edf2f7; display: flex; gap: 8px; height: 44px; left: 0; padding: 0 10px 0 14px; position: fixed; right: 0; top: 0; user-select: none; z-index: 2147483000; animation: shell-enter .24s cubic-bezier(.2,.8,.2,1) both; transition: background .18s ease, box-shadow .18s ease; }
      .bar.busy { background: rgba(17, 24, 35, .985); box-shadow: 0 6px 24px rgba(0,0,0,.34); }
      .brand { align-items: center; display: flex; flex: 1; gap: 8px; min-width: 0; }
      .mark { background: linear-gradient(135deg,#6ea8fe,#9b8cff); border-radius: 7px; box-shadow: 0 0 16px rgba(110,168,254,.34); height: 18px; width: 18px; animation: mark-idle 3.2s ease-in-out infinite; transition: transform .18s ease, box-shadow .18s ease; }
      .bar.busy .mark { animation: mark-busy 1s ease-in-out infinite; box-shadow: 0 0 20px rgba(110,168,254,.55); }
      .title { font-size: 13px; font-weight: 650; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .status { color: #aab5c5; font-size: 11px; max-width: 32vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color .16s ease, opacity .16s ease; }
      .bar.busy .status { color: #d4deec; }
      button { -webkit-app-region: no-drag; background: transparent; border: 0; border-radius: 7px; color: #dbe4f0; cursor: pointer; font: inherit; height: 30px; min-width: 30px; padding: 0 8px; position: relative; transition: background .13s ease, transform .11s ease, opacity .13s ease, color .13s ease; }
      button:hover { background: rgba(255,255,255,.12); transform: translateY(-1px); }
      button:active { transform: translateY(0) scale(.94); }
      button:focus-visible { outline: 2px solid rgba(110,168,254,.72); outline-offset: 1px; }
      button:disabled { cursor: wait; opacity: .48; transform: none; }
      button.is-running { background: rgba(110,168,254,.14); color: #f4f8ff; opacity: 1; }
      button.is-running .icon { display: inline-block; animation: icon-breathe .72s ease-in-out infinite alternate; }
      button[data-action="web.reload"].is-running .icon { animation: icon-spin .85s linear infinite; }
      .icon { font-size: 16px; line-height: 1; transform-origin: 50% 50%; }
      .activity { background: rgba(110,168,254,.08); height: 2px; left: 0; opacity: 0; overflow: hidden; pointer-events: none; position: fixed; right: 0; top: 43px; transition: opacity .15s ease; z-index: 2147483002; }
      .activity::after { background: linear-gradient(90deg, transparent, #6ea8fe 24%, #9b8cff 58%, #5eead4 78%, transparent); content: ""; height: 100%; left: 0; position: absolute; top: 0; transform: translateX(-110%); width: 42%; }
      .activity.show { opacity: 1; }
      .activity.show::after { animation: activity-run 1.15s cubic-bezier(.42,0,.58,1) infinite; }
      .menu { background: rgba(28,35,48,.985); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,.38); min-width: 214px; opacity: 0; padding: 6px; pointer-events: none; position: fixed; right: 8px; top: 48px; transform: translateY(-7px) scale(.985); transform-origin: top right; transition: opacity .14s ease, transform .16s cubic-bezier(.2,.8,.2,1); visibility: hidden; z-index: 2147483001; }
      .menu.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); visibility: visible; }
      .menu button { display: block; text-align: left; width: 100%; }
      .menu button.hidden { display: none; }
      .separator { border-top: 1px solid rgba(255,255,255,.1); margin: 5px 4px; }
      .toast { background: rgba(21, 27, 38, .97); border: 1px solid rgba(255,255,255,.13); border-radius: 9px; bottom: 16px; box-shadow: 0 12px 30px rgba(0,0,0,.28); color: #edf2f7; font-size: 12px; left: 50%; max-width: min(480px, calc(100vw - 40px)); opacity: 0; padding: 9px 12px; pointer-events: none; position: fixed; transform: translate(-50%, 9px) scale(.98); transition: opacity .16s ease, transform .2s cubic-bezier(.2,.8,.2,1); visibility: hidden; z-index: 2147483002; }
      .toast.show { opacity: 1; transform: translate(-50%, 0) scale(1); visibility: visible; }
      @keyframes shell-enter { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes mark-idle { 0%,100% { transform: scale(1); } 50% { transform: scale(1.07); } }
      @keyframes mark-busy { 0%,100% { transform: scale(.94); } 50% { transform: scale(1.1); } }
      @keyframes icon-spin { to { transform: rotate(360deg); } }
      @keyframes icon-breathe { from { transform: scale(.9); opacity: .72; } to { transform: scale(1.12); opacity: 1; } }
      @keyframes activity-run { 0% { transform: translateX(-115%); } 100% { transform: translateX(345%); } }
      @media (max-width: 640px) { .status { display: none; } .menu { right: 4px; } }
      @media (prefers-reduced-motion: reduce) {
        .bar, .mark, button, .activity, .menu, .toast, .icon { animation: none !important; transition-duration: .01ms !important; }
        .activity.show::after { animation: none !important; transform: none; width: 100%; opacity: .72; }
        button:hover, button:active { transform: none; }
      }
    `
  }

  function mount() {
    if (state.mounted || document.getElementById('dsh-harness-shell')) return
    state.mounted = true
    const host = document.createElement('div')
    host.id = 'dsh-harness-shell'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>${css()}</style>
      <div class="bar" data-tauri-drag-region role="toolbar" aria-label="HarnessDock 外壳">
        <div class="brand"><span class="mark" aria-hidden="true"></span><span class="title">HarnessDock</span><span class="status" data-status>Harness Web</span></div>
        <button data-action="web.reload" title="刷新 Harness Web" aria-label="刷新 Harness Web"><span class="icon">↻</span></button>
        <button data-menu-toggle title="菜单" aria-label="菜单" aria-expanded="false"><span class="icon">☰</span></button>
        <button data-action="window.minimize" title="最小化" aria-label="最小化"><span class="icon">−</span></button>
        <button data-action="window.toggleMaximize" title="最大化" aria-label="最大化"><span class="icon" data-maximize-icon>□</span></button>
        <button data-action="window.close" title="关闭窗口" aria-label="关闭窗口"><span class="icon">×</span></button>
      </div>
      <div class="activity" data-activity aria-hidden="true"></div>
      <div class="menu" data-menu role="menu"></div>
      <div class="toast" data-toast role="status" aria-live="polite"></div>`
    document.documentElement.appendChild(host)

    const bar = shadow.querySelector('.bar')
    const status = shadow.querySelector('[data-status]')
    const toast = shadow.querySelector('[data-toast]')
    const activity = shadow.querySelector('[data-activity]')
    const menu = shadow.querySelector('[data-menu]')
    const menuToggle = shadow.querySelector('[data-menu-toggle]')
    const layout = document.createElement('style')
    layout.id = 'dsh-shell-layout'
    layout.textContent = `html.dsh-shell-mounted { height: 100% !important; overflow: hidden !important; }\nbody.dsh-shell-mounted { box-sizing: border-box !important; height: 100vh !important; min-height: 0 !important; margin: 0 !important; padding-top: 44px !important; overflow: hidden !important; }\nbody.dsh-shell-mounted #root, body.dsh-shell-mounted #app, body.dsh-shell-mounted [data-reactroot] { box-sizing: border-box !important; height: 100% !important; min-height: 0 !important; max-height: 100% !important; overflow: auto !important; }`
    document.head?.appendChild(layout)
    document.documentElement.classList.add('dsh-shell-mounted')
    document.body?.classList.add('dsh-shell-mounted')

    const setStatus = (message) => { if (status) status.textContent = message }
    const updateMaximizeIcon = () => {
      const icon = shadow.querySelector('[data-maximize-icon]')
      if (icon) icon.textContent = state.maximized ? '❐' : '□'
    }
    const showToast = (message) => {
      if (!toast) return
      window.clearTimeout(state.toastTimer)
      toast.textContent = publicText(message)
      toast.classList.add('show')
      state.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600)
    }
    const setBusinessActionsDisabled = (disabled) => {
      shadow.querySelectorAll('button[data-action]').forEach((button) => {
        if (!isWindowCommand(button.dataset.action)) button.disabled = disabled
      })
    }
    const setBusyCommand = (command, active) => {
      state.busyCommand = active ? command : null
      bar?.classList.toggle('busy', active)
      activity?.classList.toggle('show', active)
      shadow.querySelectorAll('button[data-action]').forEach((button) => {
        button.classList.toggle('is-running', active && button.dataset.action === command)
      })
    }
    const run = async (command, label) => {
      const windowCommand = isWindowCommand(command)
      if ((!windowCommand && state.busy) || !can(command)) return
      if (!windowCommand) {
        state.busy = true
        setBusyCommand(command, true)
        setStatus(`${actionStatus[command] || label}…`)
        setBusinessActionsDisabled(true)
      }
      try {
        const result = await invoke(command)
        if (command === 'window.toggleMaximize' && result) {
          state.maximized = Boolean(result.maximized)
          updateMaximizeIcon()
        }
        if (windowCommand) return
        showToast(`${label}已执行`)
        if (command !== 'web.reload') setStatus('Harness Web')
      } catch (error) {
        const message = error?.message || String(error)
        if (!windowCommand) setStatus('外壳操作失败')
        showToast(`${label}失败：${message}`)
      } finally {
        if (!windowCommand) {
          state.busy = false
          setBusyCommand(command, false)
          setBusinessActionsDisabled(false)
        }
      }
    }

    const closeMenu = () => {
      menu.classList.remove('open')
      menuToggle?.setAttribute('aria-expanded', 'false')
    }
    const toggleMenu = () => {
      const open = !menu.classList.contains('open')
      menu.classList.toggle('open', open)
      menuToggle?.setAttribute('aria-expanded', String(open))
    }

    const sectionStarts = new Set(['runtime.safe-mode', 'gateway.manage'])
    commands.forEach(([command, label]) => {
      if (sectionStarts.has(command)) {
        const separator = document.createElement('div')
        separator.className = 'separator'
        menu.appendChild(separator)
      }
      const button = document.createElement('button')
      button.textContent = label
      button.dataset.action = command
      button.setAttribute('role', 'menuitem')
      if (!can(command)) button.className = 'hidden'
      button.addEventListener('click', () => {
        closeMenu()
        void run(command, label)
      })
      menu.appendChild(button)
    })

    // Toolbar controls are wired here. Menu controls already own their listener
    // above; keeping the selectors separate avoids duplicate dispatch attempts.
    shadow.querySelectorAll('.bar [data-action]').forEach((button) => {
      const command = button.dataset.action
      if (!can(command)) button.style.display = 'none'
      button.addEventListener('click', () => void run(command, button.getAttribute('title') || command))
    })
    menuToggle.addEventListener('click', toggleMenu)
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) closeMenu()
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu()
    })

    if (compatibleBridge && bridge.invoke && can('window.state')) {
      invoke('window.state').then((value) => {
        state.maximized = Boolean(value?.maximized)
        updateMaximizeIcon()
      }).catch(() => {})
    }
    if (compatibleBridge && bridge.subscribe) {
      const unsubscribe = bridge.subscribe((event) => {
        if (event?.state === 'error') showToast(event.message || '外壳状态异常')
      })
      window.addEventListener('pagehide', () => unsubscribe?.(), { once: true })
    }
  }

  window.__DSH_SHELL_REBUILD__ = mount
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
