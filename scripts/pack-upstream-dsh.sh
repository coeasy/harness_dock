#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_DIR=${1:?usage: pack-upstream-dsh.sh <upstream-dir> <output-dir>}
OUTPUT_DIR=${2:?usage: pack-upstream-dsh.sh <upstream-dir> <output-dir>}
UPSTREAM_DIR=$(cd "$UPSTREAM_DIR" && pwd)
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)

rm -rf "$OUTPUT_DIR/dsh" "$OUTPUT_DIR/vendor" "$OUTPUT_DIR/landlock"
mkdir -p "$OUTPUT_DIR/dsh" "$OUTPUT_DIR/vendor" "$OUTPUT_DIR/landlock"

echo "[upstream-pack] install exact upstream workspace"
pnpm --dir "$UPSTREAM_DIR" install --frozen-lockfile

echo "[upstream-pack] verify dsh release family"
pnpm --dir "$UPSTREAM_DIR" run release:verify --family dsh

echo "[upstream-pack] build official artifacts"
pnpm --dir "$UPSTREAM_DIR" run build:official

echo "[upstream-pack] pack dsh family"
pnpm --dir "$UPSTREAM_DIR" run release:pack --family dsh --out "$OUTPUT_DIR/dsh" --concurrency 8

echo "[upstream-pack] pack vendor family"
pnpm --dir "$UPSTREAM_DIR" run release:pack --family vendor --out "$OUTPUT_DIR/vendor"

echo "[upstream-pack] pack Landlock entry"
pnpm --dir "$UPSTREAM_DIR/native/landlock-run" run build:ts
pnpm --dir "$UPSTREAM_DIR/native/landlock-run/packages/entry" pack --pack-destination "$OUTPUT_DIR/landlock"

echo "[upstream-pack] verify package set in a throwaway consumer"
pnpm --dir "$UPSTREAM_DIR" run release:verify-packed-install --family dsh \
  --from "$OUTPUT_DIR/dsh" \
  --from "$OUTPUT_DIR/vendor" \
  --from "$OUTPUT_DIR/landlock"

count=$(find "$OUTPUT_DIR" -type f -name '*.tgz' | wc -l | tr -d ' ')
if [ "$count" -lt 2 ]; then
  echo "[upstream-pack] expected multiple tarballs, found $count" >&2
  exit 1
fi
printf '%s\n' "$count" > "$OUTPUT_DIR/package-count.txt"
echo "[upstream-pack] ready: $count tarballs"
