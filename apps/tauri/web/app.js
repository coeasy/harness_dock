(() => {
  'use strict'
  const $ = (id) => document.getElementById(id)

  function publicText(value) {
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

  function safeDisplayUrl(value) {
    if (!value) return ''
    try {
      const url = new URL(String(value))
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return publicText(value)
    }
  }

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
  let surfaceMode = 'hidden'
  let refreshInFlight = null
  let refreshAgain = false
  let refreshTimer = null

  const statusHoldUntil = new WeakMap()
  const confirmations = new WeakMap()
  const operationBusy = new Set()
  const operationGroups = Object.freeze({
    'runtime-lifecycle': ['runtime-start', 'runtime-stop', 'runtime-clear-quarantine'],
    'gateway-admin': ['gateway-host-start', 'gateway-host-refresh', 'gateway-host-stop', 'gateway-create-pairing', 'gateway-revoke-all'],
    'remote-gateway': ['gateway-check', 'gateway-pair'],
  })

  function status(element, value, bad = false, force = false) {
    if (!element) return
    const now = Date.now()
    const holdUntil = statusHoldUntil.get(element) || 0
    if (!bad && !force && now < holdUntil) return
    element.textContent = bad ? publicText(value) : (value || '')
    element.classList.toggle('error', bad)
    if (bad) statusHoldUntil.set(element, now + 4800)
    else if (force) statusHoldUntil.delete(element)
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
    return call('splash_status', { status: value }).catch(() => undefined)
  }

  function groupElements(group) {
    const ids = operationGroups[group] || []
    const fixed = ids.map((id) => $(id)).filter(Boolean)
    const dynamic = [...document.querySelectorAll(`[data-operation-group="${group}"]`)]
    return [...new Set([...fixed, ...dynamic])]
  }

  function applyOperationLocks() {
    for (const group of Object.keys(operationGroups)) {
      if (!operationBusy.has(group)) continue
      for (const element of groupElements(group)) {
        element.disabled = true
        element.classList.add('is-busy')
        element.setAttribute('aria-busy', 'true')
      }
    }
  }

  function releaseOperationPresentation(group) {
    for (const element of groupElements(group)) {
      element.classList.remove('is-busy')
      element.removeAttribute('aria-busy')
    }
  }

  async function withOperation(group, task, restore) {
    if (operationBusy.has(group)) return undefined
    operationBusy.add(group)
    applyOperationLocks()
    try {
      return await task()
    } finally {
      operationBusy.delete(group)
      releaseOperationPresentation(group)
      if (restore) {
        try { await restore() } catch { /* action result remains visible */ }
      }
      applyOperationLocks()
    }
  }

  function restoreConfirmation(button) {
    const current = confirmations.get(button)
    if (!current) return
    window.clearTimeout(current.timer)
    button.textContent = current.label
    button.classList.remove('confirming')
    if (current.ariaLabel === null) button.removeAttribute('aria-label')
    else button.setAttribute('aria-label', current.ariaLabel)
    confirmations.delete(button)
  }

  function confirmSecondClick(button, prompt, confirmLabel = '再次点击确认') {
    if (confirmations.has(button)) {
      restoreConfirmation(button)
      return true
    }
    const label = button.textContent
    const ariaLabel = button.getAttribute('aria-label')
    button.textContent = confirmLabel
    button.classList.add('confirming')
    button.setAttribute('aria-label', `${prompt}；再次点击确认`)
    const timer = window.setTimeout(() => restoreConfirmation(button), 4200)
    confirmations.set(button, { label, ariaLabel, timer })
    status(hostDetail, `${prompt}\n请在 4 秒内再次点击“${confirmLabel}”。`, false, true)
    return false
  }

  function defaultDeviceName(platform) {
    const label = platform?.os || 'device'
    return `HarnessDock ${label}`
  }

  function runtimeDetailText(current) {
    if (!current?.appUrl) return 'Runtime 尚未启动。HarnessDock 主程序仍可用，可检查配置后重试。'
    const base = [current.dshVersion || '', safeDisplayUrl(current.appUrl)].filter(Boolean).join(' · ')
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
    const running = Boolean(currentRuntime.appUrl) && !['stopped', 'error'].includes(String(currentRuntime.state || '').toLowerCase())
    $('runtime-start').disabled = running
    $('runtime-stop').disabled = !running
    $('runtime-open').disabled = !currentRuntime.appUrl
    $('shell-open-harness').disabled = !currentRuntime.appUrl
    if (!$('gateway-host-state')?.textContent?.includes('ready')) {
      $('gateway-host-start').disabled = !currentRuntime.appUrl
    }
    applyOperationLocks()
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
      revoke.dataset.operationGroup = 'gateway-admin'
      revoke.disabled = operationBusy.has('gateway-admin')
      revoke.addEventListener('click', async () => {
        const label = device.name || device.id
        if (!confirmSecondClick(revoke, `确认撤销设备“${label}”的 Gateway 会话？该设备需要重新配对才能连接。`, '确认撤销')) return
        try {
          await withOperation('gateway-admin', async () => {
            status(hostDetail, `正在撤销设备“${label}”…`, false, true)
            await call('gateway_host_revoke', { deviceId: device.id })
            status(hostDetail, `设备“${label}”已撤销。`, false, true)
          }, refreshGatewayHost)
        } catch (error) {
          status(hostDetail, String(error), true)
        }
      })
      row.append(left, revoke)
      root.appendChild(row)
    }
  }

  async function refreshGatewayHost() {
    const current = await call('gateway_host_status')
    hostState.textContent = current.running ? 'ready' : 'stopped'
    status(hostDetail, current.running
      ? `Local ${safeDisplayUrl(current.localUrl) || '-'}\nPublic ${safeDisplayUrl(current.publicUrl) || '-'}`
      : 'Gateway 尚未启动。')
    $('gateway-create-pairing').disabled = !current.running
    $('gateway-revoke-all').disabled = !current.running || !current.devices?.length
    $('gateway-host-stop').disabled = !current.running
    $('gateway-host-start').disabled = current.running || !currentRuntime?.appUrl
    $('gateway-public-url').disabled = current.running
    $('gateway-local-port').disabled = current.running
    if (!current.running) $('host-pairing').textContent = ''
    renderDevices(current.devices)
    applyOperationLocks()
    return current
  }

  function setSurfaceMode(mode) {
    surfaceMode = mode
    const visibility = {
      recovery: ['desktop-card'],
      'gateway-host': ['gateway-host-card'],
      'mobile-remote': ['mobile-remote-card'],
      hidden: [],
    }
    const visible = new Set(visibility[mode] || [])
    for (const id of ['desktop-card', 'gateway-host-card', 'mobile-remote-card']) {
      $(id)?.classList.toggle('hidden', !visible.has(id))
    }
  }

  function showRecoveryCards() {
    setSurfaceMode('recovery')
  }

  window.__harnessDockSetSurface = (mode) => {
    if (!['recovery', 'gateway-host', 'mobile-remote', 'hidden'].includes(mode)) return
    setSurfaceMode(mode)
    if (mode === 'gateway-host') scheduleVisibleRefresh()
  }

  window.__harnessDockShowRecovery = (error) => {
    showRecoveryCards()
    runtimeState.textContent = 'error'
    status(runtimeDetail, `Harness Web 启动失败，但 HarnessDock 仍在运行。\n${String(error || '请重试启动。')}`, true)
    bootStatus('启动失败，当前控制页仍可重试', 'error')
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
    desktopStartup = withOperation('runtime-lifecycle', async () => {
      runtimeState.textContent = 'starting'
      bootStatus('正在启动本地 Runtime，界面保持可操作…')
      status(runtimeDetail, '正在启动 Harness Web Runtime…', false, true)
      void splashStatus('正在启动 Harness Runtime…')
      try {
        currentRuntime = await call('runtime_start')
        if (!currentRuntime?.appUrl) throw new Error('Runtime 已返回，但没有可打开的 Web 地址。')
        status(runtimeDetail, runtimeDetailText(currentRuntime), false, true)
        void splashStatus('正在打开 Harness Web…')
        await openHarnessWithRetry(currentRuntime.appUrl)
        bootStatus('Harness Web 已就绪', 'ready')
      } catch (error) {
        void splashStatus('启动失败，正在打开恢复入口…')
        window.__harnessDockShowRecovery?.(error)
        await showControl()
        throw error
      }
    }, refreshRuntime).finally(() => {
      desktopStartup = undefined
    })
    return desktopStartup
  }

  async function performVisibleRefresh() {
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

  function refreshVisibleControl() {
    if (refreshInFlight) {
      refreshAgain = true
      return refreshInFlight
    }
    refreshInFlight = (async () => {
      do {
        refreshAgain = false
        await performVisibleRefresh()
      } while (refreshAgain)
    })().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  function scheduleVisibleRefresh(delay = 120) {
    window.clearTimeout(refreshTimer)
    refreshTimer = window.setTimeout(() => {
      void refreshVisibleControl()
    }, delay)
  }

  async function boot() {
    try {
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
        setSurfaceMode('gateway-host')
        bootStatus('Harness Web 为主界面；此控制页仅在需要管理移动设备时打开。', 'ready')
        await refreshVisibleControl()
      } else {
        bootStatus('Remote Gateway 模式已就绪', 'ready')
        setSurfaceMode('mobile-remote')
        deviceName.value = defaultDeviceName(platform)
      }
    } catch (error) {
      bootStatus('Harness Web 启动状态读取失败，当前页面仍可操作', 'error')
      window.__harnessDockShowRecovery?.(error)
      status(runtimeDetail || gatewayDetail, String(error), true)
      await showControl()
    }
  }

  $('runtime-start').addEventListener('click', async () => {
    try { await autoStartDesktopRuntime() } catch { /* recovery surface already owns the error */ }
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
    try {
      await withOperation('runtime-lifecycle', async () => {
        status(runtimeDetail, '正在停止 Runtime 与关联 Gateway…', false, true)
        await call('gateway_host_stop').catch(() => undefined)
        await call('harness_close').catch(() => undefined)
        await call('runtime_stop')
        desktopStartup = undefined
        status(runtimeDetail, 'Runtime 已停止。HarnessDock 主程序仍可继续使用。', false, true)
      }, async () => {
        await refreshRuntime()
        await refreshGatewayHost().catch(() => undefined)
      })
    } catch (error) {
      status(runtimeDetail, String(error), true)
    }
  })

  $('runtime-clear-quarantine').addEventListener('click', async () => {
    try {
      await withOperation('runtime-lifecycle', async () => {
        status(runtimeDetail, '正在清除插件隔离记录…', false, true)
        await call('runtime_clear_plugin_quarantine')
        status(runtimeDetail, '已清除持久化插件隔离记录。当前运行会话保持不变；下次启动会重新尝试完整插件配置。', false, true)
      }, refreshRuntime)
    } catch (error) {
      status(runtimeDetail, String(error), true)
    }
  })

  $('gateway-host-start').addEventListener('click', async () => {
    const portInput = $('gateway-local-port')
    const publicInput = $('gateway-public-url')
    if (!portInput.reportValidity() || !publicInput.reportValidity()) return
    try {
      await withOperation('gateway-admin', async () => {
        status(hostDetail, '正在启动受控 Mobile Gateway…', false, true)
        const rawPort = Number(portInput.value)
        const publicUrl = publicInput.value.trim()
        await call('gateway_host_start', {
          publicUrl: publicUrl || null,
          localPort: Number.isInteger(rawPort) ? rawPort : 43137,
        })
        status(hostDetail, 'Mobile Gateway 已启动。', false, true)
      }, refreshGatewayHost)
    } catch (error) {
      hostState.textContent = 'error'
      status(hostDetail, String(error), true)
    }
  })

  $('gateway-host-refresh').addEventListener('click', async () => {
    if (operationBusy.has('gateway-admin')) return
    try { await refreshGatewayHost() } catch (error) { status(hostDetail, String(error), true) }
  })

  $('gateway-host-stop').addEventListener('click', async () => {
    try {
      await withOperation('gateway-admin', async () => {
        status(hostDetail, '正在停止 Mobile Gateway…', false, true)
        await call('gateway_host_stop')
        $('host-pairing').textContent = ''
        status(hostDetail, 'Mobile Gateway 已停止。', false, true)
      }, refreshGatewayHost)
    } catch (error) {
      status(hostDetail, String(error), true)
      scheduleVisibleRefresh(0)
    }
  })

  $('gateway-create-pairing').addEventListener('click', async () => {
    try {
      await withOperation('gateway-admin', async () => {
        status(hostDetail, '正在生成一次性配对码…', false, true)
        const ticket = await call('gateway_host_create_pairing')
        $('host-pairing').textContent = `${ticket.code} · ${new Date(ticket.expiresAt).toLocaleString()}`
        status(hostDetail, '一次性配对码已生成。', false, true)
      }, refreshGatewayHost)
    } catch (error) {
      status(hostDetail, String(error), true)
    }
  })

  $('gateway-revoke-all').addEventListener('click', async () => {
    const button = $('gateway-revoke-all')
    if (!confirmSecondClick(button, '确认撤销全部已配对设备？所有设备都需要重新配对后才能再次连接。', '确认全部撤销')) return
    try {
      await withOperation('gateway-admin', async () => {
        status(hostDetail, '正在撤销全部设备会话…', false, true)
        const count = await call('gateway_host_revoke_all')
        status(hostDetail, `已撤销 ${count} 个设备会话。`, false, true)
      }, refreshGatewayHost)
    } catch (error) {
      status(hostDetail, String(error), true)
    }
  })

  $('gateway-check').addEventListener('click', async () => {
    try {
      await withOperation('remote-gateway', async () => {
        status(gatewayDetail, '正在检查 Gateway…', false, true)
        const health = await call('gateway_health', { baseUrl: gatewayUrl.value })
        gatewayState.textContent = health.ok ? 'ready' : 'unhealthy'
        status(gatewayDetail, health.ok ? `Gateway 可用 · ${health.provider || 'remote'}` : 'Gateway 返回非健康状态', !health.ok, true)
      })
    } catch (error) {
      gatewayState.textContent = 'offline'
      status(gatewayDetail, String(error), true)
    }
  })

  $('gateway-pair').addEventListener('click', async () => {
    try {
      await withOperation('remote-gateway', async () => {
        status(gatewayDetail, '正在验证一次性配对码…', false, true)
        const paired = await call('pair_gateway', {
          baseUrl: gatewayUrl.value,
          code: pairingCode.value,
          deviceName: deviceName.value,
        })
        gatewayState.textContent = 'paired'
        status(gatewayDetail, '配对成功，正在建立安全会话…', false, true)
        window.location.assign(paired.connectUrl)
      })
    } catch (error) {
      gatewayState.textContent = 'error'
      status(gatewayDetail, String(error), true)
    }
  })

  window.addEventListener('focus', () => scheduleVisibleRefresh())
  window.addEventListener('pagehide', () => window.clearTimeout(refreshTimer), { once: true })

  void boot()
})()