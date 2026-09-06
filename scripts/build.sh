#!/usr/bin/env bash
# HarnessDock one-click local Tauri build for macOS/Linux.
#
# Thin shim over scripts/build.mjs. System Node/pnpm/Rust are build tools only;
# the packaged client runs the sealed Node+dsh Runtime embedded in the bundle.
# Portable Node provisioning lives in scripts/bootstrap-node.sh (same contract
# as scripts/bootstrap-node.ps1 on Windows).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

node_ok=false
if [[ "${HARNESSDOCK_FORCE_PORTABLE_NODE:-0}" != "1" ]] && command -v node >/dev/null 2>&1 && node scripts/node-version-check.cjs >/dev/null 2>&1; then
  node_ok=true
fi

if [[ "$node_ok" != true ]]; then
  command -v curl >/dev/null 2>&1 || { echo "[build] ERROR: curl is required to bootstrap portable Node" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[build] ERROR: tar is required to bootstrap portable Node" >&2; exit 1; }
  bash scripts/bootstrap-node.sh
  [[ -s .local-tools/node-home.txt ]] || { echo "[build] ERROR: bootstrap-node.sh did not write .local-tools/node-home.txt" >&2; exit 1; }
  node_home="$(cat .local-tools/node-home.txt)"
  [[ -x "$node_home/bin/node" ]] || { echo "[build] ERROR: portable Node missing: $node_home/bin/node" >&2; exit 1; }
  export PATH="$node_home/bin:$PATH"
fi

node scripts/node-version-check.cjs
node scripts/bootstrap.mjs
node scripts/build.mjs --skip-install "$@"

echo
echo "[build] SUCCESS"
echo "[build] Native bundle output: $REPO_ROOT/apps/tauri/src-tauri/target/release/bundle"
