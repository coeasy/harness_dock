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
  const transitionStatus = Object.freeze({
    'web.reload': '正在重新加载 Harness Web…',
    'web.restart': 'Runtime 正在重启，Harness Web 会自动恢复…',
    'runtime.safe-mode': '正在以隔离插件模式恢复 Harness Web…',
  })

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
      .activity { background: rgba(110,168,254,.08); height: 2px; left: 0; opacity: 0; overflow: hidden; pointer-events: none; position: fixed; right: 0; top: 43px; transition: opacity .15s ease; z-index: 2147483004; }
      .activity::after { background: linear-gradient(90deg, transparent, #6ea8fe 24%, #9b8cff 58%, #5eead4 78%, transparent); content: ""; height: 100%; left: 0; position: absolute; top: 0; transform: translateX(-110%); width: 42%; }
      .activity.show { opacity: 1; }
      .activity.show::after { animation: activity-run 1.15s cubic-bezier(.42,0,.58,1) infinite; }
      .menu { background: rgba(28,35,48,.985); border: 1px solid rgba(255,255,255,.14); border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,.38); min-width: 214px; opacity: 0; padding: 6px; pointer-events: none; position: fixed; right: 8px; top: 48px; transform: translateY(-7px) scale(.985); transform-origin: top right; transition: opacity .14s ease, transform .16s cubic-bezier(.2,.8,.2,1); visibility: hidden; z-index: 2147483003; }
      .menu.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); visibility: visible; }
      .menu button { display: block; text-align: left; width: 100%; }
      .menu button.hidden { display: none; }
      .separator { border-top: 1px solid rgba(255,255,255,.1); margin: 5px 4px; }
      .toast { background: rgba(21, 27, 38, .97); border: 1px solid rgba(255,255,255,.13); border-radius: 9px; bottom: 16px; box-shadow: 0 12px 30px rgba(0,0,0,.28); color: #edf2f7; font-size: 12px; left: 50%; max-width: min(480px, calc(100vw - 40px)); opacity: 0; padding: 9px 12px; pointer-events: none; position: fixed; transform: translate(-50%, 9px) scale(.98); transition: opacity .16s ease, transform .2s cubic-bezier(.2,.8,.2,1); visibility: hidden; z-index: 2147483005; }
      .toast.show { opacity: 1; transform: translate(-50%, 0) scale(1); visibility: visible; }
      .transition-mask { align-items: center; backdrop-filter: blur(2px); background: rgba(5,11,20,.34); color: #dbe7f7; display: flex; font-size: 12px; inset: 44px 0 0; justify-content: center; opacity: 0; pointer-events: none; position: fixed; transform: translateY(3px); transition: opacity .16s ease, transform .18s ease; visibility: hidden; z-index: 2147482999; }
      .transition-mask.show { opacity: 1; transform: translateY(0); visibility: visible; }
      .transition-mask span { background: rgba(20,27,39,.9); border: 1px solid rgba(255,255,255,.12); border-radius: 999px; box-shadow: 0 10px 28px rgba(0,0,0,.22); padding: 8px 12px; }
      @keyframes shell-enter { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes mark-idle { 0%,100% { transform: scale(1); } 50% { transform: scale(1.07); } }
      @keyframes mark-busy { 0%,100% { transform: scale(.94); } 50% { transform: scale(1.1); } }
      @keyframes icon-spin { to { transform: rotate(360deg); } }
      @keyframes icon-breathe { from { transform: scale(.9); opacity: .72; } to { transform: scale(1.12); opacity: 1; } }
      @keyframes activity-run { 0% { transform: translateX(-115%); } 100% { transform: translateX(345%); } }
      @media (max-width: 640px) { .status { display: none; } .menu { right: 4px; } }
      @media (prefers-reduced-motion: reduce) {
        .bar, .mark, button, .activity, .menu, .toast, .icon, .transition-mask { animation: none !important; transition-duration: .01ms !important; }
        .activity.show::after { animation: none !important; transform: none; width: 100%; opacity: .72; }
        button:hover, button:active, .transition-mask { transform: none; }
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
        <button data-menu-toggle title="菜单" aria-label="菜单" aria-expanded="false" aria-controls="dsh-shell-menu"><span class="icon">☰</span></button>
        <button data-action="window.minimize" title="最小化" aria-label="最小化"><span class="icon">−</span></button>
        <button data-action="window.toggleMaximize" title="最大化" aria-label="最大化"><span class="icon" data-maximize-icon>□</span></button>
        <button data-action="window.close" title="退出 HarnessDock" aria-label="退出 HarnessDock"><span class="icon">×</span></button>
      </div>
      <div class="activity" data-activity aria-hidden="true"></div>
      <div id="dsh-shell-menu" class="menu" data-menu role="menu" aria-label="HarnessDock 菜单"></div>
      <div class="transition-mask" data-transition aria-live="polite"><span data-transition-text></span></div>
      <div class="toast" data-toast role="status" aria-live="polite"></div>`
    document.documentElement.appendChild(host)

    const bar = shadow.querySelector('.bar')
    const status = shadow.querySelector('[data-status]')
    const toast = shadow.querySelector('[data-toast]')
    const activity = shadow.querySelector('[data-activity]')
    const menu = shadow.querySelector('[data-menu]')
    const menuToggle = shadow.querySelector('[data-menu-toggle]')
    const transition = shadow.querySelector('[data-transition]')
    const transitionText = shadow.querySelector('[data-transition-text]')
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
    const showToast = (message, duration = 2600) => {
      if (!toast) return
      window.clearTimeout(state.toastTimer)
      toast.textContent = publicText(message)
      toast.classList.add('show')
      state.toastTimer = window.setTimeout(() => toast.classList.remove('show'), duration)
    }
    const setTransition = (command, active) => {
      const message = transitionStatus[command]
      if (!transition || !message) return
      if (active && transitionText) transitionText.textContent = message
      transition.classList.toggle('show', active)
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
      setTransition(command, active)
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
        showToast(`${label}失败：${message}`, 4800)
      } finally {
        if (!windowCommand) {
          state.busy = false
          setBusyCommand(command, false)
          setBusinessActionsDisabled(false)
        }
      }
    }

    const visibleMenuItems = () => [...menu.querySelectorAll('button[role="menuitem"]')]
      .filter((button) => !button.classList.contains('hidden') && !button.disabled)
    const closeMenu = (restoreFocus = false) => {
      menu.classList.remove('open')
      menuToggle?.setAttribute('aria-expanded', 'false')
      if (restoreFocus) menuToggle?.focus()
    }
    const openMenu = (focusLast = false) => {
      menu.classList.add('open')
      menuToggle?.setAttribute('aria-expanded', 'true')
      queueMicrotask(() => {
        const items = visibleMenuItems()
        const target = focusLast ? items.at(-1) : items[0]
        target?.focus()
      })
    }
    const toggleMenu = () => {
      if (menu.classList.contains('open')) closeMenu(true)
      else openMenu(false)
    }
    const moveMenuFocus = (direction) => {
      const items = visibleMenuItems()
      if (!items.length) return
      const current = shadow.activeElement
      const index = Math.max(0, items.indexOf(current))
      const next = (index + direction + items.length) % items.length
      items[next]?.focus()
    }

    const sectionStarts = new Set(['runtime.safe-mode', 'gateway.manage'])
    commands.forEach(([command, label]) => {
      if (sectionStarts.has(command)) {
        const separator = document.createElement('div')
        separator.className = 'separator'
        separator.setAttribute('role', 'separator')
        menu.appendChild(separator)
      }
      const button = document.createElement('button')
      button.textContent = label
      button.dataset.action = command
      button.setAttribute('role', 'menuitem')
      button.tabIndex = -1
      if (!can(command)) button.className = 'hidden'
      button.addEventListener('click', () => {
        closeMenu(false)
        void run(command, label)
      })
      menu.appendChild(button)
    })

    shadow.querySelectorAll('.bar [data-action]').forEach((button) => {
      const command = button.dataset.action
      if (!can(command)) button.style.display = 'none'
      button.addEventListener('click', () => void run(command, button.getAttribute('title') || command))
    })
    menuToggle.addEventListener('click', toggleMenu)
    menuToggle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      openMenu(event.key === 'ArrowUp')
    })
    shadow.addEventListener('keydown', (event) => {
      if (!menu.classList.contains('open')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu(true)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        moveMenuFocus(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        moveMenuFocus(-1)
      } else if (event.key === 'Home') {
        event.preventDefault()
        visibleMenuItems()[0]?.focus()
      } else if (event.key === 'End') {
        event.preventDefault()
        visibleMenuItems().at(-1)?.focus()
      }
    })
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) closeMenu(false)
    })

    if (compatibleBridge && bridge.invoke && can('window.state')) {
      invoke('window.state').then((value) => {
        state.maximized = Boolean(value?.maximized)
        updateMaximizeIcon()
      }).catch(() => {})
    }
    if (compatibleBridge && bridge.subscribe) {
      const unsubscribe = bridge.subscribe((event) => {
        if (event?.state === 'error') showToast(event.message || '外壳状态异常', 4800)
      })
      window.addEventListener('pagehide', () => unsubscribe?.(), { once: true })
    }
  }

  window.__DSH_SHELL_REBUILD__ = mount
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()