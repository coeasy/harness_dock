//! HTTP/1.1 request parsing and validation for the Gateway proxy.

// The parent module owns the shared imports; every submodule can see
// them and its siblings through this glob (glob imports never warn).
use super::*;

pub struct ParsedRequest {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub raw_body: Vec<u8>,
}

pub fn validated_content_length(value: &str) -> Result<usize, String> {
    let length = value
        .parse::<usize>()
        .map_err(|_| "Gateway Content-Length invalid".to_string())?;
    if length > MAX_GATEWAY_BODY_BYTES {
        return Err("Gateway request body too large".into());
    }
    Ok(length)
}

pub fn is_http_token(value: &str) -> bool {
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

pub fn is_safe_header_value(value: &str) -> bool {
    !value.bytes().any(|byte| {
        byte == b'\r' || byte == b'\n' || (byte < 0x20 && byte != b'\t') || byte == 0x7f
    })
}

pub fn read_request(stream: &mut TcpStream) -> Result<ParsedRequest, String> {
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

pub fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn request_path(target: &str) -> Result<Url, String> {
    if !target.starts_with('/') || target.starts_with("//") {
        return Err("Gateway request target must use origin-form".into());
    }
    Url::parse(&format!("http://gateway.local{target}"))
        .map_err(|_| "Gateway request target invalid".to_string())
}

pub fn header<'a>(request: &'a ParsedRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}
