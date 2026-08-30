(() => {
  'use strict'
  const invoke = window.__TAURI__?.core?.invoke
  const $ = (id) => document.getElementById(id)
  const runtimeState = $('runtime-state')
  const runtimeDetail = $('runtime-detail')
  const hostState = $('gateway-host-state')
  const hostDetail = $('gateway-host-detail')
  const gatewayState = $('gateway-state')
  const gatewayDetail = $('gateway-detail')
  const gatewayUrl = $('gateway-url')
  const pairingCode = $('pairing-code')
  const deviceName = $('device-name')
  let currentRuntime

  function status(element, value, bad = false) {
    if (!element) return
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  async function call(command, args) {
    if (!invoke) throw new Error('Tauri IPC is unavailable. This page must run inside HarnessDock.')
    return invoke(command, args)
  }

  function defaultDeviceName(platform) {
    const label = platform?.os || 'device'
    return `HarnessDock ${label}`
  }

  async function refreshRuntime() {
    currentRuntime = await call('runtime_status')
    runtimeState.textContent = currentRuntime.state
    status(runtimeDetail, currentRuntime.appUrl ? `${currentRuntime.dshVersion || ''} · ${currentRuntime.appUrl}` : 'Runtime 尚未启动。')
    $('runtime-open').disabled = !currentRuntime.appUrl
    $('gateway-host-start').disabled = !currentRuntime.appUrl
    return currentRuntime
  }

  function renderDevices(devices) {
    const root = $('gateway-devices')
    root.textContent = ''
    if (!Array.isArray(devices) || devices.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = '暂无已配对设备。'
      root.appendChild(empty)
      return
    }
    for (const device of devices) {
      const row = document.createElement('div')
      row.className = 'device'
      const left = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'device-name'
      name.textContent = device.name || device.id
      const meta = document.createElement('div')
      meta.className = 'device-meta'
      meta.textContent = `最后活动 ${new Date(device.lastSeenAt).toLocaleString()} · 会话到期 ${new Date(device.sessionExpiresAt).toLocaleString()}`
      left.append(name, meta)
      const revoke = document.createElement('button')
      revoke.className = 'danger'
      revoke.textContent = '撤销'
      revoke.addEventListener('click', async () => {
        revoke.disabled = true
        try {
          await call('gateway_host_revoke', { deviceId: device.id })
          await refreshGatewayHost()
        } catch (error) {
          status(hostDetail, String(error), true)
          revoke.disabled = false
        }
      })
      row.append(left, revoke)
      root.appendChild(row)
    }
  }

  async function refreshGatewayHost() {
    const current = await call('gateway_host_status')
    hostState.textContent = current.running ? 'ready' : 'stopped'
    status(hostDetail, current.running ? `Local ${current.localUrl || '-'}\nPublic ${current.publicUrl || '-'}` : 'Gateway 尚未启动。')
    $('gateway-create-pairing').disabled = !current.running
    $('gateway-revoke-all').disabled = !current.running || !current.devices?.length
    $('gateway-host-stop').disabled = !current.running
    renderDevices(current.devices)
    return current
  }

  async function boot() {
    try {
      const platform = await call('platform_info')
      $('platform-summary').textContent = `${platform.os} / ${platform.arch} · ${platform.surface} · runtime=${platform.runtimeMode}`
      if (platform.runtimeMode === 'local') {
        $('desktop-card').classList.remove('hidden')
        $('gateway-host-card').classList.remove('hidden')
        await refreshRuntime()
        await refreshGatewayHost()
      } else {
        $('mobile-remote-card').classList.remove('hidden')
        deviceName.value = defaultDeviceName(platform)
      }
    } catch (error) {
      status(runtimeDetail || gatewayDetail, String(error), true)
    }
  }

  $('runtime-start').addEventListener('click', async () => {
    $('runtime-start').disabled = true
    status(runtimeDetail, '正在启动本地 Runtime…')
    try {
      currentRuntime = await call('runtime_start')
      await refreshRuntime()
      if (currentRuntime.appUrl) await call('harness_open', { url: currentRuntime.appUrl })
    } catch (error) {
      runtimeState.textContent = 'error'
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-start').disabled = false
    }
  })

  $('runtime-open').addEventListener('click', async () => {
    try {
      const current = await refreshRuntime()
      if (!current.appUrl) throw new Error('Runtime 尚未启动。')
      await call('harness_open', { url: current.appUrl })
    } catch (error) {
      status(runtimeDetail, String(error), true)
    }
  })

  $('runtime-stop').addEventListener('click', async () => {
    $('runtime-stop').disabled = true
    try {
      await call('gateway_host_stop').catch(() => undefined)
      await call('harness_close').catch(() => undefined)
      await call('runtime_stop')
      await refreshRuntime()
      await refreshGatewayHost()
    } catch (error) {
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-stop').disabled = false
    }
  })

  $('gateway-host-start').addEventListener('click', async () => {
    $('gateway-host-start').disabled = true
    status(hostDetail, '正在启动受控 Mobile Gateway…')
    try {
      const rawPort = Number($('gateway-local-port').value)
      const publicUrl = $('gateway-public-url').value.trim()
      await call('gateway_host_start', {
        publicUrl: publicUrl || null,
        localPort: Number.isInteger(rawPort) ? rawPort : 43137,
      })
      await refreshGatewayHost()
    } catch (error) {
      hostState.textContent = 'error'
      status(hostDetail, String(error), true)
    } finally {
      $('gateway-host-start').disabled = false
    }
  })

  $('gateway-host-refresh').addEventListener('click', async () => {
    try { await refreshGatewayHost() } catch (error) { status(hostDetail, String(error), true) }
  })

  $('gateway-host-stop').addEventListener('click', async () => {
    $('gateway-host-stop').disabled = true
    try {
      await call('gateway_host_stop')
      $('host-pairing').textContent = ''
      await refreshGatewayHost()
    } catch (error) {
      status(hostDetail, String(error), true)
    }
  })

  $('gateway-create-pairing').addEventListener('click', async () => {
    $('gateway-create-pairing').disabled = true
    try {
      const ticket = await call('gateway_host_create_pairing')
      $('host-pairing').textContent = `${ticket.code} · ${new Date(ticket.expiresAt).toLocaleString()}`
      await refreshGatewayHost()
    } catch (error) {
      status(hostDetail, String(error), true)
    } finally {
      $('gateway-create-pairing').disabled = false
    }
  })

  $('gateway-revoke-all').addEventListener('click', async () => {
    $('gateway-revoke-all').disabled = true
    try {
      const count = await call('gateway_host_revoke_all')
      status(hostDetail, `已撤销 ${count} 个设备会话。`)
      await refreshGatewayHost()
    } catch (error) {
      status(hostDetail, String(error), true)
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
