(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)
  let requestSequence = 0
  let lastSequence = 0
  let unlistenHostEvent = null
  let snapshotRefreshPromise = null
  let snapshotRefreshPending = false
  let eventRefreshTimer = null

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

  function render(snapshot) {
    if (!snapshot) return
    const sequence = Number(snapshot.eventSequence || 0)
    if (!Number.isSafeInteger(sequence) || sequence < lastSequence) return
    lastSequence = sequence
    const phase = snapshot.runtimePhase || 'stopped'
    $('runtime-state').textContent = phase
    const lines = [
      `状态：${phase}`,
      `版本：${snapshot.runtimeDshVersion || 'unknown'}`,
      `Generation：${snapshot.runtimeGeneration ?? 'unknown'}`,
      `Runtime Image：${snapshot.runtimeImageIdentity || 'unknown'}`,
      `Host Protocol：v${snapshot.protocolVersion || 2}（最低兼容 v${snapshot.minCompatibleVersion || 2}）`,
      `Kernel Revision：${snapshot.revision ?? 0}`,
      `Event Sequence：${snapshot.eventSequence ?? 0}`,
    ]
    setStatus($('runtime-detail'), lines.join('\n'))
    setStatus(
      $('web-detail'),
      snapshot.harnessVisible
        ? 'Harness Web 主 Surface 已由 Host Kernel 管理；诊断、Gateway 或更新失败不会替代健康主链。'
        : 'Harness Web 当前不可见；可关闭诊断窗口后从原生菜单重新显示或恢复。',
    )
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
      // Host actors can emit several lifecycle events in one operation. Merge
      // bursts into one source-of-truth snapshot instead of starting an IPC
      // request and repaint for every event. A detected sequence gap gets an
      // immediate snapshot, while ordinary bursts settle for one animation
      // frame-sized delay.
      queueEventRefresh(lastSequence && sequence > lastSequence + 1 ? 0 : 80)
    })
  }

  $('runtime-refresh').addEventListener('click', () => { void refresh(true) })
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
      await refresh(true)
    } catch (error) {
      setStatus($('runtime-detail'), message(error), true)
    }
  })()
  window.addEventListener('pagehide', () => {
    window.clearTimeout(eventRefreshTimer)
    if (typeof unlistenHostEvent === 'function') unlistenHostEvent()
  }, { once: true })
})()