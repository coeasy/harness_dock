# HarnessDock Update Architecture v2

## Goals

HarnessDock v0.2 separates **Host updates** from **dsh Runtime updates**. Electron, Tauri and Perry must not each invent their own runtime delivery rules. The release system produces one machine-readable manifest and every host applies the same selection, verification, staging and rollback policy.

## Components

```text
Git tag / release version
        |
        v
Release build
  |-- Host artifacts (Electron/Tauri/Perry)
  |-- Canonical Runtime artifacts
  |-- updater metadata (full/thin channels)
  `-- release-manifest.json
        |
        v
Update Planner (@dsh/bootstrap)
  |-- host/platform/arch matching
  |-- stable/beta/nightly channel matching
  |-- full/thin/system/remote mode matching
  |-- semver ordering
  `-- delta vs full delivery selection
        |
        +--> Host Update Adapter
        |      |-- Electron: electron-updater / blockmap
        |      |-- Tauri: signed updater artifact
        |      `-- Perry: Experimental adapter
        |
        `--> Runtime Update Adapter
               |-- SHA256 + byte-size verification
               |-- staging directory
               |-- integrity validation
               |-- atomic directory swap
               `-- last-known-good rollback
```

## 1. Automatic package discovery

`release-manifest.json` is the source of truth. Package selection is never based only on a filename guessed by the client.

Each artifact carries:

- component: `host` or `runtime`;
- version and release channel;
- host (`electron`, future `tauri`, `perry-*`) when applicable;
- platform and architecture;
- runtime mode: `full`, `thin`, `system`, or `remote`;
- format (`nsis`, `dmg`, `appimage`, `deb`, `tar.gz`, ...);
- immutable SHA256 and byte size;
- signature asset when available;
- optional delta artifacts keyed by the installed base version/digest.

The client builds an `InstalledUpdateContext` and `createUpdatePlan()` returns exactly one compatible Host artifact plus at most one compatible Runtime artifact.

### Hard rules

1. Stable never consumes beta/nightly artifacts.
2. Thin never silently becomes Full and Full never silently becomes Thin.
3. x64 and arm64 never cross-update.
4. A Remote mobile host never downloads a desktop Runtime.
5. An artifact older than or equal to the installed semantic version is ignored.
6. A delta is selected only when its `fromVersion` (and optional base digest) match and it is smaller than the full artifact.

## 2. Full vs incremental delivery

### Host update

Electron Stable keeps electron-updater. Windows NSIS can use blockmap differential downloads when metadata is present. Tauri becomes the primary v0.2 release host and uses its signed updater package; full-package download remains the guaranteed fallback.

Host binary delta must never be required for correctness. If delta metadata is missing, corrupted, incompatible or larger than the full package, the updater falls back to the full signed installer.

### Runtime update

Runtime updates are independent from Host updates.

The guaranteed path is the canonical full Runtime archive. Before commit HarnessDock verifies:

1. HTTP transfer completed;
2. exact byte size when supplied;
3. archive SHA256 when supplied;
4. Runtime manifest version / upstream tag / commit;
5. platform and architecture;
6. complete bundled Runtime integrity.

Only then is the staged Runtime atomically swapped into the active Runtime directory. The existing active Runtime is not deleted before the candidate passes verification.

The v2 manifest already models Runtime delta artifacts. Runtime overlay patch generation/application is the next optimization layer; it must always retain the full archive as fallback.

## 3. Automatic restart

Restart is policy-driven, not hard-coded.

Electron currently supports:

- `prompt` (default): download automatically, ask before restart;
- `idle`: restart when system idle time reaches the configured threshold;
- `immediate`: install and relaunch as soon as download completes.

Environment controls for the Electron LTS adapter:

- `HARNESSDOCK_UPDATE_AUTO_DOWNLOAD=0|1`
- `HARNESSDOCK_UPDATE_INSTALL_ON_QUIT=0|1`
- `HARNESSDOCK_UPDATE_RESTART=prompt|idle|immediate`
- `HARNESSDOCK_UPDATE_IDLE_SECONDS=<seconds>` (minimum 30, default 300)
- `HARNESSDOCK_UPDATE_CHECK_INTERVAL_MINUTES=<minutes>` (minimum 15, default 240)

`quitAndInstall(false, true)` forces the newly installed application to relaunch. HarnessDock's existing `before-quit` shutdown path is still used, so the dsh process, Gateway and Runtime Lease are shut down before the Host exits.

Tauri must implement the same policy contract instead of introducing another set of user semantics.

## 4. Update transaction state machine

Every future unified updater uses the same states:

```text
available
   -> downloading
   -> staged
   -> installing
   -> restarting (Host update)
   -> verifying
   -> succeeded

Any mutable phase -> failed -> rolled-back
```

Invalid state transitions are rejected. This prevents duplicate downloads, double installs and partially committed updates.

A persisted transaction journal is the next step for cross-process recovery. It should contain transaction ID, previous versions, target versions, attempt count, phase and health-check deadline, but never credentials or pairing secrets.

## 5. Post-update health gate

An update is not considered successful merely because the installer exited with code 0.

After restart the Host must verify:

1. application version is the expected target;
2. Runtime Lease can be acquired;
3. expected Runtime version can be resolved;
4. `dsh web` starts and reaches readiness;
5. official Harness UI loads;
6. embedded client handshake succeeds;
7. optional Gateway remains disabled/enabled according to the previous setting.

Only after the health gate passes may the transaction become `succeeded` and the old Runtime / rollback package be pruned.

## 6. Rollback policy

### Runtime

Runtime rollback is mandatory and can be automatic because Runtime directories are under HarnessDock control. Candidate updates are staged and verified before atomic swap; last-known-good remains recoverable until health verification completes.

### Host

Host rollback depends on the platform installer. The v0.2 design keeps the previous installer/update artifact cached until the new version passes the health gate. Automatic binary rollback is enabled only on platforms where the installer guarantees a safe unattended downgrade. Otherwise the client presents a one-click recovery action using the cached prior installer.

## 7. Version automation

Repository version is synchronized by one command:

```bash
pnpm version:set 0.2.0
```

It updates package versions, `origin.clientVersion` and Perry TOML version fields. `pnpm check:versions` remains the release gate.

Runtime version is deliberately independent from HarnessDock Host version. A valid state can therefore be:

```text
HarnessDock Host 0.2.3
DeepSeek Harness Runtime 0.1.3
```

Updating one does not require rebuilding the other unless compatibility metadata says so.

## 8. Release metadata generation

After a successful Release workflow, `update-metadata.yml` downloads the immutable release assets and publishes:

- `release-manifest.json`;
- `release-manifest.sha256`;
- `full.yml`, `full-mac.yml`, `full-linux.yml`;
- `thin.yml`, `thin-mac.yml`, `thin-linux.yml`.

This keeps Full and Thin updater channels isolated and gives future Tauri/Perry adapters the same artifact inventory.

## 9. Recommended defaults

Public Stable defaults:

```text
check: periodic (startup + every 4h)
download: automatic
install: on quit / user confirmation
restart: prompt
Runtime delta: prefer when verified and smaller, otherwise full
Host delta: platform updater when supported, otherwise full
rollback: automatic for Runtime, guarded for Host
```

Managed/enterprise deployments can opt into `idle` or `immediate` restart after their own policy review.

## 10. Remaining v0.2 implementation gates

- Tauri Host adapter and signed updater integration.
- Persisted cross-process update transaction journal.
- Post-restart health commit / cached Host rollback.
- Runtime overlay delta builder + apply engine.
- Signature verification for `release-manifest.json` and Runtime artifacts (SHA256 is integrity, not publisher authentication).
- Compatibility rules (`minHostVersion`, `maxHostVersion`, Runtime protocol version) in Manifest v3 once Tauri and Runtime evolve independently.
