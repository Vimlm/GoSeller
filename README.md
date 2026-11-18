# GoSeller (ex-VendaFlow)

Extensão do Chrome para o WhatsApp Web (Business): respostas rápidas, abas de leads e envio em massa com ritmo lento.
Cada vendedor tem o próprio ambiente: tudo fica no `chrome.storage.local` do computador dele.

## Arquivos
- `manifest.json`: Manifest V3
- `lib/wppconnect-wa.js`: biblioteca WA-JS 4.7.2 (Apache-2.0, `lib/LICENSE-wa-js.txt`) que dá acesso às funções do WhatsApp Web
- `src/config-wpp.js`: desliga o Google Analytics e o "powered by" da WA-JS (roda antes dela)
- `src/pagina.js`: mundo MAIN; envia mensagens, etiquetas, filtro da lista e eventos (mensagem recebida, conversa aberta)
- `src/conteudo.js`: barra no topo (abas, respostas, status), atalho `/`, motor do envio em massa e detecção de respostas e descadastro
- `src/background.js`: alarme a cada 30s que acorda o motor e impede o Chrome de descartar a aba durante campanhas
- `painel/`: respostas, abas, campanhas, não perturbe, configurações e backup

## Dados (chrome.storage.local)
`respostas`, `abas`, `campanhas` (lista de ids), `campanha:<id>`, `midia:<id>` (dataURL), `config`, `naoPerturbe`,
`motor` (próximo envio/lote), `motorStatus`, `motorTrava` (só uma aba envia), `enviosDia`, `etiquetasCache`.

## Atualizar a WA-JS
Quando o WhatsApp Web mudar e algo parar de funcionar:
`npm pack @wppconnect/wa-js` → copiar `package/dist/wppconnect-wa.js` para `lib/`.
