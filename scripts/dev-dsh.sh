#!/usr/bin/env bash
# ============================================================
#  dev-dsh.sh - start the dsh web process only (no desktop client)
#
#  Prints the web UI URL once the embedded plugin is ready.
#  Runtime mode auto-detects bundled (runtimes/pack) first,
#  then PATH. Override with: DSH_RUNTIME=bundled|local
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [[ ! -d node_modules ]]; then
  echo "[dev-dsh] node_modules missing, running pnpm install..."
  pnpm install
fi

exec node --import tsx scripts/dev-dsh.mjs
