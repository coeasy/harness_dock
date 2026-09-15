# HarnessDock Architecture V3 Platform Upgrade Plan

## Overview

HarnessDock V3 upgrades the project from a desktop wrapper into a DeepSeek Harness Runtime Platform.

Goals:

- Keep official DeepSeek Harness Web UI unchanged.
- Maintain Tauri-only native host architecture.
- Improve startup, shutdown, runtime lifecycle and diagnostics.
- Prepare plugin ecosystem and enterprise deployment capabilities.

## Target Architecture

```
HarnessDock Platform

+-----------------------------+
| Host Platform Kernel        |
+-----------------------------+
        |
        +-----------------------------+
        |             |               |
 Runtime Plane  Experience Plane  Control Plane
        |             |               |
 RuntimeManager WindowManager   UpdateManager
 RuntimeHealth  UI Shell        Diagnostics
 ProcessMgr     Menu Service    Security
 PluginManager Gateway         Config
```

## Runtime Platform

Introduce a unified runtime layer:

```
runtime-platform/
  runtime-manager
  runtime-supervisor
  runtime-health
  runtime-upgrade
  runtime-rollback
  runtime-cache
```

Responsibilities:

- Spawn pinned dsh runtime.
- Verify runtime identity.
- Monitor health.
- Recover crashed runtime.
- Support upgrade and rollback.

## Startup Architecture

Replace blocking startup with orchestration:

```
BOOT
 |
Splash
 |
Create Window
 |
Async Runtime Start
 |
Health Probe
 |
Web Ready
 |
Shell Attach
 |
READY
```

Targets:

- First visible window < 500ms.
- Runtime startup without blocking UI.
- Clear failure state.

## Shutdown Architecture

Introduce Lifecycle Manager:

```
RUNNING
 |
SHUTDOWN_REQUEST
 |
UI_CLOSE
 |
Runtime Stop
 |
Process Cleanup
 |
Lease Release
 |
EXIT
```

Goals:

- Immediate UI response.
- No orphan dsh/node processes.
- Deterministic cleanup.

## Plugin Platform

Upgrade plugin handling into a lifecycle system:

```
Install
 |
Verify
 |
Enable
 |
Running
 |
Health Check
 |
Quarantine
 |
Restore
```

Plugin metadata:

```json
{
  "id": "",
  "version": "",
  "state": "running",
  "health": "ok"
}
```

## Diagnostics Center

Unified diagnostics:

- Runtime status.
- Plugin status.
- WebView health.
- Network checks.
- Update state.
- Crash reports.

Support one-click diagnostic export.

## Update Platform

Upgrade flow:

```
Check
 |
Download
 |
Verify SHA256
 |
Backup
 |
Install
 |
Health Check
 |
Rollback
```

## Performance Monitoring

Collect:

- startup duration.
- runtime ready time.
- web ready time.
- shutdown duration.
- process count.
- memory usage.

## Security Model

Continue zero-trust boundary:

```
WebView
 |
Capability Broker
 |
Host Kernel
 |
Native Action
```

No direct high privilege access from WebView or plugins.

## Implementation Roadmap

### Phase 1

- dsh-v0.1.6-alpha.1 alignment.
- Startup orchestrator.
- Shutdown manager.
- Runtime supervisor.
- Diagnostics foundation.

### Phase 2

- Plugin runtime manager.
- Update platform.
- Performance dashboard.
- Desktop E2E tests.

### Phase 3

- Enterprise deployment.
- Multi-profile runtime management.
- Plugin ecosystem.
- Remote management.
