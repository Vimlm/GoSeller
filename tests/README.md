# Testes automáticos do GoSeller

Abre uma **página falsa do WhatsApp Web** num Chrome invisível, carrega o código da extensão (`src/`) e clica nas telas como uma pessoa faria. Nada é enviado de verdade: o "WhatsApp falso" (`harness/fake-wpp.js`) só anota o que seria enviado.

## Rodar
```
cd tests
npm install      # só na primeira vez
npm test         # todos os testes
npm test -- draft   # só os arquivos com "draft" no nome
```
Se um teste falhar, uma foto da tela fica em `tests/fail-*.png`.

Servidor (sobe o `server/app.py` local com dados temporários):
```
python3 tests/server_test.py          # rotas do servidor (relatos etc.)
node tests/background_report_test.js  # envio de relato de verdade: background.js → servidor local
```

## Arquivos
- `harness/whatsapp.html` — página falsa do WhatsApp (cabeçalho, campo de mensagem) que carrega a extensão
- `harness/fake-wpp.js` — WhatsApp de mentira: 3 conversas, 2 etiquetas, registra envios em `window.__sent`
- `harness/chrome-shim.js` — imitação do `chrome.storage`/`chrome.runtime` (sobrevive ao recarregar, como o real)
- `specs/*.js` — os testes; cada função é um teste
- `run.js` — roda tudo e mostra ✓/✗

## Limites
Não substitui o teste no WhatsApp real: a página falsa não reproduz o layout exato do WhatsApp, e o servidor do Kanban não é testado aqui.
