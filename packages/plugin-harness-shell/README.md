# @dsh/plugin-harness-shell

Portable Harness Web shell for dsh hosts.

The package contains a versioned `manifest.json`, a Node dsh plugin entrypoint, and the browser asset at `web/shell.js`. Hosts may install it independently and map the `SHELL_API_VERSION = 1` commands to their own window/runtime/update services.

```bash
pnpm add @dsh/plugin-harness-shell
```

If a host does not implement a command, set that capability to `false`; the shell hides the corresponding menu item and leaves the Harness Web surface running.
