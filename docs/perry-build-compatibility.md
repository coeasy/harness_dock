# Perry Build Compatibility Policy

Status: Preview build policy for `feat-dual-host-perry-electron`

## Why this exists

HarnessDock currently pins Perry `v0.5.1220`. That formal release contains a prebuilt full-stdlib linker regression: targets that fall back to the published full stdlib can pull HTTP/AWS-LC symbols even when the application does not use that surface. This affected HarnessDock's macOS/Linux desktop Preview and iOS Simulator build gates.

HarnessDock does **not** patch Perry binaries, mix target libraries, or add fake application imports to hide the problem.

## Reproducible workaround

For Preview builds we use Perry's own supported optimized-stdlib path:

1. install `@perryts/perry@0.5.1220`;
2. pin the source tree behind the same release to commit `06137858dc8c6f80975238377138f2f948d6ef88`;
3. set `PERRY_WORKSPACE_ROOT` to that exact source tree;
4. let the compiler build only the runtime/stdlib features the application imports;
5. cache Cargo outputs by OS/architecture/Perry version/application source graph.

For cross-target mobile builds, the target runtime/UI archives are downloaded only from the same Perry GitHub Release. HarnessDock verifies the published archive SHA256 and `manifest.json` target/version before setting `PERRY_RUNTIME_DIR`.

Pinned cross artifacts currently used:

- iOS Simulator (`aarch64-apple-ios-sim`): `140c2dd79ffe785b142dd9c79cbda1bc02b63837a3aac2bbcd7f0de2dd99a3d6`
- Android (`aarch64-linux-android`): `66b365a385dacc7b439ab664d55fcb210b19ad85801d6e23fa5db5abd68189fe`

## What is intentionally forbidden

- silently upgrading Perry to an unpinned commit;
- downloading a cross archive without digest verification;
- linking a macOS static library into iOS or another target;
- carrying fake `node:http` imports solely to influence linking;
- compiling the official `dsh` runtime with Perry;
- allowing Perry Preview failures to block the Electron Stable release pipeline.

## Removal gate

This workaround should be removed only after a formal Perry release containing the upstream linker fix is available and all of the following pass without `PERRY_WORKSPACE_ROOT`:

- Windows thin/full;
- macOS thin/full;
- Linux thin/full;
- iOS Simulator native compile;
- Android native compile;
- Harness WebView streaming/reconnect parity smoke tests.

Until then, the compatibility code stays in CI/build infrastructure rather than the HarnessDock application runtime.