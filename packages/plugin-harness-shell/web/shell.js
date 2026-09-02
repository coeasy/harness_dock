(() => {
  'use strict'

  const bridge = window.__DSH_SHELL_BRIDGE__
  const compatibleBridge = bridge?.apiVersion === 1 && bridge?.pluginId === 'harness-shell'
  const commands = [
    ['web.reload', '刷新 Harness Web'],
    ['web.restart', '重启 Harness Web'],
    ['runtime.safe-mode', '隔离插件启动'],
    ['runtime.clear-quarantine', '清除隔离并重启'],
    ['diagnostics.open', '打开诊断与恢复'],
    ['app.update.check', '检查 GitHub 更新'],
    ['app.update.install', '安装 GitHub 更新'],
    ['app.quit', '退出 HarnessDock'],
  ]
  const state = { busy: false, maximized: false, mounted: false }

  const can = (command) => compatibleBridge
    ? bridge.capabilities?.[command] === true
    : command === 'web.reload'
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
      .bar { -webkit-app-region: drag; align-items: center; backdrop-filter: blur(18px); background: rgba(20, 24, 32, .94); border: 1px solid rgba(255,255,255,.1); border-radius: 0 0 12px 12px; box-shadow: 0 8px 28px rgba(0,0,0,.22); color: #edf2f7; display: flex; gap: 8px; height: 44px; left: 8px; padding: 0 8px 0 14px; position: fixed; right: 8px; top: 0; user-select: none; z-index: 2147483000; }
      .brand { align-items: center; display: flex; flex: 1; gap: 8px; min-width: 0; }
      .mark { background: linear-gradient(135deg,#6ea8fe,#9b8cff); border-radius: 7px; box-shadow: 0 0 16px rgba(110,168,254,.34); height: 18px; width: 18px; }
      .title { font-size: 13px; font-weight: 650; letter-spacing: .01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .status { color: #aab5c5; font-size: 11px; max-width: 28vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button { -webkit-app-region: no-drag; background: transparent; border: 0; border-radius: 7px; color: #dbe4f0; cursor: pointer; font: inherit; height: 30px; min-width: 30px; padding: 0 8px; }
      button:hover { background: rgba(255,255,255,.12); }
      button:disabled { cursor: wait; opacity: .48; }
      .icon { font-size: 16px; line-height: 1; }
      .menu { background: #1c2330; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; box-shadow: 0 14px 36px rgba(0,0,0,.38); display: none; min-width: 214px; padding: 6px; position: fixed; right: 8px; top: 48px; z-index: 2147483001; }
      .menu.open { display: block; }
      .menu button { display: block; text-align: left; width: 100%; }
      .menu button.hidden { display: none; }
      .separator { border-top: 1px solid rgba(255,255,255,.1); margin: 5px 4px; }
      .toast { background: rgba(21, 27, 38, .96); border: 1px solid rgba(255,255,255,.13); border-radius: 8px; bottom: 16px; color: #edf2f7; display: none; font-size: 12px; left: 50%; max-width: min(480px, calc(100vw - 40px)); padding: 9px 12px; position: fixed; transform: translateX(-50%); z-index: 2147483002; }
      .toast.show { display: block; }
      @media (max-width: 640px) { .status { display: none; } .bar { left: 0; right: 0; } .menu { right: 4px; } }
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
        <button data-action="window.minimize" title="最小化" aria-label="最小化"><span class="icon">−</span></button>
        <button data-action="window.toggleMaximize" title="最大化" aria-label="最大化"><span class="icon" data-maximize-icon>□</span></button>
        <button data-action="window.close" title="关闭窗口" aria-label="关闭窗口"><span class="icon">×</span></button>
        <button data-menu-toggle title="菜单" aria-label="菜单"><span class="icon">☰</span></button>
      </div>
      <div class="menu" data-menu role="menu"></div>
      <div class="toast" data-toast role="status"></div>`
    document.documentElement.appendChild(host)

    const status = shadow.querySelector('[data-status]')
    const toast = shadow.querySelector('[data-toast]')
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
      toast.textContent = message
      toast.classList.add('show')
      window.setTimeout(() => toast.classList.remove('show'), 2600)
    }
    const run = async (command, label) => {
      if (state.busy || !can(command)) return
      state.busy = true
      setStatus(`${label}…`)
      shadow.querySelectorAll('button').forEach((button) => { button.disabled = true })
      try {
        const result = await invoke(command)
        if (command === 'window.toggleMaximize' && result) {
          state.maximized = Boolean(result.maximized)
          updateMaximizeIcon()
        }
        if (command === 'app.update.check' && result) {
          if (result.available) {
            const version = result.latestVersion ? ` v${result.latestVersion}` : ''
            showToast(`发现 HarnessDock${version} 更新，请选择安装`)
          } else {
            showToast(`已是最新版本${result.currentVersion ? ` v${result.currentVersion}` : ''}`)
          }
        } else if (command === 'app.update.install' && result?.status === 'latest') {
          showToast(`已是最新版本${result.version ? ` v${result.version}` : ''}`)
        } else {
          showToast(`${label}已执行`)
        }
        if (command !== 'web.reload') setStatus('Harness Web')
      } catch (error) {
        const message = error?.message || String(error)
        setStatus('外壳操作失败')
        showToast(`${label}失败：${message}`)
      } finally {
        state.busy = false
        shadow.querySelectorAll('button').forEach((button) => { button.disabled = false })
      }
    }

    commands.forEach(([command, label], index) => {
      if (index === 2 || index === 5) {
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
        menu.classList.remove('open')
        void run(command, label)
      })
      menu.appendChild(button)
    })

    shadow.querySelectorAll('[data-action]').forEach((button) => {
      const command = button.dataset.action
      if (!can(command)) button.style.display = 'none'
      button.addEventListener('click', () => void run(command, button.getAttribute('title') || command))
    })
    menuToggle.addEventListener('click', () => menu.classList.toggle('open'))
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) menu.classList.remove('open')
    })

    if (compatibleBridge && bridge.invoke && can('window.state')) {
      invoke('window.state').then((value) => {
        state.maximized = Boolean(value?.maximized)
        updateMaximizeIcon()
      }).catch(() => {})
    }
    if (compatibleBridge && bridge.subscribe) bridge.subscribe((event) => {
      if (event?.state === 'error') showToast(event.message || '外壳状态异常')
    })
  }

  window.__DSH_SHELL_REBUILD__ = mount
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
})()
