# HarnessDock Production Architecture V2

Status: Proposed  
Scope: post-`v0.1.6-alpha.2` production hardening  
Target branch: `feature/supervisor-v2`

## 1. Product boundary

HarnessDock is a Tauri-only desktop runtime orchestrator for DeepSeek Harness. It is responsible for:

- locating and verifying the bundled Harness Runtime;
- launching and supervising Harness Web;
- owning every process started for one desktop session;
- isolating plugin failures without preventing Harness Web startup;
- providing private Rescue Web startup when the user profile is unhealthy;
- producing actionable diagnostics;
- performing verified, rollback-capable client/runtime updates.

HarnessDock does **not** own model logic, Harness upstream business logic, a second plugin runtime, or an Electron compatibility layer.

## 2. Core invariants

1. Launching the desktop client must always attempt Harness Web.
2. Plugin failure must not prevent the official Harness Web profile from becoming usable when recovery is possible.
3. Closing the desktop client must leave zero HarnessDock-owned Runtime/Node/helper processes.
4. A failed or partial startup must not leak a process tree, temporary Runtime lease, writer lock, or stale ready marker.
5. Recovery must never mutate or delete the user's profile as a hidden side effect.
6. Quarantine state must be bound to the exact Runtime version/image/scope that produced it.
7. Runtime/client updates must be verified before activation and rollback-capable after activation.
8. Release artifacts must be reproducible from one exact commit SHA and verified before publication.

## 3. Target architecture

```text
Tauri UI / Menu
      |
      v
HostKernel / Reconciler
      |
      v
RuntimeSupervisor
  |       |        |        |
  |       |        |        +--> DiagnosticStore
  |       |        +-----------> RecoveryManager
  |       +--------------------> PluginIsolationManager
  +----------------------------> ProcessOwnershipRegistry
      |
      v
RuntimeManager
      |
      v
DeepSeek Harness Runtime -> Harness Web
```

The UI never directly manipulates processes. All start/restart/isolate/restore/exit commands pass through HostKernel/Reconciler into RuntimeSupervisor.

## 4. RuntimeSupervisor V2

### 4.1 State machine

```rust
enum RuntimeState {
    Init,
    CheckingEnvironment,
    LoadingRuntime,
    Starting,
    WaitingRuntimeReady,
    WaitingWebReady,
    Healthy,
    Degraded,
    Recovering,
    ShuttingDown,
    Stopped,
    Failed,
}
```

Allowed transitions are explicit. Every transition records:

- generation/session id;
- previous and next state;
- monotonic timestamp;
- reason/error code;
- Runtime image identity;
- active profile/recovery scope.

Unexpected transitions fail closed and are reported rather than silently continuing.

### 4.2 Startup contract

A startup generation is successful only after all of the following are true:

1. Runtime image verification passed.
2. child process ownership was registered;
3. ready endpoint was produced;
4. launch-token authentication succeeded;
5. at least two consecutive clean-URL HTML probes succeeded;
6. Runtime process is still alive;
7. the generation is still current and has not been superseded by restart/exit.

Each phase has a bounded deadline and cleanup path.

## 5. Process Ownership V2

Each spawned process is owned by one immutable generation/session.

```rust
struct OwnedProcess {
    pid: u32,
    role: ProcessRole,
    generation: u64,
    session_id: SessionId,
    started_at: Instant,
}
```

Windows:
- assign children to a Job Object with `KILL_ON_JOB_CLOSE`;
- retain the Job handle for the lifetime of the resource owner;
- terminate rooted process tree while parent PID is valid;
- after parent exit, terminate residual descendants through owned Job handle only.

POSIX:
- one managed process group per spawn generation;
- TERM group, bounded grace, KILL group;
- after parent reap, never fall back to the reusable numeric parent PID.

## 6. Shutdown contract

```text
request_exit
 -> freeze spawn admission
 -> stop accepting restart/recovery commands
 -> revoke active RuntimeLease
 -> request graceful Runtime shutdown
 -> bounded grace period
 -> terminate remaining owned process tree
 -> wait/reap
 -> verify no owned processes remain
 -> remove generation temp state
 -> destroy windows
 -> exit host
```

The shutdown result is recorded as a structured report containing duration, graceful/forced terminations and leaked-process count.

Release gate invariant: leaked owned process count must equal zero.

## 7. Health model

Do not equate `ready.json` with healthy.

A generation is healthy only when process, endpoint, auth and Web checks all agree. Health should expose a typed internal snapshot:

```json
{
  "state": "healthy",
  "generation": 42,
  "runtimeVersion": "0.1.6-alpha.2",
  "imageIdentity": "sha256:...",
  "profile": "web",
  "runtimePid": 1234,
  "webReady": true,
  "consecutiveHealthyProbes": 2
}
```

Transient probe failures move to Degraded first; repeated failures may trigger Recovering according to policy.

## 8. Recovery / Rescue Web V2

Recovery must use a generation-private Harness home and never rewrite the user's damaged profile in place.

```text
normal start failure
 -> classify failure
 -> persist failure record
 -> create generation-private rescue-dsh-home
 -> start official Web profile only
 -> verify Web health
 -> publish recovery diagnostics
```

A recovery record contains:

- failure class;
- exact Runtime version/image identity;
- failed profile;
- plugin id when relevant;
- attempt generation;
- timestamps;
- source log references.

User profile repair is a separate explicit operation.

## 9. Plugin Isolation Manager V2

### 9.1 States

```text
Installed -> Validating -> Active
                      \-> Failed -> Quarantined -> Recovering -> Active
```

### 9.2 Failure classes

- LoadError
- RuntimeApiMismatch
- VersionMismatch
- PermissionDenied
- UserConfigurationError
- TransientNetworkError
- Unknown

Only deterministic plugin/runtime failures are automatically quarantined. Transient infrastructure failures should not permanently disable a plugin.

### 9.3 Quarantine identity

Persisted quarantine is valid only when all match:

- schema version;
- exact dsh prerelease version;
- exact Runtime image identity;
- exact launch scope/profile;
- plugin id/source identity.

HarnessDock integrations and official DeepSeek rows must never be automatic quarantine targets.

## 10. Runtime Update V2

Use staged A/B activation:

```text
download
 -> verify manifest + SHA256
 -> install inactive Runtime slot
 -> offline integrity verification
 -> preflight smoke
 -> atomically activate
 -> launch health check
 -> commit activation
```

On failure after activation, revert to the previously healthy slot.

Never overwrite the only healthy Runtime in place.

## 11. Configuration ownership

Recommended configuration layers:

1. explicit launch arguments;
2. HarnessDock user configuration;
3. shipped defaults.

Separate HarnessDock-owned configuration from upstream Harness profile files.

```text
config/
  app.json
  runtime.json
  update.json
  diagnostics.json
```

Plugin/profile business configuration remains owned by DeepSeek Harness.

## 12. Diagnostics

Every launch has a session id and generation id shared by:

- host log;
- Runtime stdout/stderr;
- startup trace;
- process ownership events;
- recovery records;
- quarantine records.

Diagnostic export should redact tokens/secrets and package:

```text
diagnostics/
  summary.json
  app.log
  runtime/
  startup-trace.log
  process.json
  recovery.json
  quarantine.json
```

Logs are bounded/rotated.

## 13. CI architecture

### PR fast gates

- formatting;
- lint/static checks;
- unit tests;
- parity/contract tests;
- Rust checks;
- source-runtime compatibility.

### PR packaged lifecycle gate

Windows one-click artifact must prove:

1. clean install;
2. normal Harness Web startup;
3. launch-token + clean URL health;
4. graceful close leaves zero owned Runtime/Node/Host processes;
5. corrupted user profile enters private Rescue and reaches healthy Web;
6. broken third-party plugin is quarantined and healthy Web is restored.

### Post-merge candidate gate

- build exact main SHA for every release platform;
- generate checksums/manifest;
- Windows packaged startup;
- artifact identity verification;
- release only exact candidate SHA.

### Nightly resilience gate

- repeated restart cycles;
- forced Runtime crash;
- stuck child/helper;
- upgrade/rollback;
- plugin incompatibility;
- corrupted configuration;
- process leak stress.

## 14. Version roadmap

### v0.1.6-alpha.2
Scope freeze:
- lifecycle leak fixes;
- exact Runtime alignment;
- quarantine identity v4;
- reliable Windows packaged smoke;
- CI green.

### v0.1.7-beta
- RuntimeSupervisor V2;
- explicit state machine;
- health snapshot;
- structured recovery;
- shutdown report;
- diagnostic center foundation.

### v0.2.0
- A/B Runtime update/rollback;
- full Plugin Isolation Manager V2;
- diagnostic export;
- resilience/nightly gates;
- production release manifest/signature policy.

## 15. Migration rule

Do not retain parallel V1/V2 control paths. Introduce V2 behind the existing HostKernel/Reconciler boundary, migrate one lifecycle responsibility at a time, and remove the replaced V1 path in the same phase. Electron compatibility must not be reintroduced.

## 16. Acceptance criteria

Production architecture is complete only when:

- every Runtime/helper process has one owner;
- every start/restart/exit is represented by the state machine;
- every generation has bounded startup/shutdown deadlines;
- startup and shutdown are idempotent under repeated UI commands;
- corrupted profile and broken plugin recovery are both packaged-artifact tested;
- no release can publish without exact-SHA artifact checksums and packaged startup proof;
- update failure can return to a previously healthy Runtime without reinstalling the desktop client.
