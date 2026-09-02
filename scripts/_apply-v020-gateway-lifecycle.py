from pathlib import Path

gateway_path = Path('apps/tauri/src-tauri/src/gateway_host.rs')
gateway = gateway_path.read_text()

old = '''fn claim_gateway_start(state: &State<'_, AppState>) -> Result<GatewayStartGuard, String> {
    let starting = Arc::clone(&state.gateway_starting);
    if starting.swap(true, Ordering::AcqRel) {
        return Err("Gateway 正在处理另一个启动操作，请稍候再试。".into());
    }
    let claim = GatewayStartGuard(starting);
    if state.quitting.load(Ordering::Acquire)
        || state.runtime_restarting.load(Ordering::Acquire)
        || state.runtime_stopping.load(Ordering::Acquire)
    {
        return Err("Runtime 正在处理生命周期操作，暂时无法启动 Gateway。".into());
    }
    Ok(claim)
}
'''
new = '''fn claim_gateway_start(state: &State<'_, AppState>) -> Result<GatewayStartGuard, String> {
    let lifecycle = Arc::clone(&state.gateway_starting);
    if lifecycle.swap(true, Ordering::AcqRel) {
        return Err("Gateway 正在处理另一个生命周期操作，请稍候再启动。".into());
    }
    let claim = GatewayStartGuard(lifecycle);
    if state.quitting.load(Ordering::Acquire)
        || state.runtime_restarting.load(Ordering::Acquire)
        || state.runtime_stopping.load(Ordering::Acquire)
    {
        return Err("Runtime 正在处理生命周期操作，暂时无法启动 Gateway。".into());
    }
    Ok(claim)
}

fn claim_gateway_stop(state: &State<'_, AppState>) -> Result<GatewayStartGuard, String> {
    let lifecycle = Arc::clone(&state.gateway_starting);
    if lifecycle.swap(true, Ordering::AcqRel) {
        return Err("Gateway 正在处理另一个生命周期操作，请稍候再停止。".into());
    }
    Ok(GatewayStartGuard(lifecycle))
}
'''
if gateway.count(old) != 1:
    raise SystemExit(f'claim_gateway_start anchor count={gateway.count(old)}')
gateway = gateway.replace(old, new, 1)

old_stop = '''pub fn gateway_host_stop(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    if state.gateway_starting.load(Ordering::Acquire) {
        return Err("Gateway 正在启动，请稍候再停止。".into());
    }
    if let Some(mut process) = guard.take() {
        process.stop();
    }
    Ok(stopped())
}
'''
new_stop = '''pub fn gateway_host_stop(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let _stopping = claim_gateway_stop(&state)?;
    let mut guard = state
        .gateway
        .lock()
        .map_err(|_| "Gateway 状态锁已损坏。".to_string())?;
    if let Some(mut process) = guard.take() {
        process.stop();
    }
    Ok(stopped())
}
'''
if gateway.count(old_stop) != 1:
    raise SystemExit(f'gateway_host_stop anchor count={gateway.count(old_stop)}')
gateway = gateway.replace(old_stop, new_stop, 1)
gateway_path.write_text(gateway)

test_path = Path('tests/parity/tauri-host.test.ts')
test = test_path.read_text()
old_assert = '    expect(tray).toContain(\'"tray-gateway", "移动设备 / Gateway"\')'
new_assert = '    expect(tray).toContain(\'"tray-gateway"\')\n    expect(tray).toContain(\'"移动设备 / Gateway"\')'
if test.count(old_assert) != 1:
    raise SystemExit(f'tray assertion anchor count={test.count(old_assert)}')
test_path.write_text(test.replace(old_assert, new_assert, 1))

print('Gateway lifecycle and semantic tray assertions migrated successfully')
