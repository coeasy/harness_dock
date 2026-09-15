//! Fast startup policy for V3 lifecycle.
//!
//! Uses existing runtime launch settings instead of introducing a second
//! profile system. The policy decides whether startup may skip expensive
//! recovery work while keeping RuntimeLease validation authoritative.

use crate::runtime::RuntimeStartupPolicy;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupPath {
    Fast,
    Normal,
    Recovery,
}

pub fn choose_path(policy: RuntimeStartupPolicy, cached_runtime: bool) -> StartupPath {
    match (policy, cached_runtime) {
        (RuntimeStartupPolicy::Auto, true) | (RuntimeStartupPolicy::Direct, true) => {
            StartupPath::Fast
        }
        (RuntimeStartupPolicy::Safe, _) => StartupPath::Recovery,
        _ => StartupPath::Normal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_auto_start_uses_fast_path() {
        assert_eq!(
            choose_path(RuntimeStartupPolicy::Auto, true),
            StartupPath::Fast
        );
    }
}
