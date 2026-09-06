//! Tauri commands that expose the Gateway to the native UI surfaces.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

#[tauri::command]
pub fn gateway_host_status(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let finished = state
        .gateway
        .lock()
        .ok()
        .and_then(|actor| actor.server.as_ref().map(NativeGateway::is_finished))
        .unwrap_or(false);
    if finished {
        stop_managed(&state.gateway);
        return Ok(stopped());
    }
    let generation = state.gateway.lock().ok().and_then(|actor| {
        actor
            .server
            .as_ref()
            .map(|server| server.runtime_generation)
    });
    if let Some(generation) = generation {
        if !is_current_generation(&state, generation) {
            stop_managed(&state.gateway);
            return Ok(stopped());
        }
    }
    let actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
    Ok(actor
        .server
        .as_ref()
        .map(NativeGateway::status)
        .unwrap_or_else(stopped))
}

#[tauri::command]
pub fn gateway_host_start(
    _app: AppHandle,
    state: State<'_, AppState>,
    public_url: Option<String>,
    local_port: Option<u16>,
) -> Result<GatewayHostStatus, String> {
    if cfg!(mobile) {
        return Err("Android/iOS 只能作为 Gateway 客户端，不能托管桌面 Gateway。".into());
    }
    if state.quitting.load(Ordering::Acquire) {
        return Err("HarnessDock 正在退出，已拒绝新的 Gateway 启动。".into());
    }
    let lease = require_live_lease(&state)?;
    let port = validated_gateway_port(local_port)?;
    let lifecycle = lifecycle_lock(&state.gateway)?;
    let generation = {
        let _serial = lifecycle.lock().map_err(|_| lock_err("GatewayLifecycle"))?;
        if let Ok(actor) = state.gateway.lock() {
            if let Some(server) = actor.server.as_ref() {
                if server.runtime_generation == lease.generation.id && !server.is_finished() {
                    return Ok(server.status());
                }
            }
        }
        if state
            .gateway
            .lock()
            .map(|actor| actor.is_transitioning())
            .unwrap_or(true)
        {
            return Err("Gateway 正在处理另一个生命周期操作，请稍候。".into());
        }
        stop_managed_inner(&state.gateway);
        let mut actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
        actor.begin_start()?
    };
    let server = match spawn_native_gateway(lease.clone(), port, public_url) {
        Ok(server) => server,
        Err(error) => {
            if let Ok(mut actor) = state.gateway.lock() {
                actor.fail(generation);
            }
            return Err(error);
        }
    };
    if !is_current_generation(&state, lease.generation.id) || state.quitting.load(Ordering::Acquire)
    {
        let mut server = server;
        server.stop();
        if let Ok(mut actor) = state.gateway.lock() {
            actor.fail(generation);
        }
        return Err("RuntimeLease 在 Gateway 启动期间已失效。".into());
    }
    let status = {
        let _serial = lifecycle.lock().map_err(|_| lock_err("GatewayLifecycle"))?;
        let mut actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
        if let Err(mut stale) = actor.publish(generation, server) {
            stale.stop();
            return Err("陈旧 Gateway generation 已被丢弃。".into());
        }
        actor
            .server
            .as_ref()
            .ok_or_else(|| "Gateway publish succeeded without a live server".to_string())?
            .status()
    };
    // A Runtime stop can race between the pre-spawn lease check and publish.
    // Re-check after publication and tear down a server that was published
    // after the Runtime actor had already become unavailable.
    if !is_current_generation(&state, lease.generation.id) {
        stop_managed(&state.gateway);
        return Err("RuntimeLease 在 Gateway 发布期间已失效。".into());
    }
    Ok(status)
}

#[tauri::command]
pub fn gateway_host_create_pairing(
    state: State<'_, AppState>,
) -> Result<GatewayPairingTicket, String> {
    let current = require_live_lease(&state)?;
    let mut actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
    let server = actor
        .server
        .as_mut()
        .ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())?;
    if server.runtime_generation != current.generation.id {
        return Err("Gateway RuntimeLease 已失效，请重新启动 Gateway。".into());
    }
    let code = pairing_code()?;
    let expires_at =
        SystemTime::now() + Duration::from_secs(crate::constants::GATEWAY_PAIRING_TTL_SECS);
    let mut registry = server
        .shared
        .registry
        .lock()
        .map_err(|_| lock_err("GatewayRegistry"))?;
    prune_registry(&mut registry);
    registry.pairing = Some(PairingState {
        code: code.clone(),
        expires_at,
    });
    Ok(GatewayPairingTicket {
        code,
        expires_at: rfc3339(expires_at),
    })
}

#[tauri::command]
pub fn gateway_host_revoke(state: State<'_, AppState>, device_id: String) -> Result<bool, String> {
    let current = require_live_lease(&state)?;
    let mut actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
    let server = actor
        .server
        .as_mut()
        .ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())?;
    if server.runtime_generation != current.generation.id {
        return Err("Gateway RuntimeLease 已失效，请重新启动 Gateway。".into());
    }
    let mut registry = server
        .shared
        .registry
        .lock()
        .map_err(|_| lock_err("GatewayRegistry"))?;
    prune_registry(&mut registry);
    let token = registry
        .sessions
        .iter()
        .find_map(|(token, session)| (session.id == device_id).then(|| token.clone()));
    if let Some(token) = token {
        registry.sessions.remove(&token);
        registry
            .connect_tickets
            .retain(|_, ticket| ticket.session_token != token);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub fn gateway_host_revoke_all(state: State<'_, AppState>) -> Result<usize, String> {
    let current = require_live_lease(&state)?;
    let mut actor = state.gateway.lock().map_err(|_| lock_err("GatewayActor"))?;
    let server = actor
        .server
        .as_mut()
        .ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())?;
    if server.runtime_generation != current.generation.id {
        return Err("Gateway RuntimeLease 已失效，请重新启动 Gateway。".into());
    }
    let mut registry = server
        .shared
        .registry
        .lock()
        .map_err(|_| lock_err("GatewayRegistry"))?;
    prune_registry(&mut registry);
    let count = registry.sessions.len();
    registry.sessions.clear();
    registry.connect_tickets.clear();
    registry.pairing = None;
    Ok(count)
}

#[tauri::command]
pub fn gateway_host_stop(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    stop_managed(&state.gateway);
    Ok(stopped())
}
