// src/index.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
var name = "harness-shell";
var inject = [];
var version = "0.2.0";
var apiVersion = 1;
var service = {
  pluginId: name,
  version,
  apiVersion,
  webEntry: fileURLToPath(new URL("../web/shell.js", import.meta.url)),
  capabilities: [
    "window.minimize",
    "window.toggleMaximize",
    "window.state",
    "window.close",
    "web.reload",
    "web.restart",
    "runtime.safe-mode",
    "runtime.clear-quarantine",
    "diagnostics.open",
    "app.update.check",
    "app.update.install",
    "app.quit"
  ]
};
function apply(ctx = {}) {
  const register = ctx.provide ?? ctx.set;
  register?.("harnessShell", service);
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
