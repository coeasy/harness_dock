// src/index.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var name = "harness-shell";
var inject = [];
var version = "0.1.5";
var apiVersion = 2;
var service = {
  pluginId: name,
  version,
  apiVersion,
  webEntry: fileURLToPath(new URL("../web/shell.js", import.meta.url)),
  // Must stay identical to SHELL_COMMANDS: this is the web-reachable set, so
  // anything `capability_broker.rs` denies to the HarnessWeb subject is absent.
  capabilities: [
    "window.minimize",
    "window.toggleMaximize",
    "window.state",
    "window.close",
    "web.reload",
    "web.restart",
    "runtime.safe-mode",
    "gateway.manage",
    "diagnostics.open"
  ]
};
function apply(ctx = {}) {
  const register = ctx.provide ?? ctx.set;
  try {
    register?.("harnessShell", service);
  } catch {
  }
  const readyFile = process.env.DSH_SHELL_PLUGIN_READY_FILE;
  if (!readyFile) return;
  try {
    writeFileSync(
      readyFile,
      `${JSON.stringify({ pluginId: name, version, apiVersion, pid: process.pid })}
`,
      { encoding: "utf8", mode: 384 }
    );
  } catch {
  }
}
export {
  apiVersion,
  apply,
  inject,
  name,
  service,
  version
};
