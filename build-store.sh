#!/bin/bash
# Builds the zip for the Chrome Web Store: dist/GoSeller-store-<version>.zip
# The store does NOT accept obfuscated code, so this ships the plain source.
# manifest.json sits at the zip root (store requirement).
# Usage: ./build-store.sh
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/GoSeller-store-$VERSION.zip"
mkdir -p dist && rm -f "$OUT"
for f in src/*.js; do node --check "$f"; done
zip -qr "$OUT" manifest.json icons lib src -x '*.DS_Store'
echo "Done: $OUT"
