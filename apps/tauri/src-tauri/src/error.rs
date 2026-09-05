//! Shared error semantics for the Tauri host.
//!
//! The host previously spelled "this actor's lock is poisoned" in three
//! different Chinese strings across `runtime.rs`, `gateway_host.rs` and
//! `harness_window.rs` — 13 copies in total. Those copies drifted in wording
//! but not in meaning, which made grepping for lock failures unreliable.
//!
//! This module owns the single spelling plus the two recovery strategies the
//! host actually needs:
//!
//! * [`poisoned`] — for `map_err` sites that must surface a failure to the UI.
//! * [`LockRecover::recover`] — for internal sites that only need the data back
//!   and intentionally keep running (the actor invariants are still enforced by
//!   the state machine inside the guard).

use std::sync::{MutexGuard, PoisonError};

/// Canonical message for a poisoned actor lock.
///
/// Keeping the wording in one place means an operator can grep the produced
/// message and land here instead of hunting through three modules.
pub(crate) fn poisoned(actor: &str) -> String {
    format!("{actor} 状态锁已损坏。")
}

/// Convenience alias so call sites read `map_err(|_| lock_err("GatewayActor"))`.
pub(crate) fn lock_err(actor: &str) -> String {
    poisoned(actor)
}

/// Recovers a `MutexGuard` from a poisoned lock while preserving the data.
///
/// A poisoned lock only tells us a previous holder panicked; the state itself
/// is still structurally valid because every actor in this crate re-validates
/// its own invariants on entry. Dropping the process or resetting the state
/// would turn a recoverable hiccup into a hard failure, so the host keeps the
/// guard and continues.
pub(crate) trait LockRecover<'a, T> {
    fn recover(self, actor: &str) -> MutexGuard<'a, T>;
}

impl<'a, T> LockRecover<'a, T>
    for Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>
{
    fn recover(self, actor: &str) -> MutexGuard<'a, T> {
        self.unwrap_or_else(|error| {
            // Observable, but non-fatal: the actor state is preserved.
            eprintln!("{} Recovering preserved actor state.", poisoned(actor));
            error.into_inner()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[test]
    fn poisoned_message_is_stable_and_single_sourced() {
        assert_eq!(poisoned("RuntimeActor"), "RuntimeActor 状态锁已损坏。");
        assert_eq!(lock_err("GatewayActor"), poisoned("GatewayActor"));
    }

    #[test]
    fn recovery_keeps_data_from_a_poisoned_lock() {
        let shared = Arc::new(Mutex::new(41_u32));
        let writer = Arc::clone(&shared);
        let panicked = thread::spawn(move || {
            let mut guard = writer.lock().unwrap();
            *guard += 1;
            panic!("deliberate poisoning");
        });
        assert!(panicked.join().is_err());

        // The write before the panic survived; recovery must observe 42.
        let guard = shared.lock().recover("TestActor");
        assert_eq!(*guard, 42);
    }

    #[test]
    fn recovery_works_on_a_healthy_lock_too() {
        let shared = Mutex::new("ok".to_string());
        let guard = shared.lock().recover("TestActor");
        assert_eq!(*guard, "ok");
    }
}
