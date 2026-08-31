#!/usr/bin/env bash
set -euo pipefail

# Build a release DMG from an already-generated HarnessDock.app without using
# create-dmg's attach/Finder/detach cycle. GitHub's macos-15-intel runners can
# repeatedly time out in DiskArbitration during hdiutil detach even when the
# app and intermediate image are valid.

tauri_root="${1:-$(pwd)}"
app_path="${tauri_root}/src-tauri/target/release/bundle/macos/HarnessDock.app"
dmg_dir="${tauri_root}/src-tauri/target/release/bundle/dmg"
icon_path="${tauri_root}/src-tauri/icons/icon.icns"
config_path="${tauri_root}/src-tauri/tauri.conf.json"

test -d "$app_path"
test -s "$app_path/Contents/Info.plist"
test -s "$icon_path"
test -s "$config_path"

version="$(node -p "require('${config_path}').version")"
case "${RUNNER_ARCH:-$(uname -m)}" in
  X64|x86_64) arch_tag="x64" ;;
  ARM64|arm64) arch_tag="aarch64" ;;
  *) arch_tag="$(uname -m)" ;;
esac

mkdir -p "$dmg_dir"
output="${dmg_dir}/HarnessDock_${version}_${arch_tag}.dmg"
staging="$(mktemp -d "${TMPDIR:-/tmp}/harnessdock-dmg.XXXXXX")"
cleanup() {
  rm -rf "$staging"
}
trap cleanup EXIT

# Preserve the signed/bundled .app structure and provide the conventional
# drag-to-Applications installation target.
ditto "$app_path" "$staging/HarnessDock.app"
ln -s /Applications "$staging/Applications"

# Validate that the packaged app references and contains its generated icon.
icon_file="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$app_path/Contents/Info.plist" 2>/dev/null || true)"
if [ -n "$icon_file" ]; then
  case "$icon_file" in
    *.icns) : ;;
    *) icon_file="${icon_file}.icns" ;;
  esac
  test -s "$app_path/Contents/Resources/$icon_file"
fi

rm -f "$output"
hdiutil create \
  -volname HarnessDock \
  -fs HFS+ \
  -srcfolder "$staging" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  "$output"

test -s "$output"
hdiutil imageinfo "$output" >/dev/null
printf 'Created mount-free HarnessDock DMG: %s\n' "$output"
