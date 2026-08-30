(() => {
  'use strict'
  const invoke = window.__TAURI__?.core?.invoke
  const $ = (id) => document.getElementById(id)
  const desktopCard = $('desktop-card')
  const gatewayUrl = $('gateway-url')
  const pairingCode = $('pairing-code')
  const deviceName = $('device-name')
  const runtimeState = $('runtime-state')
  const runtimeDetail = $('runtime-detail')
  const gatewayState = $('gateway-state')
  const gatewayDetail = $('gateway-detail')

  function status(element, value, bad = false) {
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  function defaultDeviceName(platform) {
    const label = platform?.os || 'device'
    return `HarnessDock ${label}`
  }

  async function call(command, args) {
    if (!invoke) throw new Error('Tauri IPC is unavailable. This page must run inside HarnessDock.')
    return invoke(command, args)
  }

  async function refreshRuntime() {
    try {
      const current = await call('runtime_status')
      runtimeState.textContent = current.state
      status(runtimeDetail, current.appUrl ? `${current.dshVersion || ''} · ${current.appUrl}` : '')
    } catch (error) {
      runtimeState.textContent = 'error'
      status(runtimeDetail, String(error), true)
    }
  }

  async function boot() {
    try {
      const platform = await call('platform_info')
      $('platform-summary').textContent = `${platform.os} / ${platform.arch} · ${platform.surface} · runtime=${platform.runtimeMode}`
      deviceName.value = defaultDeviceName(platform)
      if (platform.runtimeMode === 'local') {
        desktopCard.classList.remove('hidden')
        await refreshRuntime()
      }
    } catch (error) {
      status(gatewayDetail, String(error), true)
    }
  }

  $('runtime-start').addEventListener('click', async () => {
    $('runtime-start').disabled = true
    status(runtimeDetail, '正在启动本地 Runtime…')
    try {
      const current = await call('runtime_start')
      runtimeState.textContent = current.state
      status(runtimeDetail, `${current.dshVersion || ''} · ${current.appUrl || ''}`)
      if (current.appUrl) window.location.assign(current.appUrl)
    } catch (error) {
      runtimeState.textContent = 'error'
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-start').disabled = false
    }
  })

  $('runtime-stop').addEventListener('click', async () => {
    $('runtime-stop').disabled = true
    try {
      await call('runtime_stop')
      await refreshRuntime()
    } catch (error) {
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-stop').disabled = false
    }
  })

  $('gateway-check').addEventListener('click', async () => {
    $('gateway-check').disabled = true
    status(gatewayDetail, '正在检查 Gateway…')
    try {
      const health = await call('gateway_health', { baseUrl: gatewayUrl.value })
      gatewayState.textContent = health.ok ? 'ready' : 'unhealthy'
      status(gatewayDetail, health.ok ? `Gateway 可用 · ${health.provider || 'remote'}` : 'Gateway 返回非健康状态', !health.ok)
    } catch (error) {
      gatewayState.textContent = 'offline'
      status(gatewayDetail, String(error), true)
    } finally {
      $('gateway-check').disabled = false
    }
  })

  $('gateway-pair').addEventListener('click', async () => {
    $('gateway-pair').disabled = true
    status(gatewayDetail, '正在验证一次性配对码…')
    try {
      const paired = await call('pair_gateway', {
        baseUrl: gatewayUrl.value,
        code: pairingCode.value,
        deviceName: deviceName.value,
      })
      gatewayState.textContent = 'paired'
      status(gatewayDetail, '配对成功，正在建立安全会话…')
      window.location.assign(paired.connectUrl)
    } catch (error) {
      gatewayState.textContent = 'error'
      status(gatewayDetail, String(error), true)
      $('gateway-pair').disabled = false
    }
  })

  void boot()
})()
