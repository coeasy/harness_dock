//! Gateway wire types, limits and shared registry state.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub const MAX_GATEWAY_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_GATEWAY_CONNECTIONS: usize = 64;
pub const GATEWAY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);
pub const GATEWAY_UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

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
    pub id: String,
    pub name: String,
    pub paired_at: String,
    pub last_seen_at: String,
    pub session_expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHostStatus {
    pub running: bool,
    pub local_url: Option<String>,
    pub public_url: Option<String>,
    pub devices: Vec<GatewayDeviceInfo>,
    pub runtime_generation: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPairingTicket {
    pub code: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub device_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairResponse {
    pub connect_url: String,
    pub expires_at: String,
}

pub struct GatewayRejection {
    pub status: u16,
    pub reason: &'static str,
    pub body: &'static [u8],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub schema_version: u8,
    pub ok: bool,
    pub provider: &'static str,
    pub app_url: String,
    pub message: Option<String>,
}

#[derive(Clone)]
pub struct PairingState {
    pub code: String,
    pub expires_at: SystemTime,
}

#[derive(Clone)]
pub struct ConnectTicket {
    pub token: String,
    pub session_token: String,
    pub expires_at: SystemTime,
}

#[derive(Clone)]
pub struct SessionState {
    pub id: String,
    pub name: String,
    pub paired_at: SystemTime,
    pub last_seen_at: SystemTime,
    pub expires_at: SystemTime,
    pub bootstrapped: bool,
}

#[derive(Default)]
pub struct GatewayRegistry {
    pub pairing: Option<PairingState>,
    pub connect_tickets: HashMap<String, ConnectTicket>,
    pub sessions: HashMap<String, SessionState>,
    pub attempts: HashMap<IpAddr, VecDeque<Instant>>,
}

pub struct GatewayShared {
    pub registry: Mutex<GatewayRegistry>,
    pub runtime_lease: RuntimeLease,
    pub public_url: String,
    pub secure_cookie: bool,
    pub stop: Arc<AtomicBool>,
    pub active_connections: AtomicUsize,
    pub next_connection_id: AtomicUsize,
    pub connection_streams: Mutex<HashMap<usize, Vec<TcpStream>>>,
    pub connection_workers: Mutex<Vec<thread::JoinHandle<()>>>,
}
