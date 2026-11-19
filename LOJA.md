# Textos para o cadastro na Chrome Web Store

Copiar e colar cada bloco no campo indicado do Painel de desenvolvedor.

## Aba "Item da loja"

**Descrição** (campo grande):

```
GoSeller organiza o atendimento da sua equipe de vendas no WhatsApp Web.

• Respostas rápidas: textos, áudios, vídeos, imagens e documentos prontos, enviados com um clique ou digitando "/".
• Scripts: várias respostas em sequência, com tempo de espera entre elas.
• Abas de leads: separe as conversas por etapa (Novo lead, Em atendimento, Remarketing...), também a partir das etiquetas do WhatsApp Business.
• Kanban: veja os leads em colunas e arraste entre etapas.
• Sequências automáticas: mensagens de acompanhamento que param sozinhas quando o lead responde.
• Campanhas com ritmo seguro: intervalos, pausas, limite diário e horário comercial, com até 3 modelos de mensagem sorteados.
• Anotações e nome personalizado por contato.
• Backup completo das suas configurações.

Seus dados ficam no seu computador. O envio automático pelo servidor só acontece se você ativar o Kanban automático.

GoSeller não é afiliado ao WhatsApp nem à Meta.
```

**Categoria:** Ferramentas (ou "Produtividade › Comunicação")
**Idioma:** Português (Brasil)

**Imagens:**
- Ícone 128×128: `icons/128.png`
- Capturas de tela: pelo menos 1, em **1280×800** (de preferência 3: respostas rápidas, Kanban, campanha). Usar contatos de teste, sem dados reais de leads.
- Bloco promocional pequeno 440×280: opcional

## Aba "Práticas de privacidade"

**Finalidade única:**
```
Ferramenta de produtividade para equipes de vendas no WhatsApp Web: respostas rápidas, organização de conversas em abas e Kanban, e envio de mensagens de acompanhamento com ritmo controlado.
```

**Justificativa das permissões:**

- **storage:** `Guardar no computador do usuário as respostas rápidas, abas, anotações, campanhas e configurações.`
- **unlimitedStorage:** `As respostas rápidas podem conter áudios, vídeos e documentos, que passam do limite padrão de armazenamento.`
- **alarms:** `Disparar no horário certo os envios das campanhas e sincronizar o Kanban com o servidor a cada minuto.`
- **Permissão de host (web.whatsapp.com):** `A extensão funciona dentro do WhatsApp Web, adicionando a barra de abas, o painel lateral e os botões de resposta rápida.`
- **Permissão de host (*.goseller.app.br):** `Servidor do próprio GoSeller, usado apenas quando o usuário ativa o Kanban automático (sequências de mensagens).`
- **Código remoto:** marcar **"Não, não uso código remoto"** (a biblioteca vai dentro do pacote).

**Uso de dados (marcar):**
- [x] Comunicações pessoais (mensagens das respostas e sequências)
- [x] Informações de identificação pessoal (nome e telefone dos contatos colocados no Kanban automático)
- Marcar as 3 declarações: não vende a terceiros / não usa para fins não relacionados / não usa para crédito.

**URL da política de privacidade:**
```
https://api.goseller.app.br/privacidade
```
(trocar para `https://api.goseller.app.br/privacidade` quando o domínio novo estiver no ar)

## Aba "Distribuição"

- **Visibilidade: Não listado** (só quem tem o link instala)
- Pagamentos: gratuito
- Regiões: todas (ou só Brasil)
