#!/usr/bin/env bash
# HarnessDock Tauri build helper for macOS/Linux.
# Cross-platform release artifacts are built by the Tauri candidate workflow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f package.json ]]; then
  echo "[build] ERROR: package.json not found above $SCRIPT_DIR" >&2
  exit 1
fi

if ! node scripts/node-version-check.cjs 2>/dev/null; then
  echo "[build] ERROR: Node 22.19+ (or Node 24+) is required; run scripts/bootstrap.mjs first" >&2
  exit 1
fi

node scripts/bootstrap.mjs "$@"
node scripts/build.mjs "$@" --skip-install
