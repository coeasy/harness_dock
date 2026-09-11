//! Harness Runtime hosting: image resolution, spawn, recovery boot and the
//! Runtime actor control surface exposed to Tauri commands.
//!
//! Split into focused submodules so lifecycle ownership, launch policy and
//! recovery behavior remain explicit.

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

mod config;
mod control;
mod launch_settings;
mod paths;
mod spawn;
mod start;
pub(crate) mod types;

pub(crate) use config::*;
pub(crate) use control::*;
pub(crate) use launch_settings::*;
pub(crate) use paths::*;
pub(crate) use spawn::*;
pub(crate) use start::*;
pub(crate) use types::*;
