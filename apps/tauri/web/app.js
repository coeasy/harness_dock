(() => {
  'use strict'
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

  function showRecoveryCards() {
    // A normal desktop user should never land in a mixed Runtime/Gateway
    // administration screen just because Harness Web failed to start. Keep
    // startup recovery focused on the broken local Runtime; the Gateway card
    // is exposed only from the explicit secondary control entry in healthy
    // desktop sessions.
    $('desktop-card')?.classList.remove('hidden')
    $('gateway-host-card')?.classList.add('hidden')
  }

  // The native startup coordinator calls this when Runtime or Harness Web
  // cannot become ready. Keeping the recovery renderer passive during normal
  // boot prevents it from stealing the first window, while this hook makes a
  // native failure immediately visible and actionable.
  window.__harnessDockShowRecovery = (error) => {
    showRecoveryCards()
    runtimeState.textContent = 'error'
    status(runtimeDetail, `Harness Web 启动失败，但 HarnessDock 仍在运行。\n${String(error || '请重试启动。')}`, true)
    bootStatus('启动失败，当前控制页仍可重试', 'error')
  }

  function status(element, value, bad = false) {
    if (!element) return
    element.textContent = value || ''
    element.classList.toggle('error', bad)
  }

  function bootStatus(value, state = 'loading') {
    const element = $('boot-status')
    if (!element) return
    element.className = `boot-status ${state}`
    element.querySelector('span:last-child').textContent = value
  }

  async function call(command, args) {
    const invoke = window.__TAURI__?.core?.invoke
    if (!invoke) throw new Error('Tauri IPC is unavailable. This page must run inside HarnessDock.')
    return invoke(command, args)
  }

  function splashStatus(value) {
    // The desktop splash is deliberately best-effort: a status paint failure
    // must never turn a healthy Runtime startup into recovery mode.
    return call('splash_status', { status: value }).catch(() => undefined)
  }

  function defaultDeviceName(platform) {
    const label = platform?.os || 'device'
    return `HarnessDock ${label}`
  }

  function runtimeDetailText(current) {
    if (!current?.appUrl) return 'Runtime 尚未启动。HarnessDock 主程序仍可用，可检查配置后重试。'
    const node = current.nodeSource ? `Node=${current.nodeSource}` : ''
    const base = [current.dshVersion || '', node, current.appUrl].filter(Boolean).join(' · ')
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
    $('shell-open-harness').disabled = !currentRuntime.appUrl
    if (!$('gateway-host-state')?.textContent?.includes('ready')) {
      $('gateway-host-start').disabled = !currentRuntime.appUrl
    }
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
        const label = device.name || device.id
        if (!window.confirm(`确认撤销设备“${label}”的 Gateway 会话？该设备需要重新配对才能连接。`)) return
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
    $('gateway-host-start').disabled = current.running || !currentRuntime?.appUrl
    $('gateway-public-url').disabled = current.running
    $('gateway-local-port').disabled = current.running
    if (!current.running) $('host-pairing').textContent = ''
    renderDevices(current.devices)
    return current
  }

  async function showControl() {
    try { await call('control_show') } catch { /* the window may already be visible */ }
  }
  async function openHarnessWithRetry(url, attempts = 3) {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await call('harness_open', { url })
        return
      } catch (error) {
        lastError = error
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        }
      }
    }
    throw lastError || new Error('无法打开 Harness Web 窗口。')
  }

  function autoStartDesktopRuntime() {
    if (desktopStartup) return desktopStartup
    desktopStartup = (async () => {
      $('runtime-start').disabled = true
      runtimeState.textContent = 'starting'
      bootStatus('正在启动本地 Runtime，界面保持可操作…')
      status(runtimeDetail, '正在启动 Harness Web Runtime…')
      void splashStatus('正在启动 Harness Runtime…')
      try {
        currentRuntime = await call('runtime_start')
        if (!currentRuntime?.appUrl) throw new Error('Runtime 已返回，但没有可打开的 Web 地址。')
        status(runtimeDetail, runtimeDetailText(currentRuntime))
        void splashStatus('正在打开 Harness Web…')
        await openHarnessWithRetry(currentRuntime.appUrl)
        bootStatus('Harness Web 已就绪', 'ready')
      } catch (error) {
        desktopStartup = undefined
        void splashStatus('启动失败，正在打开恢复入口…')
        window.__harnessDockShowRecovery?.(error)
        await showControl()
      } finally {
        // The promise only deduplicates one in-flight boot. Keep the button
        // usable after an explicit Runtime stop or a later crash recovery.
        desktopStartup = undefined
        $('runtime-start').disabled = false
      }
    })()
    return desktopStartup
  }

  async function refreshVisibleControl() {
    const runtimeVisible = !$('desktop-card')?.classList.contains('hidden')
    const gatewayVisible = !$('gateway-host-card')?.classList.contains('hidden')
    if (!runtimeVisible && !gatewayVisible) return
    try {
      await refreshRuntime()
      if (gatewayVisible) await refreshGatewayHost()
    } catch (error) {
      status(runtimeVisible ? runtimeDetail : hostDetail, String(error), true)
    }
  }

  async function boot() {
    try {
      void splashStatus('正在初始化客户端…')
      const platform = await call('platform_info')
      $('platform-summary').textContent = `${platform.os} / ${platform.arch} · ${platform.surface} · runtime=${platform.runtimeMode}`
      const desktop = platform.surface === 'desktop' && platform.runtimeMode === 'local'
      $('shell-settings-entry')?.classList.toggle('hidden', !desktop)
      $('shell-open-harness')?.classList.toggle('hidden', !desktop)
      const startupRecovery = await call('startup_recovery_status').catch(() => undefined)
      if (startupRecovery) {
        window.__harnessDockShowRecovery?.(startupRecovery)
        await showControl()
        return
      }
      if (platform.runtimeMode === 'local') {
        // Native startup owns the normal desktop path. The control window stays
        // hidden during normal launch, but its secondary Mobile Gateway card is
        // ready when the user explicitly opens this window from Shell/Tray.
        $('gateway-host-card')?.classList.remove('hidden')
        void splashStatus('正在准备本地 Runtime…')
        bootStatus('Harness Web 为主界面；此控制页仅在需要管理移动设备时打开。', 'ready')
      } else {
        bootStatus('Remote Gateway 模式已就绪', 'ready')
        $('mobile-remote-card').classList.remove('hidden')
        deviceName.value = defaultDeviceName(platform)
      }
    } catch (error) {
      bootStatus('运行环境检测失败，当前页面仍可操作', 'error')
      window.__harnessDockShowRecovery?.(error)
      status(runtimeDetail || gatewayDetail, String(error), true)
      await showControl()
    }
  }

  $('runtime-start').addEventListener('click', async () => {
    await autoStartDesktopRuntime()
  })

  $('shell-settings-entry').addEventListener('click', async () => {
    try {
      await call('shell_settings_show')
    } catch (error) {
      status($('shell-detail'), String(error), true)
    }
  })

  $('shell-open-harness').addEventListener('click', async () => {
    try {
      const current = await refreshRuntime()
      if (!current.appUrl) throw new Error('Runtime 尚未启动。')
      await openHarnessWithRetry(current.appUrl)
    } catch (error) {
      status($('shell-detail'), String(error), true)
    }
  })

  $('runtime-open').addEventListener('click', async () => {
    try {
      const current = await refreshRuntime()
      if (!current.appUrl) throw new Error('Runtime 尚未启动。')
      await openHarnessWithRetry(current.appUrl)
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
    const portInput = $('gateway-local-port')
    const publicInput = $('gateway-public-url')
    if (!portInput.reportValidity() || !publicInput.reportValidity()) return
    $('gateway-host-start').disabled = true
    status(hostDetail, '正在启动受控 Mobile Gateway…')
    let started = false
    try {
      const rawPort = Number(portInput.value)
      const publicUrl = publicInput.value.trim()
      await call('gateway_host_start', {
        publicUrl: publicUrl || null,
        localPort: Number.isInteger(rawPort) ? rawPort : 43137,
      })
      await refreshGatewayHost()
      started = true
    } catch (error) {
      hostState.textContent = 'error'
      status(hostDetail, String(error), true)
    } finally {
      // Do not undo refreshGatewayHost's running-state lock. The old logic
      // unconditionally re-enabled Start after a successful launch, making an
      // already-running Gateway look restartable with edited settings.
      if (!started) $('gateway-host-start').disabled = !currentRuntime?.appUrl
    }
  })

  $('gateway-host-refresh').addEventListener('click', async () => {
    try { await refreshGatewayHost() } catch (error) { status(hostDetail, String(error), true) }
  })

  $('gateway-host-stop').addEventListener('click', async () => {
    $('gateway-host-stop').disabled = true
    let refreshed = false
    try {
      await call('gateway_host_stop')
      $('host-pairing').textContent = ''
      await refreshGatewayHost()
      refreshed = true
    } catch (error) {
      status(hostDetail, String(error), true)
      // Re-read the native state after a failed stop. The command can fail
      // after the sidecar has already exited; leaving the button disabled
      // would strand the recovery control until the page is reopened.
      try {
        const current = await refreshGatewayHost()
        refreshed = true
        // A transient admin/IPC failure may leave a live sidecar in place.
        // Keep Stop retryable in that state instead of making the user rely
        // on a page reload or an unrelated refresh click.
        if (current.running) $('gateway-host-stop').disabled = false
      } catch {
        // The IPC bridge is unavailable; keep the recovery control usable.
      }
    } finally {
      if (!refreshed) $('gateway-host-stop').disabled = false
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
    if (!window.confirm('确认撤销全部已配对设备？所有设备都需要重新配对后才能再次连接。')) return
    $('gateway-revoke-all').disabled = true
    try {
      const count = await call('gateway_host_revoke_all')
      status(hostDetail, `已撤销 ${count} 个设备会话。`)
      await refreshGatewayHost()
    } catch (error) {
      status(hostDetail, String(error), true)
    } finally {
      $('gateway-revoke-all').disabled = false
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

  window.addEventListener('focus', () => {
    void refreshVisibleControl()
  })

  void boot()
})()
