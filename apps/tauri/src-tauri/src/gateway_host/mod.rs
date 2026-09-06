//! Host-embedded Mobile Gateway: a loopback HTTP server that pairs paired
//! devices to the local Harness Runtime and proxies authenticated traffic to
//! it.
//!
//! Split from a single 1,453-line file into eight submodules:
//!
//! | Submodule    | Responsibility                              |
//! |--------------|---------------------------------------------|
//! | `types`      | Wire types, limits, registry state          |
//! | `server`     | Live process handle and shutdown            |
//! | `lifecycle`  | Phase machine, validation, spawn/stop       |
//! | `connection` | Accept loop and connection bookkeeping      |
//! | `request`    | HTTP request parsing and validation         |
//! | `handler`    | Routing, pairing and upstream proxy         |
//! | `http_io`    | Response writers                            |
//! | `commands`   | Tauri command surface                       |
//!
//! The `pub(crate) use` re-exports keep every existing `crate::gateway_host::…`
//! call site source-compatible.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
use tauri::{AppHandle, State};
use url::Url;

// Randomness, loopback checks and Runtime lease access now live in shared
// modules (`crypto` / `util` / `lease`) so the Gateway no longer carries a
// second copy of helpers that also exist in `runtime_actor` and
// `harness_window`.
use crate::crypto::{pairing_code, random_hex};
use crate::error::lock_err;
use crate::lease::{is_current_generation, require_live_lease};
use crate::util::{is_loopback, rfc3339};
use crate::{runtime_actor::RuntimeLease, AppState};

mod commands;
mod connection;
mod handler;
mod http_io;
mod lifecycle;
mod request;
mod server;
mod types;

pub(crate) use commands::*;
pub(crate) use connection::*;
pub(crate) use handler::*;
pub(crate) use http_io::*;
pub(crate) use lifecycle::*;
pub(crate) use request::*;
pub(crate) use server::*;
pub(crate) use types::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_actor::{RuntimeGeneration, RuntimeMode};

    #[test]
    pub fn gateway_public_url_is_https_or_loopback_debug_only() {
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
    pub fn gateway_port_avoids_privileged_ports() {
        assert_eq!(validated_gateway_port(None).unwrap(), 43137);
        assert_eq!(validated_gateway_port(Some(1024)).unwrap(), 1024);
        assert!(validated_gateway_port(Some(443)).is_err());
    }

    #[test]
    pub fn gateway_request_body_limit_is_fail_closed() {
        assert_eq!(validated_content_length("0").unwrap(), 0);
        assert_eq!(
            validated_content_length(&MAX_GATEWAY_BODY_BYTES.to_string()).unwrap(),
            MAX_GATEWAY_BODY_BYTES
        );
        assert!(validated_content_length(&(MAX_GATEWAY_BODY_BYTES + 1).to_string()).is_err());
        assert!(validated_content_length("not-a-number").is_err());
    }

    #[test]
    pub fn gateway_request_target_must_be_origin_form() {
        assert!(request_path("/api/harnessdock/health").is_ok());
        assert!(request_path("https://evil.example/path").is_err());
        assert!(request_path("//evil.example/path").is_err());
    }

    #[test]
    pub fn gateway_rejects_header_injection_bytes() {
        assert!(is_http_token("X-HarnessDock-Test"));
        assert!(!is_http_token("X HarnessDock"));
        assert!(is_safe_header_value("text/plain; charset=utf-8"));
        assert!(!is_safe_header_value("ok\r\nX-Injected: yes"));
    }

    #[test]
    pub fn connect_requires_exactly_one_non_empty_token() {
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
    pub fn connect_ticket_is_not_consumed_by_unsupported_http_methods() {
        let shared = test_gateway_shared();
        let now = SystemTime::now();
        {
            let mut registry = shared.registry.lock().unwrap();
            registry.sessions.insert(
                "session-1".into(),
                SessionState {
                    id: "device-1".into(),
                    name: "test device".into(),
                    paired_at: now,
                    last_seen_at: now,
                    expires_at: now + Duration::from_secs(600),
                    bootstrapped: false,
                },
            );
            registry.connect_tickets.insert(
                "ticket-1".into(),
                ConnectTicket {
                    token: "ticket-1".into(),
                    session_token: "session-1".into(),
                    expires_at: now + Duration::from_secs(90),
                },
            );
        }

        let rejected = gateway_exchange(&shared, "POST", "/api/harnessdock/connect?token=ticket-1");
        assert!(rejected.starts_with("HTTP/1.1 405 Method Not Allowed"));
        assert!(shared
            .registry
            .lock()
            .unwrap()
            .connect_tickets
            .contains_key("ticket-1"));

        let redeemed = gateway_exchange(&shared, "GET", "/api/harnessdock/connect?token=ticket-1");
        assert!(redeemed.starts_with("HTTP/1.1 303 See Other"));
        assert!(redeemed.contains("Set-Cookie: hd_session=session-1;"));
        assert!(!shared
            .registry
            .lock()
            .unwrap()
            .connect_tickets
            .contains_key("ticket-1"));
    }

    #[test]
    pub fn stop_during_gateway_start_invalidates_the_old_generation() {
        let mut actor = GatewayActorState::default();
        let first = actor.begin_start().unwrap();
        assert_eq!(actor.phase(), GatewayPhase::Starting);

        assert!(actor.begin_stop().is_none());
        assert_eq!(actor.phase(), GatewayPhase::Stopping);
        actor.settle_stopped();
        actor.fail(first);
        assert_eq!(actor.phase(), GatewayPhase::Stopped);

        let second = actor.begin_start().unwrap();
        assert!(second > first);
        assert_eq!(actor.phase(), GatewayPhase::Starting);
    }

    #[test]
    pub fn cookies_are_parsed_without_exposing_other_values() {
        assert_eq!(
            cookie_value("a=1; hd_session=abc; b=2", "hd_session"),
            Some("abc".into())
        );
        assert_eq!(cookie_value("a=1", "hd_session"), None);
    }

    #[test]
    pub fn upstream_connect_is_bounded_and_uses_resolved_socket_addresses() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let connected = connect_upstream("127.0.0.1", port).unwrap();
        assert_eq!(connected.peer_addr().unwrap().port(), port);
    }

    fn test_gateway_shared() -> Arc<GatewayShared> {
        Arc::new(GatewayShared {
            registry: Mutex::new(GatewayRegistry::default()),
            runtime_lease: RuntimeLease {
                generation: RuntimeGeneration {
                    id: 1,
                    nonce: "test-nonce".into(),
                    image_identity: "test-image".into(),
                    mode: RuntimeMode::Normal,
                },
                pid: 1,
                origin: "http://127.0.0.1:43138".into(),
                launch_url: "http://127.0.0.1:43138/launch".into(),
                dsh_version: "test".into(),
            },
            public_url: "http://127.0.0.1:43137/".into(),
            secure_cookie: false,
            stop: Arc::new(AtomicBool::new(false)),
            active_connections: AtomicUsize::new(0),
            next_connection_id: AtomicUsize::new(1),
            connection_streams: Mutex::new(HashMap::new()),
            connection_workers: Mutex::new(Vec::new()),
        })
    }

    fn gateway_exchange(shared: &Arc<GatewayShared>, method: &str, target: &str) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(address).unwrap();
        let (server, peer) = listener.accept().unwrap();
        let request = format!(
            "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        client.write_all(request.as_bytes()).unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        handle_connection(server, peer, 1, Arc::clone(shared)).unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        response
    }
}
