#!/bin/bash
# Gera a versão para distribuir (código embaralhado) em dist/GoSeller e o zip GoSeller-<versão>.zip.
# Uso: ./empacotar.sh
set -e
cd "$(dirname "$0")"
VERSAO=$(node -p "require('./manifest.json').version")
rm -rf dist && mkdir -p dist/GoSeller/src
cp -R manifest.json icons lib dist/GoSeller/
cp src/*.css dist/GoSeller/src/
for f in src/*.js; do
  npx --yes javascript-obfuscator@4.1.1 "$f" --output "dist/GoSeller/$f" \
    --compact true --string-array true --string-array-encoding base64 --string-array-threshold 0.75 \
    --identifier-names-generator hexadecimal --rename-globals false --self-defending false \
    --control-flow-flattening false --dead-code-injection false --target browser >/dev/null
  node --check "dist/GoSeller/$f"
done
(cd dist && zip -qr "GoSeller-$VERSAO.zip" GoSeller)
echo "Pronto: dist/GoSeller-$VERSAO.zip"
