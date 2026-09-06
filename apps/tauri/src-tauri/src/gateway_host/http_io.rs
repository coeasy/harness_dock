//! Minimal HTTP response writers and bounded upstream response-head parsing used
//! by the Gateway handlers.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub struct UpstreamResponseHead {
    pub bytes: Vec<u8>,
    pub status: u16,
    pub has_set_cookie: bool,
}

pub fn read_upstream_response_head(stream: &mut TcpStream) -> Result<UpstreamResponseHead, String> {
    let deadline = Instant::now() + GATEWAY_HANDSHAKE_TIMEOUT;
    let mut data = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(index) = find_bytes(&data, b"\r\n\r\n") {
            let end = index + 4;
            if end > MAX_GATEWAY_UPSTREAM_RESPONSE_HEAD_BYTES {
                return Err("Gateway upstream response headers too large".into());
            }
            break end;
        }
        if data.len() >= MAX_GATEWAY_UPSTREAM_RESPONSE_HEAD_BYTES {
            return Err("Gateway upstream response headers too large".into());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Gateway upstream response headers timed out".into());
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| error.to_string())?;
        let mut buf = [0_u8; 4096];
        let read = stream.read(&mut buf).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("Gateway upstream closed before response headers".into());
        }
        data.extend_from_slice(&buf[..read]);
    };

    let header_text = std::str::from_utf8(&data[..header_end])
        .map_err(|_| "Gateway upstream response headers are not UTF-8".to_string())?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| "Gateway upstream response status missing".to_string())?;
    let mut status_parts = status_line.split_whitespace();
    let version = status_parts.next().unwrap_or_default();
    let status = status_parts
        .next()
        .ok_or_else(|| "Gateway upstream response status missing".to_string())?
        .parse::<u16>()
        .map_err(|_| "Gateway upstream response status invalid".to_string())?;
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1") || !(100..=599).contains(&status) {
        return Err("Gateway upstream response status line invalid".into());
    }

    let has_set_cookie = lines.filter(|line| !line.is_empty()).any(|line| {
        line.split_once(':')
            .is_some_and(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
    });
    stream
        .set_read_timeout(None)
        .map_err(|error| format!("failed to clear Gateway upstream response timeout: {error}"))?;
    Ok(UpstreamResponseHead {
        bytes: data,
        status,
        has_set_cookie,
    })
}

pub fn bootstrap_response_accepted(response: &UpstreamResponseHead) -> bool {
    // BrowserAuth's launch token is single-use: a successful exchange mints an
    // authority-bound cookie and either returns HTML or redirects to clean `/`.
    // Do not consume the session bootstrap state on an error response or on a
    // response that did not mint the durable cookie.
    (200..400).contains(&response.status) && response.has_set_cookie
}

pub fn write_json(
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

pub fn write_status(
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
