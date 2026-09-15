//! Gateway request routing: pairing, connect-ticket exchange and the
//! authenticated upstream proxy.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub fn handle_connection(
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

pub fn handle_pair(
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
            .map_err(|_| lock_err("GatewayRegistry"))?;
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

pub fn handle_connect(
    stream: &mut TcpStream,
    url: &Url,
    shared: &GatewayShared,
) -> Result<(), String> {
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
            .map_err(|_| lock_err("GatewayRegistry"))?;
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

pub fn connect_token(url: &Url) -> Result<String, &'static str> {
    let mut token = None;
    for (key, value) in url.query_pairs() {
        if key != "token" || token.is_some() || value.is_empty() {
            return Err("exactly one non-empty token query parameter is required");
        }
        token = Some(value.into_owned());
    }
    token.ok_or("exactly one non-empty token query parameter is required")
}

pub fn connect_upstream(host: &str, port: u16) -> Result<TcpStream, String> {
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

pub fn proxy_authenticated(
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
            .map_err(|_| lock_err("GatewayRegistry"))?;
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

pub fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_string())
    })
}

pub fn rate_limited(registry: &mut GatewayRegistry, peer: IpAddr) -> bool {
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

pub fn prune_registry(registry: &mut GatewayRegistry) {
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

pub fn device_info(session: &SessionState) -> GatewayDeviceInfo {
    GatewayDeviceInfo {
        id: session.id.clone(),
        name: session.name.clone(),
        paired_at: rfc3339(session.paired_at),
        last_seen_at: rfc3339(session.last_seen_at),
        session_expires_at: rfc3339(session.expires_at),
    }
}
