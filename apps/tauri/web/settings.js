(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let requestSequence = 0

  function call(command, args) {
    const invoke = window.__TAURI__?.core?.invoke
    if (typeof invoke !== 'function') return Promise.reject(new Error('Tauri IPC is unavailable.'))
    return invoke(command, args)
  }

  function host(commandType) {
    const requestId = globalThis.crypto?.randomUUID?.() || `diagnostics-${Date.now()}-${++requestSequence}`
    return call('host_execute', {
      envelope: {
        protocolVersion: 2,
        requestId,
        subject: 'diagnostics',
        command: { type: commandType },
      },
    }).then((response) => {
      if (response?.result?.Err) throw new Error(String(response.result.Err.message || 'Host command denied'))
      return response?.result?.Ok ?? response
    })
  }

  function message(value) {
    return String(value?.message || value || '未知错误')
  }

  function setStatus(element, value, bad = false) {
    if (!element) return
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  function publicRuntimeUrl(value) {
    if (!value) return ''
    try {
      const url = new URL(value)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return '[invalid runtime URL]'
    }
  }

  function runtimeDescription(runtime) {
    if (!runtime?.appUrl) return 'Runtime 尚未就绪。可从主界面菜单执行重启或隔离插件启动。'
    const lines = [
      '状态：' + (runtime.recoveryMode ? '兼容模式（Web 可用）' : runtime.state),
      'Node：' + (runtime.nodeSource || 'unknown'),
      '版本：' + (runtime.dshVersion || 'unknown'),
      '地址：' + publicRuntimeUrl(runtime.appUrl),
      'Generation：' + (runtime.generation ?? 'unknown'),
      'Runtime Image：' + (runtime.imageIdentity || 'unknown'),
    ]
    if (runtime.safeMode) lines.push('安全配置：已启用临时干净配置，未修改用户配置。')
    if (runtime.isolatedPlugins?.length) lines.push('已隔离插件：' + runtime.isolatedPlugins.join(', '))
    if (runtime.suspectedPlugins?.length) lines.push('疑似故障插件：' + runtime.suspectedPlugins.join(', '))
    return lines.join('\n')
  }

  function render(runtime) {
    const label = runtime?.recoveryMode ? 'degraded' : (runtime?.state || 'stopped')
    $('runtime-state').textContent = label
    setStatus($('runtime-detail'), runtimeDescription(runtime))
    setStatus(
      $('web-detail'),
      runtime?.appUrl
        ? 'Harness Web 正在使用安装包内置的 sealed Runtime；外壳、Tray、诊断或更新失败不会替代健康 Harness Web 主链。'
        : 'Runtime 尚未提供 Web 地址；可关闭诊断窗口后从主界面菜单重试。',
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
    setStatus($('runtime-detail'), '正在通过 Host Kernel 关闭 Runtime、Gateway 与客户端…')
    try {
      await host('quit')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
      $('settings-quit').disabled = false
    }
  }

  async function installUpdate() {
    const button = $('update-install')
    button.disabled = true
    setStatus($('update-detail'), '正在检查 GitHub 稳定 Release，并验证签名后安装可用更新…')
    try {
      await host('install-update')
      setStatus($('update-detail'), '更新检查已完成。若存在签名有效的新版本，客户端将完成安装并执行受管重启。')
    } catch (error) {
      setStatus($('update-detail'), message(error), true)
      button.disabled = false
    }
  }

  $('runtime-refresh').addEventListener('click', refresh)
  $('settings-quit').addEventListener('click', quit)
  $('update-install').addEventListener('click', installUpdate)
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
