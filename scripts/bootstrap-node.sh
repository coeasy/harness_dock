#!/usr/bin/env bash
# Provision a verified portable Node for macOS/Linux builds.
#
# Mirrors scripts/bootstrap-node.ps1 (Windows): downloads the Node release from
# scripts/versions.json, verifies it against the published SHA-256 manifest, and
# records the install location in .local-tools/node-home.txt so callers can put
# it on PATH in their own shell.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

node_version="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/versions.json" | head -1)"
if [[ -z "$node_version" ]]; then
  echo "[bootstrap-node] ERROR: unable to read $SCRIPT_DIR/versions.json" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) node_platform=darwin ;;
  Linux) node_platform=linux ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "[bootstrap-node] ERROR: this shell is a POSIX emulation on Windows" >&2
    echo "[bootstrap-node] Use scripts/bootstrap-node.ps1 instead:" >&2
    echo "[bootstrap-node]   powershell -ExecutionPolicy Bypass -File scripts/bootstrap-node.ps1" >&2
    exit 1
    ;;
  *) echo "[bootstrap-node] ERROR: unsupported host OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  arm64|aarch64)
    if [[ "$node_platform" != darwin ]]; then
      echo "[bootstrap-node] ERROR: Linux arm64 desktop packaging is not part of the current HarnessDock target matrix" >&2
      exit 1
    fi
    node_arch=arm64
    ;;
  *) echo "[bootstrap-node] ERROR: unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac

archive="node-v${node_version}-${node_platform}-${node_arch}.tar.gz"
tool_root="$REPO_ROOT/.local-tools"
node_home="$tool_root/node-v${node_version}-${node_platform}-${node_arch}"
cache_root="$REPO_ROOT/.local-cache/node"
archive_path="$cache_root/$archive"
path_file="$tool_root/node-home.txt"

verify_hash() {
  local file="$1" expected="$2" actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  [[ "$actual" == "$expected" ]]
}

node_ready() {
  local actual_version
  [[ -x "$node_home/bin/node" ]] || return 1
  actual_version="$("$node_home/bin/node" -p 'process.versions.node' 2>/dev/null || true)"
  [[ "$actual_version" == "$node_version" ]]
}

install_from_mirror() {
  local base="$1" checksum_base="$2" sums expected
  echo "[bootstrap-node] source: $base"
  # The archive mirror is not a trust root. Always obtain the checksum manifest
  # from the canonical Node.js distribution host so a mirror cannot replace
  # both the archive and the expected digest.
  if ! sums="$(curl --fail --location --silent --show-error --retry 3 "$checksum_base/SHASUMS256.txt")"; then
    return 1
  fi
  expected="$(printf '%s\n' "$sums" | awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }')"
  [[ -n "$expected" ]] || return 1

  mkdir -p "$cache_root"
  if [[ ! -s "$archive_path" ]] || ! verify_hash "$archive_path" "$expected"; then
    rm -f "$archive_path.partial"
    if ! curl --fail --location --silent --show-error --retry 3 "$base/$archive" -o "$archive_path.partial"; then
      rm -f "$archive_path.partial"
      return 1
    fi
    if ! verify_hash "$archive_path.partial" "$expected"; then
      rm -f "$archive_path.partial"
      return 1
    fi
    mv -f "$archive_path.partial" "$archive_path"
  fi

  rm -rf "$node_home"
  mkdir -p "$tool_root"
  tar -xzf "$archive_path" -C "$tool_root"
  node_ready || return 1
}

mkdir -p "$tool_root"
# `NODE_DOWNLOAD_BASES` lets CI exercise both mirrors explicitly (space separated,
# first entry is primary). Without it the script keeps the default order.
sources="${NODE_DOWNLOAD_BASES:-https://nodejs.org/dist/v${node_version} https://npmmirror.com/mirrors/node/v${node_version}}"
checksum_base="https://nodejs.org/dist/v${node_version}"
if ! node_ready; then
  installed=false
  for base in $sources; do
    if install_from_mirror "$base" "$checksum_base"; then
      installed=true
      break
    fi
    echo "[bootstrap-node] WARNING: Node source failed: $base" >&2
  done
  if [[ "$installed" != true ]]; then
    echo "[bootstrap-node] ERROR: unable to provision verified portable Node $node_version" >&2
    exit 1
  fi
fi

printf '%s\n' "$node_home" > "$path_file"
echo "[bootstrap-node] portable Node ready: $node_home"
