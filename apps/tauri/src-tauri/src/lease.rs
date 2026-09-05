//! Runtime lease accessors with a single, consistent failure message.
//!
//! `gateway_host.rs` and `harness_window.rs` each wrapped a Runtime lease
//! lookup in their own `ok_or_else`. The two wrappers differed only in wording,
//! which made it impossible to tell from a user report which surface failed.
//! Both now delegate here so the message stays meaningful and greppable.

use crate::runtime_actor::RuntimeLease;
use crate::AppState;

/// Live lease required by Gateway pairing/proxy operations.
///
/// This deliberately uses the *reaping* lookup: a Runtime that exited without
/// the host noticing must tear down its Gateway before any pairing or proxy
/// operation borrows it.
pub(crate) fn require_live_lease(state: &AppState) -> Result<RuntimeLease, String> {
    crate::runtime::live_lease(state)
        .ok_or_else(|| "请先启动本地 Runtime，再使用 Mobile Gateway。".to_string())
}

/// Currently published lease required by WebView navigation.
///
/// This is the *non-mutating* lookup on purpose. Navigation and page-load
/// callbacks run while a load is in flight; reaping liveness from that path can
/// revoke the very lease the in-flight navigation is built on.
pub(crate) fn require_current_lease(state: &AppState) -> Result<RuntimeLease, String> {
    crate::runtime::current_lease(state)
        .ok_or_else(|| "Runtime 尚未就绪，暂时无法打开 Harness Web。".to_string())
}

/// Returns true when `generation` is the currently published Runtime generation.
pub(crate) fn is_current_generation(state: &AppState, generation: u64) -> bool {
    crate::runtime::live_lease(state).is_some_and(|lease| lease.generation.id == generation)
}
