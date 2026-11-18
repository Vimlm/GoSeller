#!/bin/bash
# Gera o zip para enviar à Chrome Web Store: dist/GoSeller-loja-<versão>.zip
# A loja NÃO aceita código ofuscado, por isso aqui vai o código normal.
# O manifest.json fica na raiz do zip (exigência da loja).
# Uso: ./empacotar-loja.sh
set -e
cd "$(dirname "$0")"
VERSAO=$(node -p "require('./manifest.json').version")
SAIDA="dist/GoSeller-loja-$VERSAO.zip"
mkdir -p dist && rm -f "$SAIDA"
for f in src/*.js; do node --check "$f"; done
zip -qr "$SAIDA" manifest.json icons lib src -x '*.DS_Store'
echo "Pronto: $SAIDA"
