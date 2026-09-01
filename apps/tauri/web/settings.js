(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let currentRuntime
  let busy = false

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
    if (!runtime?.appUrl) return 'Runtime 尚未就绪。可以点击“重启并打开 Web”执行一次完整启动。'
    const lines = [
      '状态：' + (runtime.recoveryMode ? '兼容模式（Web 可用）' : runtime.state),
      'Node：' + (runtime.nodeSource || 'unknown'),
      '版本：' + (runtime.dshVersion || 'unknown'),
      '地址：' + runtime.appUrl,
    ]
    if (runtime.safeMode) lines.push('安全配置：已启用临时干净配置，未修改用户配置。')
    if (runtime.isolatedPlugins?.length) lines.push('已隔离插件：' + runtime.isolatedPlugins.join(', '))
    if (runtime.suspectedPlugins?.length) lines.push('疑似故障插件：' + runtime.suspectedPlugins.join(', '))
    return lines.join('\\n')
  }

  function render(runtime) {
    currentRuntime = runtime
    const label = runtime?.recoveryMode ? 'degraded' : (runtime?.state || 'stopped')
    $('runtime-state').textContent = label
    $('settings-open-harness').disabled = !runtime?.appUrl || busy
    $('settings-refresh-web').disabled = !runtime?.appUrl || busy
    $('runtime-restart').disabled = busy
    $('runtime-clear-restart').disabled = busy
    $('runtime-stop').disabled = busy || !runtime?.appUrl
    setStatus($('runtime-detail'), runtimeDescription(runtime))
    setStatus(
      $('web-detail'),
      runtime?.appUrl
        ? 'Harness Web 已有可用地址；点击“打开 Harness Web”即可回到主工作窗口。'
        : 'Runtime 尚未提供 Web 地址；设置页保持可用，可从这里重试安全启动。',
    )
  }

  async function refresh() {
    try {
      render(await call('runtime_status'))
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  }

  async function openHarness() {
    try {
      const runtime = await call('runtime_status')
      if (!runtime?.appUrl) throw new Error('Runtime 尚未启动。')
      await call('harness_open', { url: runtime.appUrl })
      setStatus($('web-detail'), 'Harness Web 已打开。')
    } catch (error) {
      setStatus($('web-detail'), message(error), true)
    }
  }

  async function refreshWeb() {
    if (busy) return
    const button = $('settings-refresh-web')
    button.disabled = true
    setStatus($('web-detail'), '正在刷新 Harness Web（Runtime 保持运行）…')
    try {
      await call('harness_reload_web')
      setStatus($('web-detail'), 'Harness Web 已刷新，Runtime 和当前会话保持不变。')
    } catch (error) {
      setStatus($('web-detail'), message(error), true)
    } finally {
      button.disabled = busy || !currentRuntime?.appUrl
    }
  }

  async function restart(clearQuarantine = false) {
    if (busy) return
    busy = true
    render(currentRuntime || { state: 'starting' })
    setStatus($('runtime-detail'), clearQuarantine ? '正在清除隔离并重启 Runtime…' : '正在重启 Runtime 并刷新 Harness Web…')
    try {
      if (clearQuarantine) await call('runtime_clear_plugin_quarantine')
      const runtime = await call('harness_restart_web')
      if (!runtime?.appUrl) throw new Error('Runtime 已返回，但没有可打开的 Web 地址。')
      render(runtime)
      setStatus($('web-detail'), 'Runtime 已重启，Harness Web 已重新打开；外壳设置保持按需关闭。')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    } finally {
      busy = false
      await refresh()
    }
  }

  async function stop() {
    if (busy) return
    busy = true
    render(currentRuntime || { state: 'stopping' })
    try {
      await call('harness_close').catch(() => undefined)
      await call('runtime_stop')
      setStatus($('runtime-detail'), 'Runtime 已停止。再次使用时点击“重启并打开 Web”。')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    } finally {
      busy = false
      await refresh()
    }
  }

  async function checkUpdate() {
    const button = $('update-check')
    const link = $('update-release-link')
    button.disabled = true
    $('update-state').textContent = 'checking'
    setStatus($('update-detail'), '正在检查稳定版本…')
    link.classList.add('hidden')
    try {
      const update = await call('update_check')
      $('update-state').textContent = update.available ? 'available' : 'latest'
      setStatus(
        $('update-detail'),
        update.available
          ? `发现 HarnessDock v${update.latestVersion}（当前 v${update.currentVersion}）。请打开发布页手动下载安装包；当前运行不会被打断。`
          : `当前已是最新稳定版本 v${update.currentVersion}。`,
      )
      if (update.available && update.releaseUrl) {
        link.href = update.releaseUrl
        link.classList.remove('hidden')
      }
    } catch (error) {
      $('update-state').textContent = 'error'
      setStatus($('update-detail'), message(error), true)
    } finally {
      button.disabled = false
    }
  }

  async function quit() {
    if (busy) return
    busy = true
    $('settings-quit').disabled = true
    setStatus($('runtime-detail'), '正在关闭 HarnessDock 及其全部后台进程…')
    try {
      await call('app_quit')
    } catch (error) {
      // The native process may exit before the IPC response is delivered.
      // Only render an error while the window is still alive.
      setStatus($('runtime-detail'), message(error), true)
      $('settings-quit').disabled = false
      busy = false
    }
  }

  $('settings-open-harness').addEventListener('click', openHarness)
  $('settings-refresh-web').addEventListener('click', refreshWeb)
  $('runtime-refresh').addEventListener('click', refresh)
  $('runtime-restart').addEventListener('click', () => restart(false))
  $('runtime-clear-restart').addEventListener('click', () => restart(true))
  $('runtime-stop').addEventListener('click', stop)
  $('update-check').addEventListener('click', checkUpdate)
  $('settings-quit').addEventListener('click', quit)
  $('settings-close').addEventListener('click', async () => {
    try { await call('shell_settings_close') } catch (error) { setStatus($('runtime-detail'), message(error), true) }
  })

  void refresh()
  window.setInterval(() => { if (!busy) void refresh() }, 4000)
})()
