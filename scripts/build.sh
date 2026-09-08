#!/usr/bin/env bash
# HarnessDock one-click local Tauri build for macOS/Linux.
#
# Thin shim over scripts/build.mjs. System Node/pnpm/Rust are build tools only;
# the packaged client runs the sealed Node+dsh Runtime embedded in the bundle.
# Node resolution is deliberately local-first for developer builds:
#   compatible system Node -> verified cached/downloaded portable Node.
# pnpm follows the same policy: exact PATH version -> repository-local isolated
# version under .local-tools. CI can force portable Node to prove bare-host fallback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

node_ok=false
if [[ "${HARNESSDOCK_FORCE_PORTABLE_NODE:-0}" == "1" ]]; then
  echo "[build] HARNESSDOCK_FORCE_PORTABLE_NODE=1; bypassing system Node"
elif command -v node >/dev/null 2>&1; then
  if node scripts/node-version-check.cjs >/dev/null 2>&1; then
    node_ok=true
    echo "[build] Using compatible system Node $(node --version): $(command -v node)"
  else
    echo "[build] System Node $(node --version 2>/dev/null || printf 'unknown') is incompatible; falling back to verified portable Node"
  fi
else
  echo "[build] System Node not found; falling back to verified portable Node"
fi

if [[ "$node_ok" != true ]]; then
  command -v curl >/dev/null 2>&1 || { echo "[build] ERROR: curl is required to bootstrap portable Node" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[build] ERROR: tar is required to bootstrap portable Node" >&2; exit 1; }
  bash scripts/bootstrap-node.sh
  [[ -s .local-tools/node-home.txt ]] || { echo "[build] ERROR: bootstrap-node.sh did not write .local-tools/node-home.txt" >&2; exit 1; }
  node_home="$(cat .local-tools/node-home.txt)"
  [[ -x "$node_home/bin/node" ]] || { echo "[build] ERROR: portable Node missing: $node_home/bin/node" >&2; exit 1; }
  export PATH="$node_home/bin:$PATH"

  npm_command="$(command -v npm || true)"
  [[ -n "$npm_command" ]] || { echo "[build] ERROR: portable npm is not available after activating $node_home/bin" >&2; exit 1; }
  node scripts/verify-build-toolchain.mjs --node-home "$node_home" --npm-command "$npm_command"
  echo "[build] Using verified portable Node $(node --version): $(command -v node)"
fi

node scripts/node-version-check.cjs
node scripts/bootstrap.mjs

if [[ -s .local-tools/pnpm-bin.txt ]]; then
  pnpm_bin="$(cat .local-tools/pnpm-bin.txt)"
  [[ -x "$pnpm_bin/pnpm" ]] || { echo "[build] ERROR: repository-local pnpm missing: $pnpm_bin/pnpm" >&2; exit 1; }
  export PATH="$pnpm_bin:$PATH"

  pnpm_command="$(command -v pnpm || true)"
  [[ -n "$pnpm_command" ]] || { echo "[build] ERROR: repository-local pnpm is not available after activating $pnpm_bin" >&2; exit 1; }
  node scripts/verify-build-toolchain.mjs --pnpm-bin "$pnpm_bin" --pnpm-command "$pnpm_command"
  echo "[build] Using repository-local pnpm $(pnpm --version): $(command -v pnpm)"
fi

node scripts/build.mjs --skip-install "$@"

echo
echo "[build] SUCCESS"
echo "[build] Native bundle output: $REPO_ROOT/apps/tauri/src-tauri/target/release/bundle"
