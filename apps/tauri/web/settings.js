(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let currentRuntime

  function call(command, args) {
    const invoke = window.__TAURI__?.core?.invoke
    if (typeof invoke !== 'function') return Promise.reject(new Error('Tauri IPC is unavailable.'))
    return invoke(command, args)
  }

  function message(value) {
    return String(value?.message || value || '未知错误')
  }

  function setStatus(element, value, bad = false) {
    if (!element) return
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  function runtimeDescription(runtime) {
    if (!runtime?.appUrl) return 'Runtime 尚未就绪。请关闭诊断窗口后从主界面的“菜单”执行重启。'
    const lines = [
      '状态：' + (runtime.recoveryMode ? '兼容模式（Web 可用）' : runtime.state),
      'Node：' + (runtime.nodeSource || 'unknown'),
      '版本：' + (runtime.dshVersion || 'unknown'),
      '地址：' + runtime.appUrl,
    ]
    if (runtime.safeMode) lines.push('安全配置：已启用临时干净配置，未修改用户配置。')
    if (runtime.isolatedPlugins?.length) lines.push('已隔离插件：' + runtime.isolatedPlugins.join(', '))
    if (runtime.suspectedPlugins?.length) lines.push('疑似故障插件：' + runtime.suspectedPlugins.join(', '))
    return lines.join('\n')
  }

  function render(runtime) {
    currentRuntime = runtime
    const label = runtime?.recoveryMode ? 'degraded' : (runtime?.state || 'stopped')
    $('runtime-state').textContent = label
    setStatus($('runtime-detail'), runtimeDescription(runtime))
    setStatus(
      $('web-detail'),
      runtime?.appUrl
        ? 'Harness Web 正在使用本地 Runtime；刷新、重启和插件恢复请从主界面的“菜单”执行。'
        : 'Runtime 尚未提供 Web 地址；请关闭诊断窗口后从主界面的“菜单”重试。',
    )
  }

  async function refresh() {
    try {
      render(await call('runtime_status'))
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  }

  async function quit() {
    $('settings-quit').disabled = true
    setStatus($('runtime-detail'), '正在关闭 HarnessDock 及其全部后台进程…')
    try {
      await call('app_quit')
    } catch (error) {
      // The native process may exit before the IPC response is delivered.
      // Only render an error while the window is still alive.
      setStatus($('runtime-detail'), message(error), true)
      $('settings-quit').disabled = false
    }
  }

  $('runtime-refresh').addEventListener('click', refresh)
  $('settings-quit').addEventListener('click', quit)
  $('settings-close').addEventListener('click', async () => {
    try { await call('shell_settings_close') } catch (error) { setStatus($('runtime-detail'), message(error), true) }
  })

  void refresh()
  const refreshTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, 4000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh()
  })
  window.addEventListener('pagehide', () => window.clearInterval(refreshTimer), { once: true })
})()
