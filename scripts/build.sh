#!/usr/bin/env bash
# ============================================================
#  HarnessDock - one-click desktop build (macOS / Linux)
#
#  Works on a BARE machine: no pre-installed Node / pnpm / dsh.
#  If Node ^22.19 || >=24 is missing, a portable Node 22.19 is
#  downloaded into .rundata/toolchain/ automatically.
#
#  Usage:
#    ./build.sh                        # current OS, thin package
#    ./build.sh mac full               # macOS full (offline bundled runtime)
#    ./build.sh linux both             # thin + full (AppImage + deb)
#    ./build.sh win full --skip-tests  # cross-build Windows artifacts
#
#  Scenarios:
#    thin - small download, fetches pinned dsh via npx on first run
#    full - bundles node + dsh runtime, works offline.
#    Both scenarios emit standalone artifacts; Windows builds include
#    a portable single-file exe (no installation required).
#
#  Notes:
#    - mac artifacts require a macOS host, linux artifacts a Linux host.
#    - Windows artifacts (NSIS/portable/zip) can build on any host.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# ---- Node version single source of truth: scripts/versions.json ----
# node may not exist yet on a bare machine, so fall back to sed, then a default.
NODE_VERSION=""
NODE_VERSION="$(node -p "require(process.argv[1]).node" "$SCRIPT_DIR/versions.json" 2>/dev/null)" || true
if [[ -z "$NODE_VERSION" ]]; then
  NODE_VERSION="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/versions.json" | head -n1)" || true
fi
NODE_VERSION="${NODE_VERSION:-22.19.0}"
TOOLCHAIN_DIR="$REPO_ROOT/.rundata/toolchain"

cd "$REPO_ROOT"

if [[ ! -f package.json ]]; then
  echo "[build] ERROR: not a project root: $REPO_ROOT" >&2
  exit 1
fi

# ------------------------------------------------------------
# 1. Ensure a usable Node (>=22.19) - download portable if needed
# ------------------------------------------------------------
if node scripts/node-version-check.cjs 2>/dev/null; then
  echo "[build] using system Node $(node -v)"
else
  case "$(uname -s)" in
    Darwin) NODE_ARCH=$([[ "$(uname -m)" == "arm64" ]] && echo arm64 || echo x64)
            NODE_DIST="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
            NODE_EXT="tar.gz" ;;
    Linux)  NODE_ARCH=$([[ "$(uname -m)" == "aarch64" ]] && echo arm64 || echo x64)
            NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
            NODE_EXT="tar.xz" ;;
    *) echo "[build] ERROR: unsupported host for portable Node bootstrap" >&2; exit 1 ;;
  esac

  if [[ -x "$TOOLCHAIN_DIR/$NODE_DIST/bin/node" ]]; then
    echo "[build] using bundled portable Node v$NODE_VERSION"
    export PATH="$TOOLCHAIN_DIR/$NODE_DIST/bin:$PATH"
  else
    echo "[build] Node >=22.19 not found. Downloading portable Node v$NODE_VERSION ..."
    mkdir -p "$TOOLCHAIN_DIR"
    curl -fL --progress-bar -o "$TOOLCHAIN_DIR/$NODE_DIST.$NODE_EXT" \
      "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.${NODE_EXT}"
    tar -xf "$TOOLCHAIN_DIR/$NODE_DIST.$NODE_EXT" -C "$TOOLCHAIN_DIR"
    export PATH="$TOOLCHAIN_DIR/$NODE_DIST/bin:$PATH"
    node scripts/node-version-check.cjs
  fi
  echo "[build] portable Node $(node -v) ready"
fi

# ------------------------------------------------------------
# 2. Ensure pnpm + dependencies
# ------------------------------------------------------------
node scripts/bootstrap.mjs "$@"

# ------------------------------------------------------------
# 3. Build
# ------------------------------------------------------------
OS_ARG="${1:-current}"
SCENARIO="${2:-thin}"
shift 2 2>/dev/null || true
EXTRA_ARGS=("$@")

echo
echo "=== HarnessDock desktop build ==="
echo "os=$OS_ARG scenario=$SCENARIO ${EXTRA_ARGS[*]:-}"
echo

# bootstrap already ensured dependencies; skip a second pnpm install
node scripts/build.mjs --os "$OS_ARG" --scenario "$SCENARIO" "${EXTRA_ARGS[@]}" --skip-install

echo
echo "[build] Artifacts are in apps/desktop/release/thin and apps/desktop/release/full"
