(() => {
  'use strict'

  const tauri = window.__TAURI__
  const invoke = tauri?.core?.invoke
  const $ = (id) => document.getElementById(id)
  const state = { platform: null, runtimeUrl: '', gateway: null }

  function fail(error) {
    const panel = $('error-panel')
    panel.textContent = error instanceof Error ? error.message : String(error)
    panel.classList.remove('hidden')
  }
  function clearError() { $('error-panel').classList.add('hidden') }
  function setBusy(button, busy, text) {
    if (!button) return
    if (!button.dataset.label) button.dataset.label = button.textContent
    button.disabled = busy
    button.textContent = busy ? text : button.dataset.label
  }
  function normalizeUrl(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const url = new URL(raw)
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.toString()
  }
  function saved(key, fallback = '') { return localStorage.getItem(`harnessdock:${key}`) || fallback }
  function save(key, value) { localStorage.setItem(`harnessdock:${key}`, value) }

  async function call(command, args = {}) {
    if (!invoke) throw new Error('Tauri bridge is unavailable. Run this launcher inside HarnessDock.')
    return invoke(command, args)
  }

  async function refreshRuntime() {
    const status = await call('runtime_status')
    state.runtimeUrl = status.appUrl || ''
    $('runtime-status').textContent = status.state
    $('runtime-detail').textContent = status.message || status.appUrl || 'Runtime has not started.'
    $('runtime-open').disabled = !state.runtimeUrl
    $('runtime-stop').disabled = !state.runtimeUrl
    $('gateway-start').disabled = !state.runtimeUrl || Boolean(state.gateway)
    return status
  }

  async function startRuntime() {
    clearError()
    const button = $('runtime-start')
    setBusy(button, true, 'Starting…')
    try {
      const result = await call('start_local_runtime')
      state.runtimeUrl = result.appUrl
      await refreshRuntime()
    } catch (error) { fail(error) }
    finally { setBusy(button, false, '') }
  }

  async function stopRuntime() {
    clearError()
    try {
      await stopGateway()
      await call('stop_local_runtime')
      state.runtimeUrl = ''
      await refreshRuntime()
    } catch (error) { fail(error) }
  }

  function openRuntime() {
    if (state.runtimeUrl) window.location.assign(state.runtimeUrl)
  }

  async function startGateway() {
    clearError()
    const button = $('gateway-start')
    setBusy(button, true, 'Starting…')
    try {
      const bindHost = $('gateway-bind').value.trim() || '127.0.0.1'
      const port = Number.parseInt($('gateway-port').value.trim(), 10)
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Gateway port must be between 0 and 65535.')
      const publicUrl = normalizeUrl($('gateway-public').value)
      const allowInsecure = $('gateway-insecure').checked
      state.gateway = await call('start_gateway', { bindHost, port, publicUrl, allowInsecure })
      $('gateway-status').textContent = 'ready'
      $('gateway-start').disabled = true
      $('gateway-stop').disabled = false
      $('gateway-pair').disabled = false
      $('gateway-refresh').disabled = false
      save('gatewayPublic', publicUrl)
      await refreshDevices()
    } catch (error) { fail(error) }
    finally { setBusy(button, false, '') }
  }

  async function stopGateway() {
    if (!state.gateway) return
    await call('stop_gateway')
    state.gateway = null
    $('gateway-status').textContent = 'stopped'
    $('gateway-start').disabled = !state.runtimeUrl
    $('gateway-stop').disabled = true
    $('gateway-pair').disabled = true
    $('gateway-refresh').disabled = true
    $('pairing-card').classList.add('hidden')
    $('device-list').textContent = ''
  }

  async function createPairing() {
    clearError()
    try {
      const ticket = await call('gateway_create_pairing')
      $('pairing-code').textContent = ticket.code
      $('pairing-expiry').textContent = `Expires ${new Date(ticket.expiresAt).toLocaleString()}`
      $('pairing-card').classList.remove('hidden')
      await navigator.clipboard?.writeText(ticket.code).catch(() => undefined)
    } catch (error) { fail(error) }
  }

  async function refreshDevices() {
    clearError()
    try {
      const devices = await call('gateway_devices')
      const root = $('device-list')
      root.textContent = ''
      if (!devices.length) {
        const empty = document.createElement('div')
        empty.className = 'muted'
        empty.textContent = 'No paired mobile sessions.'
        root.appendChild(empty)
        return
      }
      for (const device of devices) {
        const row = document.createElement('div')
        row.className = 'device'
        const left = document.createElement('div')
        const title = document.createElement('strong')
        title.textContent = device.name || device.id
        const meta = document.createElement('div')
        meta.className = 'meta'
        meta.textContent = `Paired ${new Date(device.pairedAt).toLocaleString()} · Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
        left.append(title, meta)
        const revoke = document.createElement('button')
        revoke.className = 'danger'
        revoke.textContent = 'Revoke'
        revoke.addEventListener('click', async () => {
          await call('gateway_revoke_device', { deviceId: device.id })
          await refreshDevices()
        })
        row.append(left, revoke)
        root.appendChild(row)
      }
    } catch (error) { fail(error) }
  }

  async function pairRemote() {
    clearError()
    const button = $('remote-connect')
    setBusy(button, true, 'Pairing…')
    try {
      const endpointUrl = normalizeUrl($('remote-url').value)
      const code = $('remote-code').value.trim()
      if (!endpointUrl || !code) throw new Error('Gateway URL and pairing code are required.')
      const deviceName = $('remote-device').value.trim() || state.platform?.deviceName || 'HarnessDock Client'
      const allowInsecure = $('remote-insecure').checked
      const result = await call('pair_remote', { endpointUrl, code, deviceName, allowInsecure })
      save('remoteUrl', endpointUrl)
      save('deviceName', deviceName)
      window.location.assign(result.connectUrl)
    } catch (error) { fail(error) }
    finally { setBusy(button, false, '') }
  }

  function openRemote() {
    try {
      const endpointUrl = normalizeUrl($('remote-url').value)
      if (!endpointUrl) throw new Error('Gateway URL is required.')
      save('remoteUrl', endpointUrl)
      window.location.assign(endpointUrl)
    } catch (error) { fail(error) }
  }

  async function boot() {
    try {
      state.platform = await call('platform_info')
      $('platform-badge').textContent = `${state.platform.os} · ${state.platform.arch} · ${state.platform.mobile ? 'mobile remote' : 'desktop local + remote'}`
      $('remote-url').value = saved('remoteUrl')
      $('remote-device').value = saved('deviceName', state.platform.deviceName || '')
      $('gateway-public').value = saved('gatewayPublic')
      if (!state.platform.mobile) {
        $('desktop-panel').classList.remove('hidden')
        $('gateway-panel').classList.remove('hidden')
        await refreshRuntime()
      }
    } catch (error) { fail(error) }
  }

  $('runtime-start').addEventListener('click', startRuntime)
  $('runtime-open').addEventListener('click', openRuntime)
  $('runtime-stop').addEventListener('click', stopRuntime)
  $('gateway-start').addEventListener('click', startGateway)
  $('gateway-stop').addEventListener('click', () => stopGateway().catch(fail))
  $('gateway-pair').addEventListener('click', createPairing)
  $('gateway-refresh').addEventListener('click', refreshDevices)
  $('remote-connect').addEventListener('click', pairRemote)
  $('remote-open').addEventListener('click', openRemote)
  void boot()
})()
