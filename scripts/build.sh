#!/usr/bin/env bash
# HarnessDock one-click local Tauri build for macOS/Linux.
# System Node/pnpm/Rust are build tools only; the packaged client uses the
# sealed Node+dsh Runtime embedded into the application.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [[ ! -f package.json ]]; then
  echo "[build] ERROR: package.json not found above $SCRIPT_DIR" >&2
  exit 1
fi

node_version="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' scripts/versions.json | head -1)"
if [[ -z "$node_version" ]]; then
  echo "[build] ERROR: unable to read scripts/versions.json" >&2
  exit 1
fi

node_ok=false
if command -v node >/dev/null 2>&1 && node scripts/node-version-check.cjs >/dev/null 2>&1; then
  node_ok=true
fi

if [[ "$node_ok" != true ]]; then
  command -v curl >/dev/null 2>&1 || { echo "[build] ERROR: curl is required to bootstrap portable Node" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "[build] ERROR: tar is required to bootstrap portable Node" >&2; exit 1; }

  case "$(uname -s)" in
    Darwin) node_platform=darwin ;;
    Linux) node_platform=linux ;;
    *) echo "[build] ERROR: unsupported host OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) node_arch=x64 ;;
    arm64|aarch64)
      if [[ "$node_platform" != darwin ]]; then
        echo "[build] ERROR: Linux arm64 desktop packaging is not part of the current HarnessDock target matrix" >&2
        exit 1
      fi
      node_arch=arm64
      ;;
    *) echo "[build] ERROR: unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac

  archive="node-v${node_version}-${node_platform}-${node_arch}.tar.gz"
  tool_root="$REPO_ROOT/.local-tools"
  node_home="$tool_root/node-v${node_version}-${node_platform}-${node_arch}"
  cache_root="$REPO_ROOT/.local-cache/node"
  archive_path="$cache_root/$archive"
  mkdir -p "$tool_root" "$cache_root"

  verify_hash() {
    local file="$1" expected="$2" actual
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$file" | awk '{print $1}')"
    else
      actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    [[ "$actual" == "$expected" ]]
  }

  if [[ ! -x "$node_home/bin/node" ]] || ! "$node_home/bin/node" scripts/node-version-check.cjs >/dev/null 2>&1; then
    installed=false
    for base in "https://nodejs.org/dist/v${node_version}" "https://npmmirror.com/mirrors/node/v${node_version}"; do
      echo "[build] Preparing verified portable Node from $base"
      if ! sums="$(curl --fail --location --silent --show-error --retry 3 "$base/SHASUMS256.txt")"; then
        continue
      fi
      expected="$(printf '%s\n' "$sums" | awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }')"
      [[ -n "$expected" ]] || continue
      if [[ ! -s "$archive_path" ]] || ! verify_hash "$archive_path" "$expected"; then
        rm -f "$archive_path.partial"
        if ! curl --fail --location --silent --show-error --retry 3 "$base/$archive" -o "$archive_path.partial"; then
          rm -f "$archive_path.partial"
          continue
        fi
        if ! verify_hash "$archive_path.partial" "$expected"; then
          rm -f "$archive_path.partial"
          continue
        fi
        mv -f "$archive_path.partial" "$archive_path"
      fi
      rm -rf "$node_home"
      tar -xzf "$archive_path" -C "$tool_root"
      if [[ -x "$node_home/bin/node" ]] && "$node_home/bin/node" scripts/node-version-check.cjs >/dev/null 2>&1; then
        installed=true
        break
      fi
    done
    [[ "$installed" == true ]] || { echo "[build] ERROR: unable to provision verified portable Node $node_version" >&2; exit 1; }
  fi
  export PATH="$node_home/bin:$PATH"
fi

node scripts/node-version-check.cjs
node scripts/bootstrap.mjs
node scripts/build.mjs --skip-install "$@"

echo
echo "[build] SUCCESS"
echo "[build] Native bundle output: $REPO_ROOT/apps/tauri/src-tauri/target/release/bundle"
