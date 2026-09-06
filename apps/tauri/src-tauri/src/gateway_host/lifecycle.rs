//! Gateway admission: actor phase machine, port/URL validation, spawn and
//! the stop path that serialises against a late publish.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub(crate) struct GatewayActorState {
    pub phase: GatewayPhase,
    pub generation: u64,
    pub server: Option<NativeGateway>,
    pub lifecycle: Arc<Mutex<()>>,
}

impl Default for GatewayActorState {
    fn default() -> Self {
        Self {
            phase: GatewayPhase::Stopped,
            generation: 0,
            server: None,
            lifecycle: Arc::new(Mutex::new(())),
        }
    }
}

impl GatewayActorState {
    pub(crate) fn phase(&self) -> GatewayPhase {
        self.phase
    }

    pub(crate) fn is_transitioning(&self) -> bool {
        matches!(self.phase, GatewayPhase::Starting | GatewayPhase::Stopping)
    }

    pub fn begin_start(&mut self) -> Result<u64, String> {
        if self.is_transitioning() {
            return Err("Gateway 正在处理另一个生命周期操作，请稍候。".into());
        }
        self.generation = self.generation.saturating_add(1);
        self.phase = GatewayPhase::Starting;
        Ok(self.generation)
    }

    pub fn publish(
        &mut self,
        generation: u64,
        server: NativeGateway,
    ) -> Result<(), Box<NativeGateway>> {
        if self.phase != GatewayPhase::Starting || self.generation != generation {
            return Err(Box::new(server));
        }
        self.server = Some(server);
        self.phase = GatewayPhase::Ready;
        Ok(())
    }

    pub fn fail(&mut self, generation: u64) {
        if self.phase == GatewayPhase::Starting && self.generation == generation {
            self.phase = GatewayPhase::Failed;
            self.server = None;
        }
    }

    pub fn begin_stop(&mut self) -> Option<NativeGateway> {
        if self.phase == GatewayPhase::Stopped && self.server.is_none() {
            return None;
        }
        self.phase = GatewayPhase::Stopping;
        self.server.take()
    }

    pub fn settle_stopped(&mut self) {
        self.server = None;
        self.phase = GatewayPhase::Stopped;
    }
}

pub fn stopped() -> GatewayHostStatus {
    GatewayHostStatus {
        running: false,
        local_url: None,
        public_url: None,
        devices: Vec::new(),
        runtime_generation: None,
    }
}

pub fn validated_gateway_port(local_port: Option<u16>) -> Result<u16, String> {
    let port = local_port.unwrap_or(crate::constants::DEFAULT_GATEWAY_PORT);
    if port < 1024 {
        return Err("Gateway 本地端口必须在 1024-65535 之间。".into());
    }
    Ok(port)
}

pub fn validated_public_gateway_url(
    public_url: Option<String>,
    local_url: &str,
) -> Result<String, String> {
    let Some(value) = public_url else {
        return Ok(local_url.to_string());
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(local_url.to_string());
    }
    let mut url = Url::parse(value).map_err(|error| format!("Gateway 公网地址无效: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "Gateway 公网地址缺少主机名。".to_string())?;
    let local_debug = url.scheme() == "http" && is_loopback(host) && url.port().is_some();
    if url.scheme() != "https" && !local_debug {
        return Err("Gateway 公网地址必须使用 HTTPS；HTTP 仅允许 loopback 调试。".into());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || (url.path() != "/" && !url.path().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Gateway 公网地址必须是无凭据、无路径/query/fragment 的 origin 根地址。".into(),
        );
    }
    url.set_path("/");
    Ok(url.to_string())
}

pub fn spawn_native_gateway(
    lease: RuntimeLease,
    port: u16,
    public_url: Option<String>,
) -> Result<NativeGateway, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("无法绑定 Native Gateway 127.0.0.1:{port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("无法配置 Native Gateway listener: {error}"))?;
    let local_addr = listener.local_addr().map_err(|error| error.to_string())?;
    let local_url = format!("http://127.0.0.1:{}/", local_addr.port());
    let public_url = validated_public_gateway_url(public_url, &local_url)?;
    let secure_cookie = public_url.starts_with("https://");
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(GatewayShared {
        registry: Mutex::new(GatewayRegistry::default()),
        runtime_lease: lease.clone(),
        public_url: public_url.clone(),
        secure_cookie,
        stop: Arc::clone(&stop),
        active_connections: AtomicUsize::new(0),
        next_connection_id: AtomicUsize::new(1),
        connection_streams: Mutex::new(HashMap::new()),
        connection_workers: Mutex::new(Vec::new()),
    });
    let thread_stop = Arc::clone(&stop);
    let thread_shared = Arc::clone(&shared);
    let handle = thread::Builder::new()
        .name("harnessdock-native-gateway".into())
        .spawn(move || gateway_accept_loop(listener, thread_stop, thread_shared))
        .map_err(|error| format!("无法启动 Native GatewayActor: {error}"))?;
    Ok(NativeGateway {
        stop,
        local_addr,
        local_url,
        public_url,
        runtime_generation: lease.generation.id,
        shared,
        thread: Some(handle),
    })
}

pub fn lifecycle_lock(gateway: &Mutex<GatewayActorState>) -> Result<Arc<Mutex<()>>, String> {
    match gateway.lock() {
        Ok(actor) => Ok(Arc::clone(&actor.lifecycle)),
        Err(poisoned) => Ok(Arc::clone(&poisoned.into_inner().lifecycle)),
    }
}

pub fn stop_managed_inner(gateway: &Mutex<GatewayActorState>) {
    let server = match gateway.lock() {
        Ok(mut actor) => actor.begin_stop(),
        Err(poisoned) => poisoned.into_inner().begin_stop(),
    };
    if let Some(mut server) = server {
        server.stop();
    }
    match gateway.lock() {
        Ok(mut actor) => actor.settle_stopped(),
        Err(poisoned) => poisoned.into_inner().settle_stopped(),
    }
}

pub(crate) fn stop_managed(gateway: &Mutex<GatewayActorState>) {
    let lifecycle = match gateway.lock() {
        Ok(actor) => Arc::clone(&actor.lifecycle),
        Err(poisoned) => Arc::clone(&poisoned.into_inner().lifecycle),
    };
    let _serial = match lifecycle.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    stop_managed_inner(gateway);
}
