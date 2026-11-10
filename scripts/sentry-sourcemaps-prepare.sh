#!/bin/sh
# Runs INSIDE the web image build (Dockerfile.web), only when SENTRY_SOURCEMAPS=1.
#
# 1. Stamps a Sentry debug id into every compiled .js and its .map (no network,
#    no token) so an error from that file can be matched to its map.
# 2. Moves the maps OUT of .next into /app/sentry-sourcemaps, with copies of
#    their .js files. Next serves everything under .next/static publicly at
#    /_next/static, so a map left there would publish our source code.
#
# The upload itself happens later, in deploy.sh, from a throwaway container, so
# the auth token never enters an image layer.
set -eu
NEXT_DIR="${NEXT_DIR:-/app/apps/web/.next}"
OUT="${OUT:-/app/sentry-sourcemaps}"
CLI="${CLI:-/app/apps/web/node_modules/.bin/sentry-cli}"

"$CLI" sourcemaps inject "$NEXT_DIR/static" "$NEXT_DIR/server" >/dev/null

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$NEXT_DIR"
find static server -type f -name '*.js.map' | while read -r map; do
  js="${map%.map}"
  mkdir -p "$OUT/$(dirname "$map")"
  mv "$map" "$OUT/$map"
  [ -f "$js" ] && cp "$js" "$OUT/$js"
done
# Anything else ending in .map (css maps etc.) must not be served either.
find static -type f -name '*.map' -delete

echo "[sentry] prepared $(find "$OUT" -name '*.map' | wc -l) source maps"
