# HarnessDock Update Architecture v2

## Goals

HarnessDock v0.2 separates **Host updates** from **dsh Runtime updates**. Electron, future Tauri and Perry must not each invent their own delivery rules. Release metadata is machine-readable, Host/Runtime versions move independently, and every update follows the same principles:

- exact package discovery instead of filename guessing;
- Full/Thin and stable/beta/nightly channel isolation;
- delta as an optimization with verified full fallback;
- download/verify/stage before activation;
- restart-aware health gates;
- last-known-good rollback and failed-candidate quarantine.

## Implemented architecture

```text
Git tag / release version
        |
        v
Release build
  |-- Host artifacts
  |-- Canonical Runtime artifacts
  |-- updater metadata (full/thin)
  `-- release-manifest.json
        |
        v
Update Planner (@dsh/bootstrap)
  |-- channel / host / platform / arch / runtime-mode matching
  |-- semantic-version comparison
  `-- delta vs full selection
        |
        +--> Host Update Adapter
        |      `-- Electron Stable/LTS today
        |
        `--> Managed Runtime Updater (Thin)
               |-- build/download Runtime delta or full archive
               |-- SHA256 + byte-size verification
               |-- versioned target directory
               |-- restart activation
               |-- dsh + Harness UI health gate
               `-- commit or last-known-good rollback
```

## 1. Automatic package discovery

`release-manifest.json` is the Host/Runtime inventory source of truth. The planner selects packages from the installed context instead of assuming that a similarly named asset is compatible.

Every artifact records:

- component: `host` or `runtime`;
- version and release channel;
- host identity when applicable;
- platform and architecture;
- runtime mode: `full`, `thin`, `system`, or `remote`;
- format (`nsis`, `dmg`, `appimage`, `deb`, `tar.gz`, ...);
- immutable SHA256 and byte size;
- optional signature asset;
- optional delta artifacts keyed by their base version/digest.

Hard rules implemented in `createUpdatePlan()`:

1. Stable never consumes beta/nightly artifacts.
2. Thin never silently becomes Full and Full never silently becomes Thin for v0.2+ channel-aware installs.
3. x64 and arm64 never cross-update.
4. Remote mobile hosts do not download desktop Runtime artifacts.
5. Older/equal semantic versions are ignored.
6. Delta is selected only when the base version matches, an advertised base digest matches when required, and the delta is smaller than full.
7. Current signed Full packages do not mutate their bundled Runtime independently; Runtime-only auto-update is enabled for managed Thin Runtime.

## 2. Host updates

Electron Stable/LTS keeps `electron-updater`, adapted to the shared policy model.

Implemented behavior:

- startup update check;
- periodic check (default every four hours);
- background download by default;
- `prompt`, `idle`, and `immediate` restart policies;
- forced relaunch after installation when automatic restart is chosen;
- Full and Thin updater channels are isolated;
- a persisted Host update recovery journal survives the installer restart;
- the new Host version is committed only after HarnessDock completes its real boot health gate.

### Host differential delivery

Windows NSIS uses sidecar blockmaps when available. The post-release metadata workflow generates a missing Setup blockmap (notably for Thin) and publishes `blockMapSize` in the channel metadata. Differential failure remains a full-installer fallback, never a correctness requirement.

Linux AppImage channel metadata reads the embedded blockmap size from the AppImage trailer so electron-updater can use its embedded differential path.

macOS currently keeps reliable full-download Host replacement in the v0.2 migration. Package filenames remain architecture-specific so x64 and arm64 selection stays safe. Tauri signed updater integration is the future primary Host path.

### v0.1.1 migration

v0.1.1 used Electron's shared default `latest*` channel for both Full and Thin. The first v0.2 channel-aware release therefore also publishes legacy aliases:

- `latest.yml` -> Full Windows metadata;
- `latest-mac.yml` -> Full macOS metadata;
- `latest-linux.yml` -> Full Linux metadata.

This is a compatibility bridge for old installations. New v0.2 packages bake explicit `full` or `thin` channels and no longer depend on the shared `latest` channel.

## 3. Runtime updates

Runtime version is independent from Host version. A valid installed state can be:

```text
HarnessDock Host 0.2.3
DeepSeek Harness Runtime 0.1.3
```

### Full packages

The signed bundled Runtime remains immutable. Updating Full means updating the Host package that carries its Runtime seed. HarnessDock does not background-modify a signed application bundle.

### Thin managed Runtime

Thin can update Runtime independently.

The updater never replaces the currently running Runtime directory. Instead:

```text
runtime-0.1.2 (healthy, running)
       |
       +---- build/download candidate ----> runtime-0.1.3
                                             |
                                             v
                                      managed-runtime.json
                                             |
                                             v
                                           restart
                                             |
                         +-------------------+-------------------+
                         |                                       |
                    health succeeds                         health fails
                         |                                       |
                         v                                       v
                  active 0.1.3                         quarantine 0.1.3
                  previous 0.1.2                       use active 0.1.2
```

Manual `origin-override.json` always takes priority. While a manual Runtime version is explicitly selected, automatic Runtime movement is paused.

## 4. True Runtime incremental updates

Runtime delta is implemented as a verified file-tree overlay, which fits the Node + dsh Runtime better than treating the complete tree as one opaque binary.

The release-side delta builder:

1. extracts previous and target canonical Runtime archives;
2. computes file/symlink inventories and SHA256s;
3. produces changed/new files under `overlay/`;
4. records removed paths;
5. records `fromTreeSha256` and `toTreeSha256`;
6. creates `HarnessDock-runtime-delta-<from>_to_<to>-<platform>-<arch>.tar.gz`;
7. publishes it only when it is smaller than the configured threshold (currently 75% of full).

The client-side delta engine verifies:

1. exact downloaded byte size;
2. delta archive SHA256;
3. safe tar entries (manifest + overlay only);
4. symlinks cannot escape the Runtime root;
5. installed base version;
6. exact base Runtime tree digest;
7. target tree digest after overlay/delete operations;
8. target Runtime version/layout;
9. full bundled Runtime integrity.

Any delta failure automatically falls back to the canonical full Runtime archive. Incremental delivery is therefore never a single point of failure.

## 5. Runtime full-package safety

Canonical full Runtime installation is also transactional:

```text
download temp
   -> byte-size / SHA256 verify
   -> extract staging
   -> manifest/version/tag/commit/platform/arch verify
   -> full Runtime integrity verify
   -> .ready
   -> atomic directory switch
```

The currently healthy Runtime is not deleted before the candidate passes validation. A failed download, damaged archive or invalid candidate cannot brick the next launch.

The v0.1.1 published Runtime artifacts are already pinned in `origin.json` with their real SHA256 and byte sizes, so this verification path works immediately.

## 6. Restart and activation policy

Host and managed Runtime use the same user-facing restart semantics:

- `prompt` (default): prepare the update, then ask before restart;
- `idle`: restart when system idle time reaches the threshold;
- `immediate`: restart as soon as the update is safely staged.

Electron policy environment variables:

- `HARNESSDOCK_UPDATE_AUTO_DOWNLOAD=0|1`
- `HARNESSDOCK_UPDATE_INSTALL_ON_QUIT=0|1`
- `HARNESSDOCK_UPDATE_RESTART=prompt|idle|immediate`
- `HARNESSDOCK_UPDATE_IDLE_SECONDS=<seconds>` (minimum 30, default 300)
- `HARNESSDOCK_UPDATE_CHECK_INTERVAL_MINUTES=<minutes>` (minimum 15, default 240)
- `HARNESSDOCK_RELEASE_MANIFEST_URL=<url>` for a managed/custom manifest source.

For Host updates, Electron uses `quitAndInstall(false, true)` so automatic installation can relaunch the new app. HarnessDock's existing `before-quit` path still stops dsh/Gateway and releases the Runtime Lease first.

For Runtime-only updates, the candidate is already installed into a separate version directory; app relaunch activates it without mutating the process that was serving the current session.

## 7. Health gates and last-known-good commit

An update is not successful merely because an installer or Runtime extraction returned exit code 0.

### Host health gate

The persisted Host journal tracks:

```text
staged -> installing -> verifying -> success/failed
```

After restart, the new Host version must complete the real HarnessDock boot path before the recovery journal is cleared.

### Managed Runtime health gate

A candidate Runtime is stricter. It is promoted to active only after all of these succeed:

1. candidate exists in the verified Runtime cache;
2. Runtime Lease can be acquired;
3. candidate `dsh web` starts and reports readiness;
4. optional Gateway starts under the prior configuration;
5. the official Harness UI window loads successfully;
6. the effective candidate origin is successfully persisted as last-known-good.

Only then does `managed-runtime.json` move the candidate to `active` and retain the old version as `previous`.

If `dsh` start fails, the shared bootstrap falls back to last-known-good and the candidate is quarantined. If full UI health or last-known-good persistence fails, the candidate is not promoted. Failed versions are remembered to avoid repeated download/restart loops.

## 8. Update transaction state

The shared planner exposes a generic transaction state machine:

```text
available
   -> downloading
   -> staged
   -> installing
   -> restarting (when needed)
   -> verifying
   -> succeeded

mutable phase -> failed -> rolled-back
```

In addition, Host recovery and managed Runtime activation have persisted state files under the Host user-data `updates/` directory. Secrets and mobile pairing credentials are intentionally excluded from these journals.

## 9. Version automation

Repository release version is synchronized through one explicit developer/release command:

```bash
pnpm version:set 0.2.0
```

It updates workspace package versions, `origin.clientVersion`, and Perry TOML version fields. Runtime version remains independent and is selected from release metadata.

The installed application automatically recognizes newer compatible semantic versions. It does **not** self-edit source-control version files; publishing a new application version remains an explicit release action.

## 10. Post-release metadata pipeline

After a successful Release workflow, `update-metadata.yml` operates on the exact published assets and adds:

- `release-manifest.json`;
- `release-manifest.sha256`;
- `full.yml`, `full-mac.yml`, `full-linux.yml`;
- `thin.yml`, `thin-mac.yml`, `thin-linux.yml`;
- one-release legacy `latest*.yml` aliases for migration;
- missing Windows NSIS Setup blockmaps;
- beneficial Runtime overlay delta archives.

Ordinary CI also runs `check:update-core`, which includes:

- strict TypeScript builds for client-runtime/bootstrap/Desktop adapters;
- syntax checks for update/release scripts;
- a behavior-level metadata smoke test with fake Full/Thin Windows, macOS and AppImage artifacts, including NSIS/AppImage blockmap metadata and legacy alias validation.

## 11. Recommended Stable defaults

```text
Host check: startup + every 4h
Host download: automatic
Host restart: prompt
Runtime check: startup-delayed + every 4h (Thin only)
Runtime delivery: delta when verified/beneficial, otherwise full
Runtime activation: restart, never hot-replace running files
Runtime rollback: automatic last-known-good + failed-version quarantine
Full bundled Runtime: immutable
Manual Runtime pin: always overrides automatic Runtime movement
```

Managed/enterprise deployments can opt into `idle` or `immediate` restart after policy review.

## 12. Remaining v0.2 gates

The core automatic-update lifecycle is implemented. The remaining work is intentionally narrower:

1. **Tauri Host adapter + signed updater integration** when Tauri becomes the official v0.2 Host.
2. **Publisher authentication** for `release-manifest.json` and Runtime artifacts. SHA256 provides integrity but not publisher identity; signed manifest/artifact verification should be mandatory for the Tauri public channel.
3. **Cross-platform automatic Host binary downgrade** after a failed Host health gate. HarnessDock already detects/persists Host failure; unattended binary downgrade should only be enabled where the platform installer guarantees a safe downgrade. Runtime rollback is already automatic.
4. **Compatibility contract fields** such as minimum/maximum Host version and Runtime protocol version once Host and Runtime begin moving on materially independent schedules.
5. Optional settings UI for update/restart policy; the Electron LTS adapter currently exposes policy primarily through environment/configuration controls.

Perry remains Experimental and must not define Stable release semantics. Electron remains the compatibility/LTS implementation while Tauri adopts the same shared update contracts instead of creating a parallel updater design.
