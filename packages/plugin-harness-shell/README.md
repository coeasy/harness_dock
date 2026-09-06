# @dsh/plugin-harness-shell

Portable Harness Web shell for dsh hosts.

The package contains a versioned `manifest.json`, a Node dsh plugin entrypoint, and the browser asset at `web/shell.js`. The public bridge contract is defined once in `protocol/shell-contract.json`; generated consumers currently expose `SHELL_API_VERSION = 2`.

```bash
pnpm add @dsh/plugin-harness-shell
```

If a host does not implement a command, set that capability to `false`; the shell hides the corresponding menu item and leaves the Harness Web surface running. Hosts must not invent additional web-reachable commands outside the canonical contract.
