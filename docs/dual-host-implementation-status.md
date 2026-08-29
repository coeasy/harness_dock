# Dual-Host Implementation Status

> Branch: `feat-dual-host-perry-electron`  
> Goal: keep Electron Stable while adding Perry Native Preview as an independently packaged desktop host.

## Implemented in this branch

- Shared desktop-host descriptors and capability flags in `@dsh/bootstrap`.
- Cross-host global runtime lease under `~/.harnessdock/runtime` with stale-owner recovery.
- Electron Stable acquires/releases the shared runtime lease without changing its app ID or updater channel.
- Perry Native Preview host under `apps/perry/`.
- Perry host keeps official `dsh web`, official Harness Web UI, `~/.dsh`, version pinning, runtime cache and rollback logic.
- Host-owned Perry data is isolated from Electron host data.
- Thin Perry packages use the pinned download runtime mode; Full Perry packages bundle the existing prepared Node + dsh runtime.
- Side-by-side product identity: `HarnessDock` / `com.dsh.client` vs `HarnessDock Native Preview` / `com.dsh.client.perry.preview`.
- Perry packaging: Windows portable ZIP, macOS ZIP + DMG, Linux tar.gz + DEB, each with SHA-256 sidecars.
- Dedicated `perry-preview` Actions workflow so Preview failures do not block the mature Electron Stable release workflow.

## Intentional Preview limitations

Perry's current native WebView explicitly treats these as non-goals: Electron/Tauri-style native<->JS RPC, file downloads, DevTools, custom protocol handlers, service workers, and several browser permission surfaces. HarnessDock therefore marks Perry capabilities pessimistically and keeps Electron Stable as the compatibility fallback.

The Perry build is not allowed to replace Electron Stable until real Windows/macOS/Linux parity covers at least:

- Harness SPA hydration and reconnect;
- streaming + WebSocket sessions;
- provider/model/workspace/session/approval flows;
- plugin/MCP/Skill views;
- upload/file picker;
- download/export/blob URL behavior;
- clipboard and keyboard/IME behavior;
- storage persistence and upgrades;
- external navigation and OAuth;
- clean shutdown, crash recovery and stale runtime lease recovery.

## Migration order

1. Dual-host foundations + Runtime Lease.
2. Perry portable/full build validation.
3. Real Harness UI parity matrix on all three desktop OSes.
4. Native diagnostics/tray/update adapters only after WebView parity is proven.
5. Promote Perry platform-by-platform; never require all three OSes to switch together.
6. If Perry remains lighter but cannot cover browser-heavy flows, keep long-term `Native` and `Compatibility` distributions instead of forcing a single-host architecture.
