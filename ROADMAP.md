# GoSeller — Roteiro até a versão de venda

Atualizado em 19/11/2026. Ordem pensada para: (1) o time testar logo, (2) não refazer trabalho, (3) chegar na venda.

Legenda: [ ] a fazer · [~] em andamento · [x] feito · 👤 depende de você (compra, teste humano, decisão)

---

## Fase 0 — Padrões de desenvolvimento (a partir de 19/11/2026)

- [x] **Código no GitHub**: https://github.com/Vimlm/GoSeller (privado).
- [ ] **Commit a cada mudança** a partir de hoje: um commit por correção/funcionalidade, mensagem clara, `git push` em seguida. Versões marcadas com tag (`v0.8.3`, `v0.9.0`…).
- [x] `.gitignore` (dist/, zips, .DS_Store, .env) — pacotes gerados não vão para o Git.
- [x] **Todo código em inglês** (padrão definido em `CLAUDE.md`): nomes de variáveis/funções/arquivos, comentários e mensagens de commit. A conversa e o texto que o vendedor vê continuam em português.
- [x] **Dados do programa ficam em português**: chaves salvas no navegador (`abas`, `nomes`, `respostas`…), formato do backup, rotas e tabelas do servidor. Não mudam — ninguém perde dados.
- [x] **Código atual traduzido para inglês** (19/11): funções, variáveis, arquivos (`content.js`, `page.js`, `common.js`, `steps-editor.js`, `server/`, `tools/`, `build.sh`, `build-store.sh`) e comentários. Dados e protocolo continuam em português; comportamento conferido idêntico ao anterior.

## Fase 1 — Pôr no ar para o time (prioridade máxima)

- [ ] 👤 **Comprar `goseller.app.br`** no registro.br e apontar o DNS para a VPS (72.61.135.26).
- [ ] **Trocar os domínios antigos** (pouca coisa hoje):
  - `src/background.js` → `SERVIDOR_PADRAO` (`agents.coolmeia.tech/vendaflow` → `api.goseller.app.br`)
  - `manifest.json` → `host_permissions` (`agents.coolmeia.tech/*` → `*.goseller.app.br/*`)
  - VPS: rota nova no Traefik + certificado; manter a rota antiga uns dias (quem estiver na versão velha não cai)
  - Aproveitar e renomear o que ficou como "vendaflow" no servidor (`/opt/vendaflow`, `vendaflow-api`) → `goseller`
- [ ] **Publicar na Chrome Web Store como "Não listada"** (só quem tem o link instala).
  - Motivo: hoje cada correção exige mandar zip e reinstalar em cada PC (foi o caso do erro de ontem). Na loja, **a atualização chega sozinha** em todos.
  - Atenção: a loja **proíbe código ofuscado** (minificado pode). Para a loja, gerar um pacote só minificado; o zip ofuscado fica para quem instala manualmente.
  - Fazer DEPOIS de trocar o domínio: mudar `host_permissions` depois de publicado faz o Chrome desativar a extensão até cada um aceitar a permissão nova.
- [ ] Botão **"Relatar problema"** nas Configurações (manda versão, navegador/sistema e últimos erros para o servidor). Evita depender de print.

## Fase 2 — Correções que o time já sentiu

- [x] **Remarketing perde a configuração** (19/11: rascunho salvo sozinho; o painel volta para a tela onde você estava) ao trocar de tela e voltar → guardar o rascunho da campanha (storage) e restaurar ao voltar.
- [ ] **Abas unificadas**: uma aba pode ser *importada de uma etiqueta* e continuar aceitando contatos *adicionados à mão* (hoje a aba por etiqueta some da lista de "adicionar manualmente"). Ao importar, decidir: "copiar uma vez" ou "manter sincronizada com a etiqueta".
  - Bônus: isso destrava aba-por-etiqueta virar coluna do Kanban e ter sequência automática (limitação atual).
- [ ] **Bug visual no Windows** (cabeçalho da conversa fora de ordem: foto · nome · lápis · etiquetas · câmera · celular · lupa · abas). 👤 Preciso de um print do Windows. Provável: a posição dos nossos botões depende da ordem dos ícones do WhatsApp, que muda entre versões/sistemas.
- [x] **Backup único** (19/11): um só botão "Restaurar backup" que reconhece sozinho o formato (GoSeller ou o outro), sem citar nome de concorrente na tela. (A lógica já existe em `src/waseller.js`; é juntar os dois botões.)

## Fase 3 — Mensagens programadas (nova ferramenta)

Agendar texto / áudio (como gravado) / vídeo / imagem / documento para **um contato, num dia e hora**, enviado **pelo servidor** (funciona com o computador desligado).

- [ ] Servidor: tabela `agendamentos` (conta, contato, passos, data/hora, status, erro); o motor que já envia as sequências do Kanban passa a enviar também os agendamentos.
- [ ] Mídia: subir o arquivo ao servidor no momento do agendamento (hoje a mídia só existe no navegador do vendedor).
- [ ] Extensão:
  - botão 🕒 no cabeçalho da conversa e ao lado do ⚡ → "Programar mensagem" (escolher resposta pronta ou escrever; data/hora; atalhos "amanhã 9h", "em 2 h")
  - tela "Programadas": lista por dia, editar, cancelar, enviar agora; status (pendente / enviada / falhou + motivo)
- [ ] Regras: respeitar horário comercial e "Não perturbe"; opção "cancelar se o lead responder antes".
- [ ] Requisito: o número do vendedor conectado no servidor (QR code), igual ao Kanban automático.

## Fase 4 — Configurações e interface

- [ ] Reorganizar Configurações em blocos: Conta e plano · Conexão com o servidor (QR, status) · Ritmo de envio · Horário e Não perturbe · Backup · Sobre/ajuda.
- [ ] Status da conexão sempre visível (bolinha verde/vermelha no trilho).
- [ ] Primeira vez: assistente curto (conectar QR, importar backup, criar colunas padrão).
- [ ] Pendente de 12/11: botão "Criar colunas padrão" e opção "Mostrar no Kanban" por aba.

## Fase 5 — Venda: pagamento, licença e painéis

- [ ] **Licença**: a extensão só funciona com conta ativa; o servidor valida a chave ao abrir e a cada X horas (com tolerância offline de alguns dias). Plano/limites vêm do servidor.
- [ ] **Asaas**: assinatura recorrente; webhook `PAYMENT_CONFIRMED` / `PAYMENT_OVERDUE` / `SUBSCRIPTION_DELETED` → ativa, avisa e suspende a conta. Conta criada automaticamente após o 1º pagamento, chave enviada por e-mail/WhatsApp.
- [ ] **Painel do cliente**: plano e fatura, trocar cartão (link Asaas), conectar QR, envios do dia/mês, respostas e conversões por campanha/modelo, lista de vendedores (se o plano for por equipe).
- [ ] **Painel admin**: contas (ativa/atrasada/cancelada), MRR, instâncias conectadas/caídas, erros recentes por conta, criar/suspender conta, versão da extensão em uso por cliente.
- [ ] 👤 Decidir os planos (por vendedor? limite de envios? Kanban automático só no plano maior?).

## Fase 6 — Landing page

- [ ] Página em `goseller.app.br`: o que faz (vídeos curtos de cada função), planos com botão de compra Asaas, link da loja, FAQ, termos de uso e política de privacidade (**obrigatória para a Chrome Web Store** em versão pública).

## Testes (contínuo)

- [ ] 👤 **Teste humano dos follow-ups automáticos** (sequência do Kanban): roteiro sugerido
  1. coluna de teste com sequência de 3 passos curtos (2 min / 5 min / 10 min), 2 modelos
  2. colocar 2–3 números de teste do time
  3. conferir: chegou na hora, sorteou modelos, **parou quando o lead respondeu**, moveu de coluna, respeitou horário
  4. tirar da coluna e pôr de volta (deve retomar, não recomeçar)
- [ ] Teste de cada tipo de mídia (áudio gravado, vídeo, imagem, PDF) em campanha e em resposta rápida.
- [ ] Testar no Windows e no Mac.

---

## Sugestões extras (avaliar)

- **Atualizar a biblioteca do WhatsApp (WA-JS) com frequência**: o WhatsApp muda toda semana; erro tipo "X is not a function" em só um PC = WhatsApp novo chegou nele antes. Com a loja, a correção chega a todos sozinha.
- **Proteção contra banimento** como diferencial de venda: aquecimento de número novo (limite diário crescente), aviso quando a taxa de resposta cair.
- **Relatório semanal** automático para o gestor (envios, respostas, matrículas por vendedor).
