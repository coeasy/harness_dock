use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use url::Url;

use crate::{runtime_actor::RuntimeLease, AppState};

const MAX_GATEWAY_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_GATEWAY_CONNECTIONS: usize = 64;
const GATEWAY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
const GATEWAY_UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GatewayPhase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayDeviceInfo {
    id: String,
    name: String,
    paired_at: String,
    last_seen_at: String,
    session_expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHostStatus {
    running: bool,
    local_url: Option<String>,
    public_url: Option<String>,
    devices: Vec<GatewayDeviceInfo>,
    runtime_generation: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPairingTicket {
    code: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    device_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    connect_url: String,
    expires_at: String,
}

struct GatewayRejection {
    status: u16,
    reason: &'static str,
    body: &'static [u8],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    schema_version: u8,
    ok: bool,
    provider: &'static str,
    app_url: String,
    message: Option<String>,
}

#[derive(Clone)]
struct PairingState {
    code: String,
    expires_at: SystemTime,
}

#[derive(Clone)]
struct ConnectTicket {
    token: String,
    session_token: String,
    expires_at: SystemTime,
}

#[derive(Clone)]
struct SessionState {
    id: String,
    name: String,
    paired_at: SystemTime,
    last_seen_at: SystemTime,
    expires_at: SystemTime,
    bootstrapped: bool,
}

#[derive(Default)]
struct GatewayRegistry {
    pairing: Option<PairingState>,
    connect_tickets: HashMap<String, ConnectTicket>,
    sessions: HashMap<String, SessionState>,
    attempts: HashMap<IpAddr, VecDeque<Instant>>,
}

struct GatewayShared {
    registry: Mutex<GatewayRegistry>,
    runtime_lease: RuntimeLease,
    public_url: String,
    secure_cookie: bool,
    stop: Arc<AtomicBool>,
    active_connections: AtomicUsize,
    next_connection_id: AtomicUsize,
    connection_streams: Mutex<HashMap<usize, Vec<TcpStream>>>,
    connection_workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

pub(crate) struct NativeGateway {
    stop: Arc<AtomicBool>,
    local_addr: SocketAddr,
    local_url: String,
    public_url: String,
    runtime_generation: u64,
    shared: Arc<GatewayShared>,
    thread: Option<thread::JoinHandle<()>>,
}

impl NativeGateway {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.local_addr, Duration::from_millis(150));
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        shutdown_active_connections(&self.shared);
        join_connection_workers(&self.shared);
    }

    fn status(&self) -> GatewayHostStatus {
        let devices = self
            .shared
            .registry
            .lock()
            .map(|mut registry| {
                prune_registry(&mut registry);
                registry
                    .sessions
                    .values()
                    .map(device_info)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        GatewayHostStatus {
            running: true,
            local_url: Some(self.local_url.clone()),
            public_url: Some(self.public_url.clone()),
            devices,
            runtime_generation: Some(self.runtime_generation),
        }
    }
}

impl Drop for NativeGateway {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) struct GatewayActorState {
    phase: GatewayPhase,
    generation: u64,
    server: Option<NativeGateway>,
    lifecycle: Arc<Mutex<()>>,
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

    fn begin_start(&mut self) -> Result<u64, String> {
        if self.is_transitioning() {
            return Err("Gateway 正在处理另一个生命周期操作，请稍候。".into());
        }
        self.generation = self.generation.saturating_add(1);
        self.phase = GatewayPhase::Starting;
        Ok(self.generation)
    }

    fn publish(&mut self, generation: u64, server: NativeGateway) -> Result<(), NativeGateway> {
        if self.phase != GatewayPhase::Starting || self.generation != generation {
            return Err(server);
        }
        self.server = Some(server);
        self.phase = GatewayPhase::Ready;
        Ok(())
    }

    fn fail(&mut self, generation: u64) {
        if self.phase == GatewayPhase::Starting && self.generation == generation {
            self.phase = GatewayPhase::Failed;
            self.server = None;
        }
    }

    fn begin_stop(&mut self) -> Option<NativeGateway> {
        if self.phase == GatewayPhase::Stopped && self.server.is_none() {
            return None;
        }
        self.phase = GatewayPhase::Stopping;
        self.server.take()
    }

    fn settle_stopped(&mut self) {
        self.server = None;
        self.phase = GatewayPhase::Stopped;
    }
}

fn stopped() -> GatewayHostStatus {
    GatewayHostStatus {
        running: false,
        local_url: None,
        public_url: None,
        devices: Vec::new(),
        runtime_generation: None,
    }
}

fn validated_gateway_port(local_port: Option<u16>) -> Result<u16, String> {
    let port = local_port.unwrap_or(43137);
    if port < 1024 {
        return Err("Gateway 本地端口必须在 1024-65535 之间。".into());
    }
    Ok(port)
}

fn is_loopback(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn validated_public_gateway_url(
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

fn spawn_native_gateway(
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

struct ActiveConnectionGuard {
    id: usize,
    shared: Arc<GatewayShared>,
}

impl Drop for ActiveConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.shared.connection_streams.lock() {
            streams.remove(&self.id);
        }
        self.shared
            .active_connections
            .fetch_sub(1, Ordering::AcqRel);
    }
}

fn register_connection_stream(
    shared: &GatewayShared,
    id: usize,
    stream: &TcpStream,
) -> Result<(), String> {
    let shutdown_stream = stream.try_clone().map_err(|error| error.to_string())?;
    let mut streams = shared
        .connection_streams
        .lock()
        .map_err(|_| "Gateway connection registry poisoned".to_string())?;
    if shared.stop.load(Ordering::Acquire) {
        let _ = shutdown_stream.shutdown(Shutdown::Both);
        return Err("Native Gateway is stopping".into());
    }
    streams.entry(id).or_default().push(shutdown_stream);
    Ok(())
}

fn shutdown_active_connections(shared: &GatewayShared) {
    let streams = shared
        .connection_streams
        .lock()
        .map(|mut registry| {
            registry
                .drain()
                .flat_map(|(_, streams)| streams)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for stream in streams {
        let _ = stream.shutdown(Shutdown::Both);
    }
}

fn reap_finished_connection_workers(shared: &GatewayShared) {
    let finished = shared
        .connection_workers
        .lock()
        .map(|mut workers| {
            let mut finished = Vec::new();
            let mut index = 0;
            while index < workers.len() {
                if workers[index].is_finished() {
                    finished.push(workers.swap_remove(index));
                } else {
                    index += 1;
                }
            }
            finished
        })
        .unwrap_or_default();
    for worker in finished {
        let _ = worker.join();
    }
}

fn join_connection_workers(shared: &GatewayShared) {
    let workers = shared
        .connection_workers
        .lock()
        .map(|mut workers| workers.drain(..).collect::<Vec<_>>())
        .unwrap_or_default();
    for worker in workers {
        let _ = worker.join();
    }
}

fn gateway_accept_loop(listener: TcpListener, stop: Arc<AtomicBool>, shared: Arc<GatewayShared>) {
    while !stop.load(Ordering::Acquire) {
        reap_finished_connection_workers(&shared);
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if stop.load(Ordering::Acquire) {
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
                if let Err(error) = stream.set_write_timeout(Some(GATEWAY_HANDSHAKE_TIMEOUT)) {
                    let _ = stream.shutdown(Shutdown::Both);
                    eprintln!("Native Gateway connection timeout setup failed: {error}");
                    continue;
                }
                let active = shared.active_connections.fetch_add(1, Ordering::AcqRel);
                if active >= MAX_GATEWAY_CONNECTIONS {
                    shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                    let _ = write_status(
                        &mut stream,
                        503,
                        "Service Unavailable",
                        b"gateway connection limit reached",
                    );
                    continue;
                }
                let connection_id = shared.next_connection_id.fetch_add(1, Ordering::AcqRel);
                if let Err(error) = register_connection_stream(&shared, connection_id, &stream) {
                    shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                    eprintln!("Native Gateway connection registration failed: {error}");
                    continue;
                }
                let connection_shared = Arc::clone(&shared);
                let spawned = thread::Builder::new()
                    .name("harnessdock-gateway-connection".into())
                    .spawn(move || {
                        let _guard = ActiveConnectionGuard {
                            id: connection_id,
                            shared: Arc::clone(&connection_shared),
                        };
                        if let Err(error) = handle_connection(
                            stream,
                            peer,
                            connection_id,
                            Arc::clone(&connection_shared),
                        ) {
                            eprintln!("Native Gateway connection failed: {error}");
                        }
                    });
                match spawned {
                    Ok(worker) => {
                        if let Ok(mut workers) = shared.connection_workers.lock() {
                            workers.push(worker);
                        } else {
                            let _ = worker.join();
                        }
                    }
                    Err(error) => {
                        if let Ok(mut streams) = shared.connection_streams.lock() {
                            streams.remove(&connection_id);
                        }
                        shared.active_connections.fetch_sub(1, Ordering::AcqRel);
                        eprintln!("Native Gateway connection thread failed: {error}");
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => {
                eprintln!("Native Gateway accept failed: {error}");
                thread::sleep(Duration::from_millis(100));
            }
        }
    }
    shutdown_active_connections(&shared);
    join_connection_workers(&shared);
}

struct ParsedRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    raw_body: Vec<u8>,
}

fn validated_content_length(value: &str) -> Result<usize, String> {
    let length = value
        .parse::<usize>()
        .map_err(|_| "Gateway Content-Length invalid".to_string())?;
    if length > MAX_GATEWAY_BODY_BYTES {
        return Err("Gateway request body too large".into());
    }
    Ok(length)
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn is_safe_header_value(value: &str) -> bool {
    !value.bytes().any(|byte| {
        byte == b'\r' || byte == b'\n' || (byte < 0x20 && byte != b'\t') || byte == 0x7f
    })
}

fn read_request(stream: &mut TcpStream) -> Result<ParsedRequest, String> {
    let deadline = Instant::now() + GATEWAY_HANDSHAKE_TIMEOUT;
    let set_read_deadline = |stream: &mut TcpStream| -> Result<(), String> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Gateway request timed out".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| error.to_string())
    };
    let mut data = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = find_bytes(&data, b"\r\n\r\n") {
            if index + 4 > 64 * 1024 {
                return Err("Gateway request headers too large".into());
            }
            break index + 4;
        }
        if data.len() >= 64 * 1024 {
            return Err("Gateway request headers too large".into());
        }
        set_read_deadline(stream)?;
        let mut buf = [0_u8; 4096];
        let read = stream.read(&mut buf).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Gateway client closed before request headers".into());
        }
        data.extend_from_slice(&buf[..read]);
    };
    let header_text = std::str::from_utf8(&data[..header_end])
        .map_err(|_| "Gateway request headers are not UTF-8".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or_default().to_string();
    let version = request_parts.next().unwrap_or_default();
    if method.is_empty()
        || !is_http_token(&method)
        || target.is_empty()
        || version != "HTTP/1.1"
        || request_parts.next().is_some()
        || !target.starts_with('/')
        || target.starts_with("//")
    {
        return Err("invalid Gateway request line".into());
    }
    let mut headers = Vec::new();
    let mut content_length = 0_usize;
    let mut saw_content_length = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| "malformed Gateway request header".to_string())?;
        let value = value.trim().to_string();
        if !is_http_token(name) || !is_safe_header_value(&value) {
            return Err("invalid Gateway request header".into());
        }
        if name.eq_ignore_ascii_case("content-length") {
            if saw_content_length {
                return Err("duplicate Gateway Content-Length".into());
            }
            saw_content_length = true;
            content_length = validated_content_length(&value)?;
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err("Gateway Transfer-Encoding is not supported".into());
        }
        headers.push((name.to_string(), value));
    }
    let mut body = data[header_end..].to_vec();
    if body.len() > content_length {
        body.truncate(content_length);
    }
    while body.len() < content_length {
        set_read_deadline(stream)?;
        let mut buf = vec![0_u8; (content_length - body.len()).min(8192)];
        let read = stream.read(&mut buf).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Gateway client closed before request body completed".into());
        }
        body.extend_from_slice(&buf[..read]);
    }
    Ok(ParsedRequest {
        method,
        target,
        headers,
        raw_body: body,
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn request_path(target: &str) -> Result<Url, String> {
    if !target.starts_with('/') || target.starts_with("//") {
        return Err("Gateway request target must use origin-form".into());
    }
    Url::parse(&format!("http://gateway.local{target}"))
        .map_err(|_| "Gateway request target invalid".to_string())
}

fn header<'a>(request: &'a ParsedRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn handle_connection(
    mut stream: TcpStream,
    peer: SocketAddr,
    connection_id: usize,
    shared: Arc<GatewayShared>,
) -> Result<(), String> {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let status = if error.contains("too large") {
                413
            } else {
                400
            };
            let reason = if status == 413 {
                "Payload Too Large"
            } else {
                "Bad Request"
            };
            let _ = write_status(&mut stream, status, reason, b"invalid gateway request");
            return Err(error);
        }
    };
    let url = match request_path(&request.target) {
        Ok(url) => url,
        Err(error) => {
            let _ = write_status(
                &mut stream,
                400,
                "Bad Request",
                b"invalid gateway request target",
            );
            return Err(error);
        }
    };
    match url.path() {
        "/api/harnessdock/health" => {
            if request.method != "GET" {
                return write_status(&mut stream, 405, "Method Not Allowed", b"");
            }
            let body = serde_json::to_vec(&HealthResponse {
                schema_version: 1,
                ok: true,
                provider: "remote",
                app_url: shared.public_url.clone(),
                message: None,
            })
            .map_err(|error| error.to_string())?;
            write_json(&mut stream, 200, "OK", &body)
        }
        "/api/harnessdock/pair" => handle_pair(&mut stream, peer.ip(), &request, &shared),
        "/api/harnessdock/connect" => handle_connect(&mut stream, &url, &shared),
        _ => proxy_authenticated(stream, request, connection_id, shared),
    }
}

fn handle_pair(
    stream: &mut TcpStream,
    peer: IpAddr,
    request: &ParsedRequest,
    shared: &GatewayShared,
) -> Result<(), String> {
    if request.method != "POST" {
        return write_status(stream, 405, "Method Not Allowed", b"");
    }
    if !header(request, "content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    }) {
        return write_status(
            stream,
            415,
            "Unsupported Media Type",
            b"application/json required",
        );
    }
    let pair: PairRequest = match serde_json::from_slice(&request.raw_body) {
        Ok(value) => value,
        Err(_) => return write_status(stream, 400, "Bad Request", b"invalid json"),
    };
    let code: String = pair.code.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if code.len() != 8 {
        return write_status(stream, 400, "Bad Request", b"invalid pairing code");
    }
    let device_name = pair.device_name.trim();
    if device_name.is_empty() || device_name.chars().count() > 80 {
        return write_status(stream, 400, "Bad Request", b"invalid device name");
    }
    let outcome = (|| -> Result<Result<Vec<u8>, GatewayRejection>, String> {
        let mut registry = shared
            .registry
            .lock()
            .map_err(|_| "Gateway registry poisoned".to_string())?;
        prune_registry(&mut registry);
        if rate_limited(&mut registry, peer) {
            return Ok(Err(GatewayRejection {
                status: 429,
                reason: "Too Many Requests",
                body: b"pairing rate limited",
            }));
        }
        let now = SystemTime::now();
        let valid = registry
            .pairing
            .as_ref()
            .is_some_and(|ticket| ticket.code == code && ticket.expires_at > now);
        if !valid {
            return Ok(Err(GatewayRejection {
                status: 401,
                reason: "Unauthorized",
                body: b"invalid or expired pairing code",
            }));
        }
        let session_token = random_hex(32)?;
        let connect_token = random_hex(24)?;
        let id = random_hex(12)?;
        let session_expiry = now + Duration::from_secs(30 * 24 * 60 * 60);
        registry.pairing = None;
        registry.sessions.insert(
            session_token.clone(),
            SessionState {
                id,
                name: device_name.to_string(),
                paired_at: now,
                last_seen_at: now,
                expires_at: session_expiry,
                bootstrapped: false,
            },
        );
        registry.connect_tickets.insert(
            connect_token.clone(),
            ConnectTicket {
                token: connect_token.clone(),
                session_token,
                expires_at: now + Duration::from_secs(90),
            },
        );
        let connect_url = format!(
            "{}api/harnessdock/connect?token={}",
            shared.public_url, connect_token
        );
        let body = serde_json::to_vec(&PairResponse {
            connect_url,
            expires_at: rfc3339(session_expiry),
        })
        .map_err(|error| error.to_string())?;
        Ok(Ok(body))
    })()?;
    match outcome {
        Ok(body) => write_json(stream, 200, "OK", &body),
        Err(rejection) => write_status(stream, rejection.status, rejection.reason, rejection.body),
    }
}

fn handle_connect(stream: &mut TcpStream, url: &Url, shared: &GatewayShared) -> Result<(), String> {
    if url.path() != "/api/harnessdock/connect" {
        return write_status(stream, 404, "Not Found", b"");
    }
    let token = match connect_token(url) {
        Ok(token) => token,
        Err(error) => return write_status(stream, 400, "Bad Request", error.as_bytes()),
    };
    let outcome = (|| -> Result<Result<String, &'static [u8]>, String> {
        let mut registry = shared
            .registry
            .lock()
            .map_err(|_| "Gateway registry poisoned".to_string())?;
        prune_registry(&mut registry);
        let Some(ticket) = registry.connect_tickets.remove(&token) else {
            return Ok(Err(b"invalid connect token"));
        };
        if ticket.token != token || ticket.expires_at <= SystemTime::now() {
            return Ok(Err(b"expired connect token"));
        }
        if !registry.sessions.contains_key(&ticket.session_token) {
            return Ok(Err(b"session not found"));
        }
        Ok(Ok(ticket.session_token))
    })()?;
    let session_token = match outcome {
        Ok(token) => token,
        Err(body) => return write_status(stream, 401, "Unauthorized", body),
    };
    let secure = if shared.secure_cookie { "; Secure" } else { "" };
    let response = format!(
        "HTTP/1.1 303 See Other\r\nLocation: /\r\nSet-Cookie: hd_session={}; Path=/; HttpOnly; SameSite=Strict{}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        session_token, secure
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| error.to_string())
}

fn connect_token(url: &Url) -> Result<String, &'static str> {
    let mut token = None;
    for (key, value) in url.query_pairs() {
        if key != "token" || token.is_some() || value.is_empty() {
            return Err("exactly one non-empty token query parameter is required");
        }
        token = Some(value.into_owned());
    }
    token.ok_or("exactly one non-empty token query parameter is required")
}

fn connect_upstream(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Native Gateway upstream address invalid: {error}"))?;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, GATEWAY_UPSTREAM_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(format!(
        "Native Gateway upstream connect failed: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no upstream address resolved".into())
    ))
}

fn proxy_authenticated(
    mut client: TcpStream,
    request: ParsedRequest,
    connection_id: usize,
    shared: Arc<GatewayShared>,
) -> Result<(), String> {
    client
        .set_read_timeout(None)
        .map_err(|error| format!("failed to clear Gateway handshake timeout: {error}"))?;
    let Some(session_token) =
        cookie_value(header(&request, "cookie").unwrap_or_default(), "hd_session")
    else {
        write_status(&mut client, 401, "Unauthorized", b"session cookie missing")?;
        return Ok(());
    };
    let bootstrap = {
        let mut registry = shared
            .registry
            .lock()
            .map_err(|_| "Gateway registry poisoned".to_string())?;
        prune_registry(&mut registry);
        let Some(session) = registry.sessions.get_mut(&session_token) else {
            write_status(&mut client, 401, "Unauthorized", b"session expired")?;
            return Ok(());
        };
        session.last_seen_at = SystemTime::now();
        !session.bootstrapped
    };
    let upstream = Url::parse(&shared.runtime_lease.origin)
        .map_err(|_| "RuntimeLease origin invalid".to_string())?;
    let host = upstream
        .host_str()
        .ok_or_else(|| "RuntimeLease origin host missing".to_string())?;
    let port = upstream
        .port()
        .ok_or_else(|| "RuntimeLease origin port missing".to_string())?;
    let mut upstream_stream = connect_upstream(host, port)?;
    register_connection_stream(&shared, connection_id, &upstream_stream)?;
    upstream_stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;

    let target = if bootstrap {
        let launch = Url::parse(&shared.runtime_lease.launch_url)
            .map_err(|_| "RuntimeLease launch URL invalid".to_string())?;
        let mut value = launch.path().to_string();
        if let Some(query) = launch.query() {
            value.push('?');
            value.push_str(query);
        }
        value
    } else {
        request.target.clone()
    };
    let host_header = format!("{host}:{port}");
    let mut first = format!("{} {} HTTP/1.1\r\n", request.method, target);
    for (name, value) in &request.headers {
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("cookie") {
            continue;
        }
        first.push_str(name);
        first.push_str(": ");
        first.push_str(value);
        first.push_str("\r\n");
    }
    first.push_str(&format!("Host: {host_header}\r\n"));
    if let Some(cookie) = header(&request, "cookie") {
        let filtered = cookie
            .split(';')
            .map(str::trim)
            .filter(|part| !part.starts_with("hd_session="))
            .collect::<Vec<_>>()
            .join("; ");
        if !filtered.is_empty() {
            first.push_str(&format!("Cookie: {filtered}\r\n"));
        }
    }
    first.push_str("\r\n");
    upstream_stream
        .write_all(first.as_bytes())
        .and_then(|_| upstream_stream.write_all(&request.raw_body))
        .map_err(|error| error.to_string())?;
    if bootstrap {
        if let Ok(mut registry) = shared.registry.lock() {
            if let Some(session) = registry.sessions.get_mut(&session_token) {
                session.bootstrapped = true;
            }
        }
    }

    let mut client_read = client.try_clone().map_err(|error| error.to_string())?;
    let mut upstream_write = upstream_stream
        .try_clone()
        .map_err(|error| error.to_string())?;
    let forward = thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
    });
    let _ = io::copy(&mut upstream_stream, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream_stream.shutdown(Shutdown::Both);
    let _ = forward.join();
    Ok(())
}

fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_string())
    })
}

fn rate_limited(registry: &mut GatewayRegistry, peer: IpAddr) -> bool {
    let now = Instant::now();
    let attempts = registry.attempts.entry(peer).or_default();
    while attempts
        .front()
        .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(60))
    {
        attempts.pop_front();
    }
    if attempts.len() >= 8 {
        return true;
    }
    attempts.push_back(now);
    false
}

fn prune_registry(registry: &mut GatewayRegistry) {
    let now = SystemTime::now();
    if registry
        .pairing
        .as_ref()
        .is_some_and(|value| value.expires_at <= now)
    {
        registry.pairing = None;
    }
    registry
        .connect_tickets
        .retain(|_, ticket| ticket.expires_at > now);
    registry
        .sessions
        .retain(|_, session| session.expires_at > now);
    let instant_now = Instant::now();
    registry.attempts.retain(|_, attempts| {
        while attempts
            .front()
            .is_some_and(|at| instant_now.duration_since(*at) > Duration::from_secs(60))
        {
            attempts.pop_front();
        }
        !attempts.is_empty()
    });
}

fn device_info(session: &SessionState) -> GatewayDeviceInfo {
    GatewayDeviceInfo {
        id: session.id.clone(),
        name: session.name.clone(),
        paired_at: rfc3339(session.paired_at),
        last_seen_at: rfc3339(session.last_seen_at),
        session_expires_at: rfc3339(session.expires_at),
    }
}

fn write_json(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| error.to_string())
}

fn write_status(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &[u8],
) -> Result<(), String> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| error.to_string())
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut data = vec![0_u8; bytes];
    secure_random(&mut data)?;
    Ok(data.iter().map(|value| format!("{value:02x}")).collect())
}

fn pairing_code() -> Result<String, String> {
    let mut data = [0_u8; 4];
    secure_random(&mut data)?;
    let value = u32::from_le_bytes(data) % 100_000_000;
    Ok(format!("{value:08}"))
}

#[cfg(unix)]
fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(buffer))
        .map_err(|error| format!("OS random source unavailable: {error}"))
}

#[cfg(windows)]
fn secure_random(buffer: &mut [u8]) -> Result<(), String> {
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut u8, length: u32) -> u8;
    }
    let ok = unsafe { rtl_gen_random(buffer.as_mut_ptr(), buffer.len() as u32) };
    if ok == 0 {
        Err("Windows cryptographic random source unavailable".into())
    } else {
        Ok(())
    }
}

fn rfc3339(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let seconds_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

fn runtime_lease(state: &AppState) -> Result<RuntimeLease, String> {
    // A RuntimeLease is only usable while its owned process is alive. Refreshing
    // the Runtime actor here also tears down a Gateway that was left behind by
    // an unexpected Runtime exit before any pairing/proxy operation uses it.
    crate::runtime::live_lease(state)
        .ok_or_else(|| "请先启动本地 Runtime，再使用 Mobile Gateway。".to_string())
}

fn ensure_current_runtime(state: &AppState, generation: u64) -> bool {
    crate::runtime::live_lease(state).is_some_and(|lease| lease.generation.id == generation)
}

#[tauri::command]
pub fn gateway_host_status(state: State<'_, AppState>) -> Result<GatewayHostStatus, String> {
    let generation = state.gateway.lock().ok().and_then(|actor| {
        actor
            .server
            .as_ref()
            .map(|server| server.runtime_generation)
    });
    if let Some(generation) = generation {
        if !ensure_current_runtime(&*state, generation) {
            stop_managed(&state.gateway);
            return Ok(stopped());
        }
    }
    let actor = state
        .gateway
        .lock()
        .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
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
    let lease = runtime_lease(&*state)?;
    let port = validated_gateway_port(local_port)?;
    let lifecycle = lifecycle_lock(&state.gateway)?;
    let generation = {
        let _serial = lifecycle
            .lock()
            .map_err(|_| "Gateway lifecycle lock is poisoned".to_string())?;
        if let Ok(actor) = state.gateway.lock() {
            if let Some(server) = actor.server.as_ref() {
                if server.runtime_generation == lease.generation.id {
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
        let mut actor = state
            .gateway
            .lock()
            .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
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
    if !ensure_current_runtime(&*state, lease.generation.id)
        || state.quitting.load(Ordering::Acquire)
    {
        let mut server = server;
        server.stop();
        if let Ok(mut actor) = state.gateway.lock() {
            actor.fail(generation);
        }
        return Err("RuntimeLease 在 Gateway 启动期间已失效。".into());
    }
    let status = {
        let _serial = lifecycle
            .lock()
            .map_err(|_| "Gateway lifecycle lock is poisoned".to_string())?;
        let mut actor = state
            .gateway
            .lock()
            .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
        if let Err(mut stale) = actor.publish(generation, server) {
            stale.stop();
            return Err("陈旧 Gateway generation 已被丢弃。".into());
        }
        actor.server.as_ref().expect("published gateway").status()
    };
    // A Runtime stop can race between the pre-spawn lease check and publish.
    // Re-check after publication and tear down a server that was published
    // after the Runtime actor had already become unavailable.
    if !ensure_current_runtime(&*state, lease.generation.id) {
        stop_managed(&state.gateway);
        return Err("RuntimeLease 在 Gateway 发布期间已失效。".into());
    }
    Ok(status)
}

#[tauri::command]
pub fn gateway_host_create_pairing(
    state: State<'_, AppState>,
) -> Result<GatewayPairingTicket, String> {
    let current = runtime_lease(&*state)?;
    let mut actor = state
        .gateway
        .lock()
        .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
    let server = actor
        .server
        .as_mut()
        .ok_or_else(|| "Mobile Gateway 尚未启动。".to_string())?;
    if server.runtime_generation != current.generation.id {
        return Err("Gateway RuntimeLease 已失效，请重新启动 Gateway。".into());
    }
    let code = pairing_code()?;
    let expires_at = SystemTime::now() + Duration::from_secs(5 * 60);
    let mut registry = server
        .shared
        .registry
        .lock()
        .map_err(|_| "Gateway registry poisoned".to_string())?;
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
    let current = runtime_lease(&*state)?;
    let mut actor = state
        .gateway
        .lock()
        .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
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
        .map_err(|_| "Gateway registry poisoned".to_string())?;
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
    let current = runtime_lease(&*state)?;
    let mut actor = state
        .gateway
        .lock()
        .map_err(|_| "GatewayActor 状态锁已损坏。".to_string())?;
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
        .map_err(|_| "Gateway registry poisoned".to_string())?;
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

fn lifecycle_lock(gateway: &Mutex<GatewayActorState>) -> Result<Arc<Mutex<()>>, String> {
    match gateway.lock() {
        Ok(actor) => Ok(Arc::clone(&actor.lifecycle)),
        Err(poisoned) => Ok(Arc::clone(&poisoned.into_inner().lifecycle)),
    }
}

fn stop_managed_inner(gateway: &Mutex<GatewayActorState>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_public_url_is_https_or_loopback_debug_only() {
        let local = "http://127.0.0.1:43137/";
        assert!(
            validated_public_gateway_url(Some("https://gateway.example.com/".into()), local)
                .is_ok()
        );
        assert!(validated_public_gateway_url(Some(local.into()), local).is_ok());
        assert!(
            validated_public_gateway_url(Some("http://gateway.example.com/".into()), local)
                .is_err()
        );
        assert!(validated_public_gateway_url(
            Some("https://user:pass@gateway.example.com/".into()),
            local
        )
        .is_err());
    }

    #[test]
    fn gateway_port_avoids_privileged_ports() {
        assert_eq!(validated_gateway_port(None).unwrap(), 43137);
        assert_eq!(validated_gateway_port(Some(1024)).unwrap(), 1024);
        assert!(validated_gateway_port(Some(443)).is_err());
    }

    #[test]
    fn gateway_request_body_limit_is_fail_closed() {
        assert_eq!(validated_content_length("0").unwrap(), 0);
        assert_eq!(
            validated_content_length(&MAX_GATEWAY_BODY_BYTES.to_string()).unwrap(),
            MAX_GATEWAY_BODY_BYTES
        );
        assert!(validated_content_length(&(MAX_GATEWAY_BODY_BYTES + 1).to_string()).is_err());
        assert!(validated_content_length("not-a-number").is_err());
    }

    #[test]
    fn gateway_request_target_must_be_origin_form() {
        assert!(request_path("/api/harnessdock/health").is_ok());
        assert!(request_path("https://evil.example/path").is_err());
        assert!(request_path("//evil.example/path").is_err());
    }

    #[test]
    fn gateway_rejects_header_injection_bytes() {
        assert!(is_http_token("X-HarnessDock-Test"));
        assert!(!is_http_token("X HarnessDock"));
        assert!(is_safe_header_value("text/plain; charset=utf-8"));
        assert!(!is_safe_header_value("ok\r\nX-Injected: yes"));
    }

    #[test]
    fn connect_requires_exactly_one_non_empty_token() {
        let valid = Url::parse("http://gateway.local/api/harnessdock/connect?token=abc").unwrap();
        assert_eq!(connect_token(&valid).unwrap(), "abc");
        for target in [
            "http://gateway.local/api/harnessdock/connect",
            "http://gateway.local/api/harnessdock/connect?token=",
            "http://gateway.local/api/harnessdock/connect?token=abc&token=def",
            "http://gateway.local/api/harnessdock/connect?token=abc&extra=1",
        ] {
            let url = Url::parse(target).unwrap();
            assert!(
                connect_token(&url).is_err(),
                "accepted malformed connect URL: {target}"
            );
        }
    }

    #[test]
    fn cookies_are_parsed_without_exposing_other_values() {
        assert_eq!(
            cookie_value("a=1; hd_session=abc; b=2", "hd_session"),
            Some("abc".into())
        );
        assert_eq!(cookie_value("a=1", "hd_session"), None);
    }

    #[test]
    fn upstream_connect_is_bounded_and_uses_resolved_socket_addresses() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let connected = connect_upstream("127.0.0.1", port).unwrap();
        assert_eq!(connected.peer_addr().unwrap().port(), port);
    }

    #[test]
    fn timestamp_formatter_is_stable() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
    }
}
