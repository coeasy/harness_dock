//! Harness main-window surface: splash / control panels, lease-bound
//! navigation, WebView lifecycle and the native window commands.
//!
//! Split from a single 853-line file into four submodules:
//!
//! | Submodule    | Responsibility                                |
//! |--------------|-----------------------------------------------|
//! | `splash`     | Splash, control and startup-recovery panels   |
//! | `navigation` | URL validation, lease guard, watchdog, claims |
//! | `window`     | WebView creation and restart orchestration    |
//! | `commands`   | Tauri command surface                         |
//!
//! The `pub(crate) use` re-exports keep every existing `crate::harness_window::…`
//! call site source-compatible.

#[cfg(not(mobile))]
use crate::harness_shell::init_script;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use url::Url;

#[cfg(not(mobile))]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::error::lock_err;
use crate::surface_actor::{SurfaceOperation, SurfacePhase};

mod commands;
mod navigation;
mod splash;
mod window;

pub(crate) use commands::*;
pub(crate) use navigation::*;
pub(crate) use splash::*;
pub(crate) use window::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub fn runtime_url_matches_the_exact_loopback_capability_boundary() {
        assert!(validated_runtime_url("http://127.0.0.1:4321/").is_ok());
        assert!(validated_runtime_url("https://localhost:4321/").is_err());
        assert!(validated_runtime_url("http://localhost:4321/").is_err());
        assert!(validated_runtime_url("http://example.com:4321/").is_err());
    }

    #[test]
    pub fn only_nonempty_token_is_launch_credential() {
        assert!(has_launch_token(
            &validated_runtime_url("http://127.0.0.1:4321/?token=x").unwrap()
        ));
        assert!(!has_launch_token(
            &validated_runtime_url("http://127.0.0.1:4321/?tab=plugins").unwrap()
        ));
    }

    #[cfg(not(mobile))]
    #[test]
    pub fn bootstrap_navigation_is_exactly_the_local_tauri_asset() {
        for value in [
            "tauri://localhost/splash.html",
            "http://tauri.localhost/splash.html",
            "https://tauri.localhost/splash.html",
        ] {
            assert!(is_harness_bootstrap_url(&Url::parse(value).unwrap()));
        }
        for value in [
            "https://example.com/splash.html",
            "http://127.0.0.1:4321/splash.html",
            "http://tauri.localhost/splash.html?token=x",
            "http://tauri.localhost/../splash.html",
            "http://user@tauri.localhost/splash.html",
        ] {
            assert!(
                !is_harness_bootstrap_url(&Url::parse(value).unwrap()),
                "accepted non-local bootstrap URL: {value}"
            );
        }
    }

    #[cfg(not(mobile))]
    #[test]
    pub fn listener_probe_distinguishes_live_and_refused_loopback_ports() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = validated_runtime_url(&format!("http://127.0.0.1:{port}/")).unwrap();
        assert!(super::runtime_listener_reachable(&url));
        drop(listener);
        assert!(!super::runtime_listener_reachable(&url));
    }
}
