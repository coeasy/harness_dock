//! Harness Runtime hosting: image resolution, spawn, recovery boot and the
//! Runtime actor control surface exposed to Tauri commands.
//!
//! Split from a single 1,553-line file into six submodules:
//!
//! | Submodule | Responsibility                                  |
//! |-----------|-------------------------------------------------|
//! | `types`   | Shared types (`RuntimeStatus`, `RuntimeProcess`) |
//! | `paths`   | Runtime image / working-directory resolution    |
//! | `config`  | Config-dump parsing and recovery planning       |
//! | `spawn`   | Process spawn, readiness probe, config dumps    |
//! | `start`   | Blocking multi-attempt start loop               |
//! | `control` | Tauri commands and lifecycle helpers            |
//!
//! The `pub(crate) use` re-exports keep every existing `crate::runtime::…`
//! call site source-compatible.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::Ordering, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, State};
use url::Url;

use crate::{
    error::{lock_err, LockRecover},
    platform, plugin_quarantine, process as process_control,
    runtime_actor::{
        CancellationToken, RuntimeActor, RuntimeGeneration, RuntimeLease, RuntimeMode, RuntimePhase,
    },
    startup_trace::{self, StartupPhase},
    AppState,
};

// `types` is deliberately `pub(crate)`: it is the only part of this module
// tree that `runtime_actor` depends on, and it must stay free of business
// logic so the actor never reaches into spawn/launch code.
mod config;
mod control;
mod paths;
mod spawn;
mod start;
pub(crate) mod types;

pub(crate) use types::*;
// Every submodule is declared `mod` (private), so the `pub` items below
// are still only reachable from inside this crate.
pub(crate) use config::*;
pub(crate) use control::*;
pub(crate) use paths::*;
pub(crate) use spawn::*;
pub(crate) use start::*;
