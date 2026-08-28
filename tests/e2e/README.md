# E2E smoke tests (Electron + mock dsh)

Playwright `_electron` smoke tests for the HarnessDock desktop shell (F1 of
`docs/upgrade-refactor-plan.md`). They boot the real Electron shell against a
**mock dsh** (a tiny HTTP server) so the full "start → ready → window → quit"
chain is verified without ever downloading or running a real dsh runtime.

## Run

```bash
pnpm e2e            # from the repo root (recommended)
# or
pnpm --filter ./tests/e2e test
```

`pretest` runs `pnpm --filter @dsh/desktop bundle` first so the shell is always
tested against a fresh `apps/desktop/dist/main.js`.

Requirements (all already present in this repo):

- Electron devDependency of `apps/desktop` (`node_modules/.pnpm/electron@…/…/electron.exe`),
  resolved via `require('electron')` from the desktop package.
- `@playwright/test` (workspace, `^1.55.0`, resolved to the same version as
  `tests/parity`). No browser download is needed: Electron uses its own binary.

## How the mock dsh works

`DshRuntime.start()` (from `@dsh/client-runtime`) resolves `DSH_RUNTIME=local`
to the executable in `DSH_BIN`, then waits for either `dsh web: http://127.0.0.1:<port>`
on stdout or a ready.json at `DSH_EMBEDDED_READY_FILE`.

- `tests/e2e/mock-dsh.mjs` — plain Node ESM script: listens on
  `127.0.0.1:<random port>`, prints `dsh web: …` to stdout, writes the ready
  file, serves a tiny HTML page, exposes `GET /__mock/status`, keeps the event
  loop alive, and shuts down on SIGTERM/SIGINT.
- The harness writes a `mock-dsh.cmd` wrapper (`@node "<abs>\mock-dsh.mjs"`) and
  points `DSH_BIN` at it. On Windows, `client-runtime` routes `.cmd` through
  `cmd.exe` exactly like it would run a real dsh bin.

## Environment / user-data isolation

Overriding `APPDATA`/`HOME` **breaks Electron on Windows** — `app.getPath('userData')`
throws ("Failed to get 'userData' path"), which makes `requestSingleInstanceLock()`
fail and the app quit at boot. Instead the harness:

- writes a per-test `package.json` (`name: dsh-e2e-<uuid>`) in a temp app dir,
- launches `electron <app-dir>`, so userData resolves to the real
  `%APPDATA%/dsh-e2e-<uuid>` (unique per test, removed on teardown).
- Passing the **same app name** to two launches makes them share userData — this
  is how the single-instance test works.

Other env: `DSH_RUNTIME=local`, `DSH_BIN=<tmp>/mock-dsh.cmd`,
`DSH_CUSTOM_TITLEBAR=0`, `DSH_TRAY=0`, `DSH_MOCK_PID_FILE=<tmp>/mock.pid`.

## Test entry shim

`apps/desktop/src/e2e-entry.mjs` is a **test-only** main-process entry (never
shipped). The official `dist/main.js` is an esbuild ESM bundle that inlines the
CommonJS `electron-updater` → `fs-extra` → `graceful-fs` chain; esbuild leaves
those `require('fs')`-style calls as dynamic requires, which throw under
Electron's ESM main process (no `require`). The entry installs a
`globalThis.require` (via `node:module` `createRequire`) before importing the
official bundle, which stays byte-for-byte the artifact of `pnpm bundle`.

## Tests

| File | Scenario | Notes |
| --- | --- | --- |
| `cold-start.spec.ts` | boot → main window loads the mock UI | asserts URL is the mock origin, title, rendered body, main process alive, mock status probe |
| `crash-recovery.spec.ts` | renderer crash → auto-reload | crashes via `forcefullyCrashRenderer()`, asserts main process + dsh child survive and the mock receives a second HTML request (the auto-reload) |
| `shutdown.spec.ts` | graceful quit → no orphans | drives `app.quit()` (before-quit → shutdown ladder → `app.exit(0)`), asserts exit code 0, mock HTTP down, mock pid dead, and zero processes whose command line contains `mock-dsh` |
| `single-instance.spec.ts` | second launch shares userData → exits | spawns a second raw Electron with the same app name; it must exit 0 quickly while the first keeps its window and dsh |

## Known limitations / edge cases

- **`app.evaluate()` after a renderer crash** is unreliable with Playwright +
  Electron (`Cannot find context with specified id`), so the crash test avoids it
  and asserts recovery via process/dsh/mock liveness + the mock's request counter.
- Serial execution only (`workers: 1`, `retries: 0`): each app owns its mock +
  userData, and the single-instance lock is global per app name.
- Windows-specific by design (the shell targets Windows; CIM process queries are
  used for orphan checks).
