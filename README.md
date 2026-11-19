# GoSeller (ex-VendaFlow)

Extensão do Chrome para o WhatsApp Web (Business): respostas rápidas, abas de leads e envio em massa com ritmo lento.
Cada vendedor tem o próprio ambiente: tudo fica no `chrome.storage.local` do computador dele.

## Arquivos
- `manifest.json`: Manifest V3
- `lib/wppconnect-wa.js`: biblioteca WA-JS 4.8.2 (Apache-2.0, `lib/LICENSE-wa-js.txt`) que dá acesso às funções do WhatsApp Web
- `src/config-wpp.js`: desliga o Google Analytics e o "powered by" da WA-JS (roda antes dela)
- `src/page.js`: mundo MAIN; envia mensagens, etiquetas, filtro da lista e eventos (mensagem recebida, conversa aberta)
- `src/common.js`: funções compartilhadas (`VF`: storage, texto/variáveis, horário, números)
- `src/steps-editor.js`: editor de sequência de mensagens (`StepsEditor`)
- `src/waseller.js`: importação de backup do WaSeller
- `src/content.js`: barra no topo (abas, respostas, status), atalho `/`, motor do envio em massa e detecção de respostas e descadastro
- `src/background.js`: alarme a cada 30s que acorda o motor e impede o Chrome de descartar a aba durante campanhas
- `server/`: servidor do Kanban/sequências automáticas (Python, ver `server/LEIAME.md`)
- `tools/waseller-to-goseller.js`: conversor de backup do WaSeller pela linha de comando
- `build.sh` / `build-store.sh`: geram o zip manual (ofuscado) e o da Chrome Web Store

## Dados (chrome.storage.local) — nomes em português de propósito (não renomear)
`respostas`, `abas`, `campanhas` (lista de ids), `campanha:<id>`, `midia:<id>` (dataURL), `config`, `naoPerturbe`,
`motor` (próximo envio/lote), `motorStatus`, `motorTrava` (só uma aba envia), `enviosDia`, `etiquetasCache`.

## Atualizar a WA-JS
Quando o WhatsApp Web mudar e algo parar de funcionar:
`npm pack @wppconnect/wa-js` → copiar `package/dist/wppconnect-wa.js` para `lib/`.
