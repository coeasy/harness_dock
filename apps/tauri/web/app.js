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
  let desktopStartup

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

  function runtimeDetailText(current) {
    if (!current?.appUrl) return 'Runtime 尚未启动。HarnessDock 主程序仍可用，可检查配置后重试。'
    const base = `${current.dshVersion || ''} · ${current.appUrl}`
    if (!current.recoveryMode) return base
    if (current.recoverySource === 'safe-profile') {
      return `${base}\n安全启动：已绕过用户插件配置，确保 Harness Web 界面可用。用户配置未修改；可在修复插件后停止并重新启动 Runtime。`
    }
    const plugins = Array.isArray(current.isolatedPlugins) ? current.isolatedPlugins : []
    const suspects = Array.isArray(current.suspectedPlugins) ? current.suspectedPlugins : []
    const isolated = plugins.length > 0 ? plugins.join(', ') : '未知第三方插件'
    const suspected = suspects.length > 0 ? suspects.join(', ') : '诊断未能唯一定位'
    const source = current.recoverySource === 'quarantine' ? '已验证隔离记录' : '本次启动故障恢复'
    const expiry = Number(current.quarantineExpiresAt) > 0
      ? new Date(Number(current.quarantineExpiresAt) * 1000).toLocaleString()
      : '当前会话结束后失效'
    return `${base}\n兼容模式：${source}\n已隔离：${isolated}\n疑似故障插件：${suspected}\n隔离有效期：${expiry}\n用户 DSH 配置未被修改；可清除隔离后在下次启动重新尝试完整插件配置。`
  }

  async function refreshRuntime() {
    currentRuntime = await call('runtime_status')
    runtimeState.textContent = currentRuntime.recoveryMode ? 'degraded · plugin recovery' : currentRuntime.state
    status(runtimeDetail, runtimeDetailText(currentRuntime))
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

  async function showControl() {
    try { await call('control_show') } catch { /* the window may already be visible */ }
  }

  function autoStartDesktopRuntime() {
    if (desktopStartup) return desktopStartup
    desktopStartup = (async () => {
      $('runtime-start').disabled = true
      runtimeState.textContent = 'starting'
      status(runtimeDetail, '正在启动 Harness Web Runtime…')
      try {
        currentRuntime = await call('runtime_start')
        if (!currentRuntime?.appUrl) throw new Error('Runtime 已返回，但没有可打开的 Web 地址。')
        status(runtimeDetail, runtimeDetailText(currentRuntime))
        await call('harness_open', { url: currentRuntime.appUrl })
      } catch (error) {
        desktopStartup = undefined
        runtimeState.textContent = 'error'
        status(runtimeDetail, `Harness Web Runtime 启动失败，但控制页仍可用。\n${String(error)}`, true)
        await showControl()
      } finally {
        $('runtime-start').disabled = false
      }
    })()
    return desktopStartup
  }

  async function boot() {
    try {
      const platform = await call('platform_info')
      $('platform-summary').textContent = `${platform.os} / ${platform.arch} · ${platform.surface} · runtime=${platform.runtimeMode}`
      if (platform.runtimeMode === 'local') {
        $('desktop-card').classList.remove('hidden')
        $('gateway-host-card').classList.remove('hidden')
        await autoStartDesktopRuntime()
        await refreshGatewayHost().catch((error) => status(hostDetail, String(error), true))
      } else {
        $('mobile-remote-card').classList.remove('hidden')
        deviceName.value = defaultDeviceName(platform)
      }
    } catch (error) {
      status(runtimeDetail || gatewayDetail, String(error), true)
      await showControl()
    }
  }

  $('runtime-start').addEventListener('click', async () => {
    await autoStartDesktopRuntime()
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
      desktopStartup = undefined
      await refreshRuntime()
      await refreshGatewayHost()
    } catch (error) {
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-stop').disabled = false
    }
  })

  $('runtime-clear-quarantine').addEventListener('click', async () => {
    $('runtime-clear-quarantine').disabled = true
    try {
      await call('runtime_clear_plugin_quarantine')
      status(runtimeDetail, '已清除持久化插件隔离记录。当前运行会话保持不变；下次启动会重新尝试完整插件配置。')
    } catch (error) {
      status(runtimeDetail, String(error), true)
    } finally {
      $('runtime-clear-quarantine').disabled = false
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
