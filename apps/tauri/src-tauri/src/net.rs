//! Cross-platform network helpers shared by desktop and mobile surfaces.
//!
//! This module deliberately has no `cfg(mobile)` gate: Gateway URL validation
//! runs on Android/iOS as well as desktop, so loopback admission must remain
//! available to every target.

use std::net::IpAddr;

/// Returns true when `host` names a loopback interface.
///
/// Both `localhost` and any loopback IP qualify. `Url::host_str()` keeps the
/// brackets on an IPv6 authority (`http://[::1]:8080` yields `[::1]`), so the
/// bracketed form is accepted here rather than assuming callers pre-strip it.
pub(crate) fn is_loopback(host: &str) -> bool {
    let host = host.trim();
    let unbracketed = if host.starts_with('[') && host.ends_with(']') {
        &host[1..host.len() - 1]
    } else {
        host
    };
    unbracketed.eq_ignore_ascii_case("localhost")
        || unbracketed
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_recognised() {
        assert!(is_loopback("localhost"));
        assert!(is_loopback("LOCALHOST"));
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.7.7.7"));
        assert!(is_loopback("::1"));
        assert!(is_loopback("[::1]"));
        assert!(is_loopback("  localhost  "));
    }

    #[test]
    fn non_loopback_hosts_are_rejected() {
        assert!(!is_loopback("example.com"));
        assert!(!is_loopback("192.168.1.1"));
        assert!(!is_loopback("10.0.0.1"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback(""));
        assert!(!is_loopback("999.999.999.999"));
        assert!(!is_loopback("[192.168.1.1]"));
        assert!(!is_loopback("[::ffff:10.0.0.1]"));
    }
}
