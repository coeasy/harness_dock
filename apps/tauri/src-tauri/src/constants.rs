//! Native Host policy constants.
//!
//! These values are intentionally compile-time policy, not user preferences:
//! widening a Gateway port/TTL or shutdown/retry bound changes lifecycle and
//! security behaviour and therefore belongs in reviewed source.

pub(crate) const DEFAULT_GATEWAY_PORT: u16 = 43_137;
pub(crate) const GATEWAY_PAIRING_TTL_SECS: u64 = 5 * 60;
pub(crate) const SUPERVISOR_SHUTDOWN_TIMEOUT_SECS: u64 = 30;
pub(crate) const STARTUP_PRIMARY_RETRY_ATTEMPTS: usize = 50;
pub(crate) const STARTUP_RECOVERY_RETRY_ATTEMPTS: usize = 5;
pub(crate) const STARTUP_RETRY_DELAY_MS: u64 = 100;
