(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let requestSequence = 0
  let lastSequence = 0
  let unlistenHostEvent = null
  let snapshotRefreshPromise = null
  let snapshotRefreshPending = false
  let eventRefreshTimer = null
  let launchSettings = { profile: 'web', dshHome: null, startupPolicy: 'auto' }

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

  function setBusy(button, busy) {
    if (!button) return
    button.disabled = busy
    button.classList.toggle('is-busy', busy)
    button.setAttribute('aria-busy', String(busy))
  }

  function renderLaunchSettings(settings) {
    launchSettings = settings || launchSettings
    $('runtime-profile').value = launchSettings.profile || 'web'
    $('runtime-dsh-home').value = launchSettings.dshHome || ''
    $('runtime-startup-policy').value = launchSettings.startupPolicy || 'auto'
    $('profile-badge').textContent = `${launchSettings.profile || 'web'} / ${launchSettings.startupPolicy || 'auto'} · 已保存`
  }

  function render(snapshot) {
    if (!snapshot) return
    const sequence = Number(snapshot.eventSequence || 0)
    if (!Number.isSafeInteger(sequence) || sequence < lastSequence) return
    lastSequence = sequence
    const phase = snapshot.runtimePhase || 'stopped'
    const harnessVisible = Boolean(snapshot.harnessVisible)
    const runtimeHealthy = !['error', 'failed'].includes(String(phase).toLowerCase()) && phase !== 'stopped'
    $('runtime-state').textContent = phase
    $('runtime-badge').textContent = phase
    $('runtime-version').textContent = snapshot.runtimeDshVersion || 'unknown'
    $('web-state').textContent = harnessVisible ? '已连接' : '未显示'
    $('overall-state').textContent = harnessVisible && runtimeHealthy ? '运行正常' : '需要关注'
    $('overall-state').dataset.state = harnessVisible && runtimeHealthy ? 'ready' : 'attention'
    $('web-state').className = harnessVisible ? 'good' : 'attention'
    $('runtime-state').className = runtimeHealthy ? 'good' : 'attention'
    const lines = [
      `状态：${phase}`,
      `版本：${snapshot.runtimeDshVersion || 'unknown'}`,
      `已保存 Profile（下次启动）：${launchSettings.profile || 'web'}`,
      `已保存 Startup Policy（下次启动）：${launchSettings.startupPolicy || 'auto'}`,
      `已保存 DSH_HOME（下次启动）：${launchSettings.dshHome || 'default'}`,
      `Generation：${snapshot.runtimeGeneration ?? 'unknown'}`,
      `Runtime Image：${snapshot.runtimeImageIdentity || 'unknown'}`,
      `Host Protocol：v${snapshot.protocolVersion || 2}（最低兼容 v${snapshot.minCompatibleVersion || 2}）`,
      `Kernel Revision：${snapshot.revision ?? 0}`,
      `Event Sequence：${snapshot.eventSequence ?? 0}`,
    ]
    setStatus($('runtime-detail'), lines.join('\n'))
    setStatus(
      $('web-detail'),
      harnessVisible
        ? 'Harness Web 主 Surface 已由 Host Kernel 管理；诊断、Gateway 或更新失败不会替代健康主链。'
        : 'Harness Web 当前不可见；可关闭诊断窗口后从原生菜单重新显示或恢复。',
    )
  }

  async function loadLaunchSettings() {
    const settings = await call('runtime_launch_settings_get')
    renderLaunchSettings(settings)
    return settings
  }

  async function saveLaunchSettings() {
    const button = $('runtime-settings-save')
    setBusy(button, true)
    setStatus($('runtime-settings-detail'), '正在验证并保存启动配置…')
    try {
      const settings = await call('runtime_launch_settings_set', {
        settings: {
          profile: $('runtime-profile').value.trim(),
          dshHome: $('runtime-dsh-home').value.trim() || null,
          startupPolicy: $('runtime-startup-policy').value,
        },
      })
      renderLaunchSettings(settings)
      setStatus($('runtime-settings-detail'), '已保存。当前 Runtime generation 不会被热切换；配置将在下一次 Runtime 启动或重启时生效。')
      await refresh(false)
    } catch (error) {
      setStatus($('runtime-settings-detail'), message(error), true)
    } finally {
      setBusy(button, false)
    }
  }

  function queueEventRefresh(delay = 80) {
    window.clearTimeout(eventRefreshTimer)
    eventRefreshTimer = window.setTimeout(() => {
      eventRefreshTimer = null
      void refresh(false)
    }, delay)
  }

  async function refresh(showBusy = true) {
    if (snapshotRefreshPromise) {
      snapshotRefreshPending = true
      return snapshotRefreshPromise
    }
    const button = $('runtime-refresh')
    if (showBusy) setBusy(button, true)
    snapshotRefreshPromise = (async () => {
      try {
        render(await call('host_snapshot'))
      } catch (error) {
        setStatus($('runtime-detail'), message(error), true)
      }
    })()
    try {
      await snapshotRefreshPromise
    } finally {
      snapshotRefreshPromise = null
      if (showBusy) setBusy(button, false)
      if (snapshotRefreshPending) {
        snapshotRefreshPending = false
        queueEventRefresh(0)
      }
    }
  }

  async function quit() {
    const button = $('settings-quit')
    setBusy(button, true)
    setStatus($('runtime-detail'), '正在通过 Host Kernel 关闭 Runtime、Gateway 与客户端…')
    try {
      await host('quit')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
      setBusy(button, false)
    }
  }

  async function installUpdate() {
    const button = $('update-install')
    setBusy(button, true)
    setStatus($('update-detail'), '正在检查稳定 Release，并验证签名后安装可用更新…')
    try {
      await host('install-update')
      setStatus($('update-detail'), '更新操作已交给 UpdateActor；状态变化将通过 HostEvent 推送。')
    } catch (error) {
      setStatus($('update-detail'), message(error), true)
    } finally {
      setBusy(button, false)
    }
  }

  async function subscribe() {
    const listen = window.__TAURI__?.event?.listen
    if (typeof listen !== 'function') return
    unlistenHostEvent = await listen('harnessdock://host-event', (event) => {
      const payload = event?.payload || {}
      const sequence = Number(payload.sequence || 0)
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequence) return
      queueEventRefresh(lastSequence && sequence > lastSequence + 1 ? 0 : 80)
    })
  }

  $('runtime-refresh').addEventListener('click', () => { void refresh(true) })
  $('runtime-settings-save').addEventListener('click', () => { void saveLaunchSettings() })
  $('settings-quit').addEventListener('click', quit)
  $('update-install').addEventListener('click', installUpdate)
  $('settings-close').addEventListener('click', async () => {
    const button = $('settings-close')
    setBusy(button, true)
    try {
      await call('diagnostics_close')
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
      setBusy(button, false)
    }
  })

  void (async () => {
    try {
      await subscribe()
      await loadLaunchSettings()
      await refresh(true)
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  })()

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    void call('diagnostics_close')
  })
  window.addEventListener('pagehide', () => {
    window.clearTimeout(eventRefreshTimer)
    if (typeof unlistenHostEvent === 'function') unlistenHostEvent()
  }, { once: true })
})()
